#!/usr/bin/env python3
"""Closed-loop load generator for ONE llama.cpp server instance.

N worker threads each issue /completion requests back-to-back until the stop
condition fires: elapsed >= --min-seconds AND completed >= --min-requests
(hard stop at --max-seconds). On SIGTERM/SIGINT the stop flag is set and
in-flight requests finish (drain) before exit.

Prompt construction: unique random hex prefix (defeats prefix cache) + filler
of ~--prompt-tokens tokens (random words; calibrated 1.42 tokens/word + 34
fixed overhead for this model) + short question.
The ACTUAL token counts are read from the llama.cpp "timings" object in the
non-stream response (prompt_n, prompt_ms, predicted_n, predicted_ms):
  ttft_ms = prompt_ms
  tpot_ms = predicted_ms / max(1, predicted_n)
If "timings" is absent, nulls are logged and the run continues.

Per-request JSONL: {request_id, instance_id, start_ts, end_ts, ttft_ms,
tpot_ms, prompt_tokens, output_tokens, cache_hit: false}
"""
import argparse
import json
import random
import signal
import sys
import threading
import time
import uuid

import requests

_WORDS = ("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu "
          "nu xi omicron pi rho sigma tau upsilon phi chi psi omega system "
          "model energy power sample window token device memory clock "
          "thermal queue worker server metric baseline drift anchor").split()

_stop = threading.Event()
_completed = 0
_completed_lock = threading.Lock()
_out_lock = threading.Lock()


def _handle_signal(signum, frame):
    _stop.set()


def make_prompt(rng, prompt_tokens):
    prefix = uuid.uuid4().hex[:16]  # unique random prefix, defeats prefix cache
    # Calibrated on samantha-mistral-7b 2026-08-21 (10/50/100/500-word probes):
    # prompt_n ~= 1.42 * words + 34 (34 = prefix + question + BOS overhead).
    n_words = max(1, int((prompt_tokens - 34) / 1.42))
    filler = " ".join(rng.choice(_WORDS) for _ in range(n_words))
    return f"{prefix} {filler}\nQuestion: summarize the above in one line.\nAnswer:"


def worker(wid, args, out_f, stats):
    rng = random.Random(args.seed * 1000 + wid)
    sess = requests.Session()
    url = args.endpoint.rstrip("/") + "/completion"
    while not _stop.is_set():
        prompt = make_prompt(rng, args.prompt_tokens)
        body = {
            "prompt": prompt,
            "n_predict": args.output_tokens,
            "temperature": 0.8,
            "top_p": 0.95,
            "cache_prompt": False,
            "stream": False,
        }
        start_ts = time.time()
        end_ts = start_ts
        ttft_ms = tpot_ms = None
        prompt_toks = output_toks = None
        try:
            r = sess.post(url, json=body,
                          timeout=(5, max(60, args.output_tokens * 2)))
            end_ts = time.time()
            r.raise_for_status()
            data = r.json()
            timings = data.get("timings")
            if timings:
                pn = timings.get("prompt_n")
                pm = timings.get("prompt_ms")
                dn = timings.get("predicted_n")
                dm = timings.get("predicted_ms")
                prompt_toks = pn
                output_toks = dn
                ttft_ms = pm
                if dn is not None and dm is not None:
                    tpot_ms = dm / max(1, dn)
        except requests.RequestException as e:
            end_ts = time.time()
            print(f"loadgen[{args.instance_id}]: request error: {e}",
                  file=sys.stderr)
            time.sleep(0.5)  # brief backoff before retrying

        rec = {
            "request_id": f"{args.instance_id}-{wid}-{uuid.uuid4().hex[:8]}",
            "instance_id": args.instance_id,
            "start_ts": start_ts,
            "end_ts": end_ts,
            "ttft_ms": ttft_ms,
            "tpot_ms": tpot_ms,
            "prompt_tokens": prompt_toks,
            "output_tokens": output_toks,
            "cache_hit": False,
        }
        with _out_lock:
            out_f.write(json.dumps(rec) + "\n")
        with _completed_lock:
            global _completed
            _completed += 1
        if output_toks:
            dt = max(1e-6, end_ts - start_ts)
            stats.append(output_toks / dt)


def main():
    ap = argparse.ArgumentParser(description="Closed-loop llama.cpp load generator")
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--instance-id", required=True)
    ap.add_argument("--concurrency", type=int, required=True)
    ap.add_argument("--prompt-tokens", type=int, required=True)
    ap.add_argument("--output-tokens", type=int, required=True)
    ap.add_argument("--min-requests", type=int, required=True)
    ap.add_argument("--min-seconds", type=float, required=True)
    ap.add_argument("--max-seconds", type=float, required=True)
    ap.add_argument("--out", required=True, help="per-request JSONL output path")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    stats = []  # per-request output tok/s, for the exit summary
    t0 = time.time()
    with open(args.out, "a", buffering=1) as out_f:
        threads = [
            threading.Thread(target=worker, args=(i, args, out_f, stats),
                             daemon=True)
            for i in range(args.concurrency)
        ]
        for t in threads:
            t.start()
        # Stop-condition supervisor: workers just run until _stop is set.
        while True:
            time.sleep(0.25)
            elapsed = time.time() - t0
            with _completed_lock:
                done = _completed
            if elapsed >= args.max_seconds:
                print(f"loadgen[{args.instance_id}]: hard stop at "
                      f"{elapsed:.1f}s", file=sys.stderr)
                break
            if elapsed >= args.min_seconds and done >= args.min_requests:
                break
        _stop.set()
        # Drain: wait for in-flight requests to finish.
        for t in threads:
            t.join()

    elapsed = time.time() - t0
    mean_tps = sum(stats) / len(stats) if stats else 0.0
    print(f"loadgen[{args.instance_id}]: completed={_completed} "
          f"elapsed={elapsed:.1f}s mean_output_tok_s_per_worker={mean_tps:.2f}")


if __name__ == "__main__":
    main()
