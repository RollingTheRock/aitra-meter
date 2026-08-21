# GB10 attribution analysis report

## L0 baseline model

- rounds prefix: `L0`, windows used: 34 (holdout 7, seed 0)
- **holdout MAPE: 0.84%** (pass criterion: <= 10%)
- coefficients: `{"b0": -275.93612702161374, "prompt_tok_s": 0.012129924528736897, "predicted_tok_s": 0.003064714570403209, "proc_sm_pct": 0.1596488841523051, "sm_clock_mhz": 0.1028549383668907, "temp_c": 0.6789420922310243}`
- saved to `results/20260821/l0_baseline.json`

### J/token per round

| round | J/token |
|---|---|
| L0_c16_A | 0.0276 |
| L0_c16_B | 0.1260 |
| L0_c16_M | 0.0537 |
| L0_c16_M_anchor | 0.0584 |
| L0_c2_A | 0.0320 |
| L0_c2_B | 0.7906 |
| L0_c2_M | 0.2942 |
| L0_c4_A | 0.0316 |
| L0_c4_B | 0.7678 |
| L0_c4_M | 0.2678 |
| L0_c4_M_anchor | 0.3011 |
| L0_c8_A | 0.0305 |
| L0_c8_B | 0.5411 |
| L0_c8_M | 0.1657 |
| L0_c8_M_anchor | 0.1865 |

### Anchor drift (re-run vs first pass)

| anchor round | drift % |
|---|---|
| L0_c16_M_anchor | +8.79 |
| L0_c4_M_anchor | +12.42 |
| L0_c8_M_anchor | +12.58 |

**L0 verdict: FAIL** (criterion: holdout MAPE <= 10% and anchor drift <= 10%)



## L1 attribution-rule comparison

### Absolute error vs full L0 expectation (common-mode biased)

Expected energy per instance includes the full baseline prediction (static terms counted once per instance), so all rules share a uniform negative bias — kept for reference only.

| round | rule | mean error % | MAPE % |
|---|---|---|---|
| L1_1to1_c44_A | token_prop | -35.50 | 35.50 |
| L1_1to1_c44_A | sm_prop | -35.50 | 35.50 |
| L1_1to1_c44_A | split | -35.50 | 35.50 |
| L1_1to1_c44_B | token_prop | -46.09 | 49.25 |
| L1_1to1_c44_B | sm_prop | -46.17 | 46.17 |
| L1_1to1_c44_B | split | -54.32 | 54.32 |
| L1_1to1_c44_M | token_prop | -46.52 | 47.04 |
| L1_1to1_c44_M | sm_prop | -46.50 | 46.50 |
| L1_1to1_c44_M | split | -48.94 | 48.94 |
| L1_1to1_c88_M | token_prop | -42.34 | 42.34 |
| L1_1to1_c88_M | sm_prop | -42.19 | 42.19 |
| L1_1to1_c88_M | split | -42.17 | 42.17 |
| L1_3to1_c62_M | token_prop | -44.44 | 44.44 |
| L1_3to1_c62_M | sm_prop | -44.36 | 44.36 |
| L1_3to1_c62_M | split | -44.35 | 44.35 |
| L1_busyidle_c80_M | token_prop | -49.92 | 50.40 |
| L1_busyidle_c80_M | sm_prop | -49.92 | 50.40 |
| L1_busyidle_c80_M | split | -49.92 | 50.40 |

### Static-free share comparison (percentage points)

exp_share_i = dyn_i / (dyn_a + dyn_b) with dyn = load terms of the baseline only (b0, sm_clock, temp terms excluded). Signed error = attr_share - exp_share per instance;
mean |error| pools both instances.

| round | rule | a: mean signed pp | b: mean signed pp | mean |err| pp |
|---|---|---|---|---|
| L1_1to1_c44_A | token_prop | +0.31 | -0.31 | 0.81 |
| L1_1to1_c44_A | sm_prop | -0.45 | +0.45 | 1.30 |
| L1_1to1_c44_A | split | -0.48 | +0.48 | 1.09 |
| L1_1to1_c44_B | token_prop | +3.30 | -3.30 | 30.59 |
| L1_1to1_c44_B | sm_prop | -0.08 | +0.08 | 0.22 |
| L1_1to1_c44_B | split | -8.23 | -6.88 | 12.77 |
| L1_1to1_c44_M | token_prop | -4.78 | +4.78 | 20.07 |
| L1_1to1_c44_M | sm_prop | +0.14 | -0.14 | 1.63 |
| L1_1to1_c44_M | split | -5.24 | +0.80 | 4.04 |
| L1_1to1_c88_M | token_prop | +3.00 | -3.00 | 13.23 |
| L1_1to1_c88_M | sm_prop | +0.48 | -0.48 | 1.49 |
| L1_1to1_c88_M | split | +0.07 | -0.07 | 1.32 |
| L1_3to1_c62_M | token_prop | +4.29 | -4.29 | 7.90 |
| L1_3to1_c62_M | sm_prop | -0.48 | +0.48 | 0.78 |
| L1_3to1_c62_M | split | -0.94 | +0.94 | 0.95 |
| L1_busyidle_c80_M | token_prop | +0.00 | +0.00 | 0.00 |
| L1_busyidle_c80_M | sm_prop | +0.00 | +0.00 | 0.00 |
| L1_busyidle_c80_M | split | +0.00 | +0.00 | 0.00 |

### Common-mode bias per round

bias% = (sum of full expected energies - measured dE) / dE; quantifies static double-count + co-location interference per cell.

| round | windows | mean bias % |
|---|---|---|
| L1_1to1_c44_A | 2 | +55.12 |
| L1_1to1_c44_B | 10 | +85.73 |
| L1_1to1_c44_M | 8 | +86.76 |
| L1_1to1_c88_M | 5 | +72.93 |
| L1_3to1_c62_M | 8 | +79.70 |
| L1_busyidle_c80_M | 2 | +64.62 |

### Verdict (share-level)

A rule passes if mean |share error| <= 5 percentage points in BOTH the 1:1 and 3:1 cells. Note: 1:1 cells cannot discriminate rules (all rules agree at equal shares) — the 3:1 cell L1_3to1_c62_M is the discriminating test.

| rule | 1:1 mean |err| pp | 3:1 mean |err| pp | verdict |
|---|---|---|---|
| token_prop | 21.37 | 7.90 | FAIL |
| sm_prop | 1.01 | 0.78 | PASS |
| split | 6.75 | 0.95 | FAIL |

**L1 verdict: PASS — winning rule(s): sm_prop**

## L2a residency tax & interference

Residency marks `L2_residency_start` / `L2_residency_end` not found in events.jsonl — residency window not measured; run that phase and re-run `l2a`.

### Interference tax (J/token, busy:idle vs alone)

| round | J/token (instance a) |
|---|---|
| L1_busyidle_c80_M (busy:idle, shared) | 0.1802 |
| L0_c8_M (alone) | 0.1657 |

- interference tax on throughput-adjusted energy: **+8.8%**

## L2a residency tax & interference

Residency marks `L2_residency_start` / `L2_residency_end` not found in events.jsonl — residency window not measured; run that phase and re-run `l2a`.

### Interference tax (J/token, busy:idle vs alone)

| round | J/token (instance a) |
|---|---|
| L1_busyidle_c80_M (busy:idle, shared) | 0.1802 |
| L0_c8_M (alone) | 0.1657 |

- interference tax on throughput-adjusted energy: **+8.8%**

## L2a residency tax & interference

### Residency tax (both instances resident, zero traffic)

- window: 300s between marks `L2_residency_start` / `L2_residency_end` (300 samples)
- resident-idle power: **13.11 W**
- baseline idle power (idle_power_w.json): **11.03 W**
- delta: **+2.08 W (+18.9%)**
- residency tax per instance (delta / 2): **+1.04 W**

### Interference tax (J/token, busy:idle vs alone)

| round | J/token (instance a) |
|---|---|
| L1_busyidle_c80_M (busy:idle, shared) | 0.1802 |
| L0_c8_M (alone) | 0.1657 |

- interference tax on throughput-adjusted energy: **+8.8%**
