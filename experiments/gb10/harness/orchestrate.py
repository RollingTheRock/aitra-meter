#!/usr/bin/env python3
"""Phase runner for the GB10 attribution experiment.

The NVML sampler runs as a separate long-lived process (started by the user);
this script only writes event markers to events.jsonl and drives loadgen
subprocesses.

Subcommands:
  mark      --label STR [--meta JSON]
  baseline  --seconds N            (idle power reference for the cooldown gate)
  round     --label STR --shape A|M|B --workers "a:4" [--workers "b:8"]
            [--min-seconds S] [--max-seconds M] [--min-requests K]  (test escape hatch)

Round flow: mark round_start -> spawn one loadgen.py per instance:concurrency
pair -> wait (they self-stop and drain in-flight) -> cooldown: poll NVML power
every 2s until power <= idle+5W or 120s elapse -> mark round_end with
{label, cooldown_s}.

Instances: a=http://127.0.0.1:18080, b=http://127.0.0.1:18081.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import pynvml
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.abspath(os.path.join(HERE, "..", "results", "20260821"))
EVENTS = os.path.join(RESULTS, "events.jsonl")
IDLE_JSON = os.path.join(RESULTS, "idle_power_w.json")
SPEC = os.path.abspath(os.path.join(HERE, "..", "queue-attribution.yaml"))
LOADGEN = os.path.join(HERE, "loadgen.py")

ENDPOINTS = {"a": "http://127.0.0.1:18080", "b": "http://127.0.0.1:18081"}

# Defaults from spec meta.adaptive_round; CLI flags can override for smoke tests.
DEFAULT_MIN_SECONDS = 120
DEFAULT_MAX_SECONDS = 300
DEFAULT_MIN_REQUESTS = 30
COOLDOWN_GATE_W = 5.0      # proceed once power <= idle + 5W (spec meta.cooldown)
COOLDOWN_MAX_S = 120.0


def append_event(rec):
    rec = dict(rec, ts=time.time())
    with open(EVENTS, "a", buffering=1) as f:
        f.write(json.dumps(rec) + "\n")


def use_results_dir(path):
    """Redirect all outputs (events, idle ref, request logs) to path."""
    global RESULTS, EVENTS, IDLE_JSON
    RESULTS = os.path.abspath(path)
    EVENTS = os.path.join(RESULTS, "events.jsonl")
    IDLE_JSON = os.path.join(RESULTS, "idle_power_w.json")
    os.makedirs(RESULTS, exist_ok=True)


def load_shapes():
    with open(SPEC) as f:
        spec = yaml.safe_load(f)
    return {k: {"prompt_tokens": v["prompt_tokens"],
                "output_tokens": v["output_tokens"]}
            for k, v in spec["meta"]["shapes"].items()}


def nvml_power_w(handle):
    return pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0


def cmd_mark(args):
    meta = json.loads(args.meta) if args.meta else None
    append_event({"event": "mark", "label": args.label, "meta": meta})
    print(f"marked: {args.label}")


def cmd_baseline(args):
    """Sample idle power at 1 Hz, write idle_power_w.json (cooldown gate ref)."""
    pynvml.nvmlInit()
    handle = pynvml.nvmlDeviceGetHandleByIndex(0)
    samples = []
    t0 = time.time()
    while time.time() - t0 < args.seconds:
        try:
            samples.append(nvml_power_w(handle))
        except pynvml.NVMLError as e:
            print(f"baseline: transient NVML error: {e}", file=sys.stderr)
        time.sleep(1.0)
    pynvml.nvmlShutdown()
    if not samples:
        sys.exit("baseline: no samples collected")
    mean = sum(samples) / len(samples)
    var = sum((x - mean) ** 2 for x in samples) / max(1, len(samples) - 1)
    out = {"idle_power_w": mean, "std": var ** 0.5, "n": len(samples)}
    with open(IDLE_JSON, "w") as f:
        json.dump(out, f, indent=2)
    print(f"idle_power_w={mean:.2f} std={out['std']:.2f} n={len(samples)} -> {IDLE_JSON}")


def cooldown(handle, idle_w):
    """Poll power every 2s until <= idle + gate, or COOLDOWN_MAX_S elapse."""
    t0 = time.time()
    while True:
        try:
            p = nvml_power_w(handle)
        except pynvml.NVMLError as e:
            print(f"cooldown: transient NVML error: {e}", file=sys.stderr)
            p = float("inf")
        elapsed = time.time() - t0
        if p <= idle_w + COOLDOWN_GATE_W:
            print(f"cooldown: gate reached ({p:.1f}W <= {idle_w:.1f}+"
                  f"{COOLDOWN_GATE_W:.0f}W) after {elapsed:.1f}s")
            return elapsed
        if elapsed >= COOLDOWN_MAX_S:
            print(f"cooldown: timeout after {elapsed:.1f}s (power {p:.1f}W, "
                  f"gate {idle_w + COOLDOWN_GATE_W:.1f}W)")
            return elapsed
        time.sleep(2.0)


def parse_workers(pairs):
    """Parse repeated --workers 'a:4' into {instance_id: concurrency}."""
    out = {}
    for w in pairs:
        inst, _, conc = w.partition(":")
        if inst not in ENDPOINTS or not conc.isdigit():
            sys.exit(f"bad --workers value: {w!r} (expected e.g. 'a:4')")
        out[inst] = int(conc)
    return out


def cmd_round(args):
    shapes = load_shapes()
    if args.shape not in shapes:
        sys.exit(f"unknown shape {args.shape!r}; have {sorted(shapes)}")
    shape = shapes[args.shape]
    workers = parse_workers(args.workers)

    min_seconds = args.min_seconds if args.min_seconds is not None else DEFAULT_MIN_SECONDS
    max_seconds = args.max_seconds if args.max_seconds is not None else DEFAULT_MAX_SECONDS
    min_requests = args.min_requests if args.min_requests is not None else DEFAULT_MIN_REQUESTS

    if not os.path.exists(IDLE_JSON):
        sys.exit(f"missing {IDLE_JSON}; run 'baseline' first")
    with open(IDLE_JSON) as f:
        idle_w = json.load(f)["idle_power_w"]

    append_event({"event": "mark", "label": "round_start",
                  "meta": {"label": args.label, "shape": args.shape,
                           "workers": workers}})

    procs = []
    for inst, conc in workers.items():
        cmd = [
            sys.executable, LOADGEN,
            "--endpoint", ENDPOINTS[inst],
            "--instance-id", inst,
            "--concurrency", str(conc),
            "--prompt-tokens", str(shape["prompt_tokens"]),
            "--output-tokens", str(shape["output_tokens"]),
            "--min-requests", str(min_requests),
            "--min-seconds", str(min_seconds),
            "--max-seconds", str(max_seconds),
            "--seed", "0",
            "--out", os.path.join(RESULTS, f"requests_{args.label}_{inst}.jsonl"),
        ]
        print(f"round {args.label}: spawning {inst} c{conc}: {' '.join(cmd)}")
        procs.append((inst, subprocess.Popen(cmd)))

    rc = {}
    for inst, p in procs:
        rc[inst] = p.wait()  # loadgens self-stop and drain in-flight
        if rc[inst] != 0:
            print(f"round {args.label}: loadgen {inst} exited rc={rc[inst]}",
                  file=sys.stderr)

    # Cooldown gate against idle reference.
    pynvml.nvmlInit()
    handle = pynvml.nvmlDeviceGetHandleByIndex(0)
    cooldown_s = cooldown(handle, idle_w)
    pynvml.nvmlShutdown()

    append_event({"event": "mark", "label": "round_end",
                  "meta": {"label": args.label, "cooldown_s": cooldown_s,
                           "loadgen_rc": rc}})
    print(f"round {args.label}: done, cooldown_s={cooldown_s:.1f}")


def main():
    ap = argparse.ArgumentParser(description="GB10 experiment phase runner")
    ap.add_argument("--results", default=RESULTS,
                    help="results dir for events/idle/request logs "
                         "(default ../results/20260821; use the smoke/ "
                         "subdir for tests)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("mark")
    p.add_argument("--label", required=True)
    p.add_argument("--meta", default=None, help="JSON string")
    p.set_defaults(fn=cmd_mark)

    p = sub.add_parser("baseline")
    p.add_argument("--seconds", type=float, required=True)
    p.set_defaults(fn=cmd_baseline)

    p = sub.add_parser("round")
    p.add_argument("--label", required=True)
    p.add_argument("--shape", required=True, choices=["A", "M", "B"])
    p.add_argument("--workers", action="append", required=True,
                   help="instance:concurrency, e.g. --workers a:4 --workers b:8")
    # Escape hatch for smoke testing; defaults come from spec meta.adaptive_round.
    p.add_argument("--min-seconds", type=float, default=None)
    p.add_argument("--max-seconds", type=float, default=None)
    p.add_argument("--min-requests", type=int, default=None)
    p.set_defaults(fn=cmd_round)

    args = ap.parse_args()
    use_results_dir(args.results)
    args.fn(args)


if __name__ == "__main__":
    main()
