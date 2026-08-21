#!/usr/bin/env python3
"""Decay pre-run analysis: how fast do power/temp/clock relax after load?

Reads sampler.jsonl + events.jsonl, reports:
  - idle baseline (mean/std) during the pre-load idle segment
  - seconds from P_decay_start until power <= idle+5W and <= idle+2W (sustained 5 samples)
  - whether temp / sm_clock track the power residual during decay
"""
import json, sys

def load_jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]

def main(results_dir):
    samples = load_jsonl(f"{results_dir}/sampler.jsonl")
    events = load_jsonl(f"{results_dir}/events.jsonl")
    marks = {e["label"]: e["ts"] for e in events if e.get("event") == "mark"}

    t_idle_end = marks.get("P_idle_done")
    t_decay0 = marks.get("P_decay_start")
    t_decay1 = marks.get("P_decay_end")
    if not all([t_idle_end, t_decay0, t_decay1]):
        sys.exit(f"missing marks, have: {sorted(marks)}")

    idle = [s["power_w"] for s in samples if s["ts"] < t_idle_end]
    idle = idle[len(idle)//4:]  # skip settle-in
    idle_w = sum(idle)/len(idle)
    idle_std = (sum((p-idle_w)**2 for p in idle)/len(idle))**0.5
    print(f"idle: {idle_w:.2f} W +/- {idle_std:.2f}  (n={len(idle)})")

    decay = [s for s in samples if t_decay0 <= s["ts"] <= t_decay1]
    if not decay:
        sys.exit("no decay samples")
    peak = max(s["power_w"] for s in decay[:10])
    print(f"power at decay start: {decay[0]['power_w']:.1f} W (early-peak {peak:.1f} W)")

    for gate in (5.0, 2.0):
        hit = None
        streak = 0
        for s in decay:
            if s["power_w"] <= idle_w + gate:
                streak += 1
                if streak >= 5:
                    hit = s["ts"] - 4 - t_decay0
                    break
            else:
                streak = 0
        print(f"time to idle+{gate:.0f}W (sustained 5s): "
              + (f"{hit:.0f} s" if hit is not None else f"> {decay[-1]['ts']-t_decay0:.0f} s (never)"))

    # do temp / sm_clock track the power residual?
    n = len(decay)
    if n > 30:
        pw = [s["power_w"] - idle_w for s in decay]
        tp = [s["temp_c"] for s in decay]
        ck = [s["sm_clock_mhz"] for s in decay]
        def corr(a, b):
            ma, mb = sum(a)/n, sum(b)/n
            num = sum((x-ma)*(y-mb) for x, y in zip(a, b))
            den = (sum((x-ma)**2 for x in a) * sum((y-mb)**2 for y in b)) ** 0.5
            return num/den if den else float("nan")
        print(f"corr(power_residual, temp)     = {corr(pw, tp):+.2f}")
        print(f"corr(power_residual, sm_clock) = {corr(pw, ck):+.2f}")
        print(f"temp: {tp[0]:.0f} -> {tp[-1]:.0f} C,  clock: {ck[0]} -> {ck[-1]} MHz")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "results/20260821")
