# GB10 attribution harness

Lean Python harness for the GPU energy-attribution experiment on a single
NVIDIA GB10. See `../queue-attribution.yaml` for the experiment spec.

## Layout

- `sampler.py` — NVML sampler; runs until SIGTERM, appends one JSON line per
  sample (`ts, power_w, energy_mj, sm_dev, mem_dev, sm_clock_mhz, temp_c,
  procs:[{pid,sm,mem}]`) to `--out`. `--hz` default 1. Tolerates transient
  NVML errors.
- `loadgen.py` — closed-loop load generator for ONE llama.cpp instance.
  Stops when `elapsed >= --min-seconds AND completed >= --min-requests`
  (hard stop `--max-seconds`); SIGTERM drains in-flight requests. Logs actual
  token counts and timings (`ttft_ms = prompt_ms`,
  `tpot_ms = predicted_ms/predicted_n`) from the llama.cpp `timings` object.
- `orchestrate.py` — phase runner: `mark`, `baseline` (idle power reference),
  `round` (spawn loadgens, wait, cooldown gate `power <= idle+5W` / 120s).
  Escape hatch for tests: `--min-seconds/--max-seconds/--min-requests`.
- `analyze.py` — offline analysis: `l0` (baseline power model via lstsq,
  80/20 holdout seed 0, anchor drift, J/token) and `l1` (token_prop /
  sm_prop / split attribution vs L0 expectation). Writes `report.md`.

## Usage

```sh
PY=../.venv/bin/python
R=../results/20260821

# long-lived sampler (separate terminal / tmux)
$PY sampler.py --out $R/sampler.jsonl --hz 1

# idle reference (once per session)
$PY orchestrate.py baseline --seconds 300

# one L0 round
$PY orchestrate.py round --label L0_c4_M --shape M --workers a:4

# analysis (after instance_pids.json is written)
$PY analyze.py l0
$PY analyze.py l1
```

Instance endpoints: `a=http://127.0.0.1:18080`, `b=http://127.0.0.1:18081`.
Request logs land in `requests_<label>_<inst>.jsonl`, events in `events.jsonl`.
Smoke-test artifacts go under `results/20260821/smoke/`.
