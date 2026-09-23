#!/usr/bin/env python3
"""NVML sampler for the GB10 attribution experiment.

Runs forever until SIGTERM/SIGINT, appending one JSON line per sample to --out.
Sample schema:
  {ts, power_w, energy_mj, sm_dev, mem_dev, sm_clock_mhz, temp_c,
   procs: [{pid, sm, mem}]}

energy_mj is the cumulative NVML energy counter (deltas give Joules/1000).
Transient NVML errors are tolerated: the sample is skipped, not fatal.
"""
import argparse
import json
import signal
import sys
import time

import pynvml

_running = True


def _handle_signal(signum, frame):
    global _running
    _running = False


def sample_once(handle):
    """Collect one sample. Raises on NVML error (caller decides)."""
    util = pynvml.nvmlDeviceGetUtilizationRates(handle)
    procs = []
    try:
        for p in pynvml.nvmlDeviceGetProcessUtilization(handle, 0):
            procs.append({"pid": p.pid, "sm": p.smUtil, "mem": p.memUtil})
    except pynvml.NVMLError:
        # Per-process utilization can fail transiently; keep the rest.
        procs = []
    return {
        "ts": time.time(),
        "power_w": pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0,
        "energy_mj": pynvml.nvmlDeviceGetTotalEnergyConsumption(handle),
        "sm_dev": util.gpu,
        "mem_dev": util.memory,
        "sm_clock_mhz": pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_SM),
        "temp_c": pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU),
        "procs": procs,
    }


def main():
    ap = argparse.ArgumentParser(description="NVML JSONL sampler (runs until SIGTERM)")
    ap.add_argument("--out", required=True, help="output JSONL path (appended)")
    ap.add_argument("--hz", type=float, default=1.0, help="samples per second (default 1)")
    ap.add_argument("--gpu", type=int, default=0, help="GPU index (default 0)")
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    pynvml.nvmlInit()
    handle = pynvml.nvmlDeviceGetHandleByIndex(args.gpu)
    period = 1.0 / args.hz

    with open(args.out, "a", buffering=1) as f:  # line-buffered
        next_t = time.time()
        while _running:
            t0 = time.time()
            try:
                rec = sample_once(handle)
                f.write(json.dumps(rec) + "\n")  # flushed by line buffering
            except pynvml.NVMLError as e:
                print(f"sampler: transient NVML error, skipping sample: {e}",
                      file=sys.stderr)
            next_t += period
            sleep = next_t - time.time()
            if sleep > 0:
                # Sleep in small slices so SIGTERM stops us promptly.
                deadline = time.time() + sleep
                while _running and time.time() < deadline:
                    time.sleep(min(0.1, deadline - time.time()))
            else:
                # Fell behind (slow NVML call); resync the schedule.
                next_t = time.time()
                _ = t0

    pynvml.nvmlShutdown()
    print("sampler: stopped cleanly", file=sys.stderr)


if __name__ == "__main__":
    main()
