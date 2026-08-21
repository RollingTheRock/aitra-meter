#!/usr/bin/env python3
"""Offline analysis for the GB10 attribution experiment (run after experiments).

Subcommands:
  l0 [--round-prefix L0]   fit baseline power model, anchor drift, J/token
  l1 [--round-prefix L1]   compare attribution rules against L0 expectation
                           (absolute + static-free share-level comparison)
  l2a                      residency tax (L2_residency_start/end marks) and
                           busy:idle vs alone J/token interference tax

Inputs (all under --results, default ../results/20260821 relative to this file):
  sampler JSONL          (--sampler, default <results>/sampler.jsonl)
  events.jsonl           (round_start / round_end marks from orchestrate.py)
  requests_*.jsonl       (per-request logs; instance_id field used)
  instance_pids.json     {"a": [pids...], "b": [...]}  (may contain only "a")
  idle_power_w.json      (cooldown gate reference; static power for split rule)

Windowing: 30s windows aligned to round_start; first window discarded and last
window trimmed per round (spec meta.window_seconds / discard / trim_tail).
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.abspath(os.path.join(HERE, "..", "results", "20260821"))
WINDOW_S = 30.0
DISCARD_FIRST = 1
TRIM_TAIL = 1

FEATURES = ["prompt_tok_s", "predicted_tok_s", "proc_sm_pct",
            "sm_clock_mhz", "temp_c"]


# ---------------------------------------------------------------- loading ---
def load_jsonl(path):
    recs = []
    if not os.path.exists(path):
        return recs
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    recs.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # tolerate a torn final line
    return recs


def load_rounds(results):
    """Pair round_start/round_end events by meta.label -> {label: (t0, t1)}."""
    starts, rounds = {}, {}
    for e in load_jsonl(os.path.join(results, "events.jsonl")):
        if e.get("event") != "mark" or not isinstance(e.get("meta"), dict):
            continue
        label = e["meta"].get("label")
        if not label:
            continue
        if e["label"] == "round_start":
            starts[label] = e["ts"]
        elif e["label"] == "round_end" and label in starts:
            rounds[label] = (starts[label], e["ts"])
    return rounds


def load_requests(results):
    """All request records from requests_*.jsonl, list of dicts."""
    recs = []
    for path in sorted(glob.glob(os.path.join(results, "requests_*.jsonl"))):
        recs.extend(load_jsonl(path))
    return recs


# ------------------------------------------------------------- windowing ----
def windowize(label, t0, t1, samples, requests, inst_pids):
    """Cut [t0, t1] into 30s windows aligned to t0; discard first, trim last."""
    n_win = int((t1 - t0) // WINDOW_S)
    windows = []
    for k in range(n_win):
        w0, w1 = t0 + k * WINDOW_S, t0 + (k + 1) * WINDOW_S
        s = [x for x in samples if w0 <= x["ts"] < w1]
        if not s:
            continue
        # Energy delta across the window; guard against counter reset.
        dE = (s[-1]["energy_mj"] - s[0]["energy_mj"]) / 1000.0
        if dE < 0:
            continue
        w = {
            "label": label, "k": k, "t0": w0, "t1": w1,
            "dE_joules": dE,
            "power_w": float(np.mean([x["power_w"] for x in s])),
            "sm_clock_mhz": float(np.mean([x["sm_clock_mhz"] for x in s])),
            "temp_c": float(np.mean([x["temp_c"] for x in s])),
        }
        # Per-instance mean per-process SM util (sum of the instance's pids).
        for inst, pids in inst_pids.items():
            vals = []
            for x in s:
                vals.append(sum(p["sm"] for p in x.get("procs", [])
                                if p["pid"] in pids))
            w[f"sm_{inst}"] = float(np.mean(vals)) if vals else 0.0
            pt = sum(r["prompt_tokens"] or 0 for r in requests
                     if r["instance_id"] == inst and w0 <= r["end_ts"] < w1)
            dt = sum(r["output_tokens"] or 0 for r in requests
                     if r["instance_id"] == inst and w0 <= r["end_ts"] < w1)
            w[f"prompt_tok_{inst}"] = pt
            w[f"predicted_tok_{inst}"] = dt
        windows.append(w)
    return windows[DISCARD_FIRST:len(windows) - TRIM_TAIL]


def all_windows(rounds, samples, requests, inst_pids, prefix):
    out = []
    for label in sorted(rounds):
        if not label.startswith(prefix):
            continue
        t0, t1 = rounds[label]
        out.extend(windowize(label, t0, t1, samples, requests, inst_pids))
    return out


# ------------------------------------------------------------------- L0 -----
def design_matrix(windows, inst):
    X, y = [], []
    for w in windows:
        if w.get(f"prompt_tok_{inst}") is None:
            continue
        X.append([
            w[f"prompt_tok_{inst}"] / WINDOW_S,
            w[f"predicted_tok_{inst}"] / WINDOW_S,
            w[f"sm_{inst}"],
            w["sm_clock_mhz"],
            w["temp_c"],
        ])
        y.append(w["power_w"])
    return np.array(X), np.array(y)


def predict_power(coef, feats):
    """coef = [b0, b1..b5]; feats = dict of the 5 features."""
    return coef[0] + sum(c * feats[f] for c, f in zip(coef[1:], FEATURES))


def cmd_l0(args, samples, requests, inst_pids, rounds):
    windows = all_windows(rounds, samples, requests, inst_pids,
                          args.round_prefix)
    inst = args.instance
    if inst not in inst_pids:
        sys.exit(f"instance {inst!r} not in instance_pids.json")
    non_anchor = [w for w in windows if not w["label"].endswith("_anchor")]
    if len(non_anchor) < 10:
        print(f"warning: only {len(non_anchor)} non-anchor windows",
              file=sys.stderr)

    X, y = design_matrix(non_anchor, inst)
    if len(y) == 0:
        sys.exit("no L0 windows; check --round-prefix and input files")

    # 80/20 random holdout, seed 0.
    rng = np.random.RandomState(0)
    idx = rng.permutation(len(y))
    n_test = max(1, int(round(0.2 * len(y))))
    test_i, train_i = idx[:n_test], idx[n_test:]
    A = np.column_stack([np.ones(len(train_i)), X[train_i]])
    coef, *_ = np.linalg.lstsq(A, y[train_i], rcond=None)
    pred = np.column_stack([np.ones(n_test), X[test_i]]) @ coef
    mape = float(np.mean(np.abs((pred - y[test_i]) / y[test_i])) * 100)

    # Refit on all non-anchor windows for the saved model.
    A_full = np.column_stack([np.ones(len(y)), X])
    coef_full, *_ = np.linalg.lstsq(A_full, y, rcond=None)
    model = {
        "features": FEATURES,
        "coefficients": dict(zip(["b0"] + FEATURES, coef_full.tolist())),
        "holdout_mape_pct": mape,
        "n_windows": len(y), "n_holdout": n_test,
        "window_seconds": WINDOW_S,
    }
    model_path = os.path.join(args.results, "l0_baseline.json")
    with open(model_path, "w") as f:
        json.dump(model, f, indent=2)

    # J/token per round; anchor drift vs first-pass counterparts.
    per_round = {}
    for w in windows:
        r = per_round.setdefault(w["label"], {"dE": 0.0, "tok": 0})
        r["dE"] += w["dE_joules"]
        r["tok"] += w[f"prompt_tok_{inst}"] + w[f"predicted_tok_{inst}"]
    jpt = {l: (r["dE"] / r["tok"] if r["tok"] else None)
           for l, r in per_round.items()}
    drift = {}
    for l in jpt:
        if l.endswith("_anchor"):
            base = l[: -len("_anchor")]
            if base in jpt and jpt[base] and jpt[l]:
                drift[l] = (jpt[l] - jpt[base]) / jpt[base] * 100.0

    lines = [
        "# GB10 attribution analysis report", "",
        "## L0 baseline model", "",
        f"- rounds prefix: `{args.round_prefix}`, windows used: {len(y)} "
        f"(holdout {n_test}, seed 0)",
        f"- **holdout MAPE: {mape:.2f}%** (pass criterion: <= 10%)",
        f"- coefficients: `{json.dumps(model['coefficients'])}`",
        f"- saved to `{model_path}`", "",
        "### J/token per round", "",
        "| round | J/token |", "|---|---|",
    ]
    for l in sorted(jpt):
        v = jpt[l]
        lines.append(f"| {l} | {v:.4f} |" if v is not None else f"| {l} | n/a |")
    lines += ["", "### Anchor drift (re-run vs first pass)", "",
              "| anchor round | drift % |", "|---|---|"]
    for l in sorted(drift):
        lines.append(f"| {l} | {drift[l]:+.2f} |")
    ok = mape <= 10.0 and all(abs(d) <= 10.0 for d in drift.values())
    lines += ["",
              f"**L0 verdict: {'PASS' if ok else 'FAIL'}** "
              f"(criterion: holdout MAPE <= 10% and anchor drift <= 10%)", ""]
    with open(os.path.join(args.results, "report.md"), "w") as f:
        f.write("\n".join(lines))
    print("\n".join(lines[:12]))


# ------------------------------------------------------------------- L1 -----
def attribute(w, insts, idle_w, coef):
    """Three attributions of window dE per instance + L0-expected energy."""
    dE = w["dE_joules"]
    toks = {i: w[f"prompt_tok_{i}"] + w[f"predicted_tok_{i}"] for i in insts}
    sms = {i: w[f"sm_{i}"] for i in insts}
    active = [i for i in insts if toks[i] > 0] or list(insts)
    tok_total = sum(toks.values())
    sm_total = sum(sms.values())
    static = idle_w * WINDOW_S
    res = {}
    for i in insts:
        token_prop = dE * toks[i] / tok_total if tok_total > 0 else dE / len(insts)
        sm_prop = dE * sms[i] / sm_total if sm_total > 0 else dE / len(insts)
        dyn = max(0.0, dE - static)
        share = sms[i] / sm_total if sm_total > 0 else 1.0 / len(active)
        split = static / len(active) + dyn * share if i in active else 0.0
        feats = {
            "prompt_tok_s": w[f"prompt_tok_{i}"] / WINDOW_S,
            "predicted_tok_s": w[f"predicted_tok_{i}"] / WINDOW_S,
            "proc_sm_pct": w[f"sm_{i}"],
            "sm_clock_mhz": w["sm_clock_mhz"],
            "temp_c": w["temp_c"],
        }
        res[i] = {"token_prop": token_prop, "sm_prop": sm_prop, "split": split,
                  "expected": predict_power(coef, feats) * WINDOW_S}
    return res


def attr_shares(w, insts, idle_w):
    """Per-rule attribution SHARES of window dE (each rule's shares sum to 1).

    Same definitions as attribute(), normalized by dE.
    """
    toks = {i: w[f"prompt_tok_{i}"] + w[f"predicted_tok_{i}"] for i in insts}
    sms = {i: w[f"sm_{i}"] for i in insts}
    active = [i for i in insts if toks[i] > 0] or list(insts)
    tok_total = sum(toks.values())
    sm_total = sum(sms.values())
    dE = w["dE_joules"]
    static = idle_w * WINDOW_S
    dyn = max(0.0, dE - static)
    out = {}
    for i in insts:
        token_prop = toks[i] / tok_total if tok_total > 0 else 1.0 / len(insts)
        sm_prop = sms[i] / sm_total if sm_total > 0 else 1.0 / len(insts)
        sm_share = sms[i] / sm_total if sm_total > 0 else 1.0 / len(active)
        split = (static / len(active) + dyn * sm_share) / dE if i in active else 0.0
        out[i] = {"token_prop": token_prop, "sm_prop": sm_prop, "split": split}
    return out


def truncate_report(results, marker):
    """Drop an existing '## <marker>' section (and beyond) from report.md so
    re-running a mode rewrites its own section instead of duplicating it."""
    path = os.path.join(results, "report.md")
    if not os.path.exists(path):
        return
    with open(path) as f:
        text = f.read()
    idx = text.find("\n## " + marker)
    if idx >= 0:
        with open(path, "w") as f:
            f.write(text[:idx] + "\n")


def cmd_l1(args, samples, requests, inst_pids, rounds):
    with open(os.path.join(args.results, "l0_baseline.json")) as f:
        model = json.load(f)
    C = model["coefficients"]
    coef = [C["b0"]] + [C[f] for f in FEATURES]
    with open(os.path.join(args.results, "idle_power_w.json")) as f:
        idle_w = json.load(f)["idle_power_w"]
    insts = sorted(inst_pids)  # graceful: whatever instances are mapped
    windows = all_windows(rounds, samples, requests, inst_pids,
                          args.round_prefix)
    if not windows:
        sys.exit("no L1 windows; check --round-prefix and input files")

    rules = ["token_prop", "sm_prop", "split"]
    # --- absolute comparison (kept; known to be common-mode biased) ---------
    # errors[rule][round_label] = list of signed error % per instance-window
    errors = {r: {} for r in rules}
    # --- static-free share comparison ---------------------------------------
    # share_signed[rule][label][inst] = [signed share error, pct points]
    share_signed = {r: {} for r in rules}
    share_abs = {r: {} for r in rules}      # label -> [abs pp, both insts]
    bias = {}                               # label -> [common-mode bias %]
    for w in windows:
        attr = attribute(w, insts, idle_w, coef)
        for i in insts:
            exp = attr[i]["expected"]
            if exp <= 0:
                continue
            for r in rules:
                err = (attr[i][r] - exp) / exp * 100.0
                errors[r].setdefault(w["label"], []).append(err)

        # Static-free split of the baseline prediction.
        static_pred = C["b0"] + C["sm_clock_mhz"] * w["sm_clock_mhz"] \
            + C["temp_c"] * w["temp_c"]
        dyn = {i: max(0.0,
                      C["prompt_tok_s"] * w[f"prompt_tok_{i}"] / WINDOW_S
                      + C["predicted_tok_s"] * w[f"predicted_tok_{i}"] / WINDOW_S
                      + C["proc_sm_pct"] * w[f"sm_{i}"])
               for i in insts}
        # Common-mode bias: static double-count + interference, per window.
        full = {i: (static_pred + dyn[i]) * WINDOW_S for i in insts}
        if w["dE_joules"] > 0:
            bias.setdefault(w["label"], []).append(
                (sum(full.values()) - w["dE_joules"]) / w["dE_joules"] * 100.0)
        dyn_total = sum(dyn.values())
        if dyn_total <= 0:
            continue  # no load signal in window; skip share comparison
        shares = attr_shares(w, insts, idle_w)
        for i in insts:
            exp_share = dyn[i] / dyn_total
            for r in rules:
                err_pp = (shares[i][r] - exp_share) * 100.0
                share_signed[r].setdefault(w["label"], {}).setdefault(
                    i, []).append(err_pp)
                share_abs[r].setdefault(w["label"], []).append(abs(err_pp))

    truncate_report(args.results, "L1")
    truncate_report(args.results, "L2a")
    lines = ["", "## L1 attribution-rule comparison", "",
             "### Absolute error vs full L0 expectation (common-mode biased)", "",
             "Expected energy per instance includes the full baseline"
             " prediction (static terms counted once per instance), so all"
             " rules share a uniform negative bias — kept for reference only.",
             "",
             "| round | rule | mean error % | MAPE % |", "|---|---|---|---|"]
    for label in sorted({l for r in rules for l in errors[r]}):
        for r in rules:
            es = errors[r].get(label, [])
            if not es:
                continue
            mean_err = sum(es) / len(es)
            mape = sum(abs(e) for e in es) / len(es)
            lines.append(f"| {label} | {r} | {mean_err:+.2f} | {mape:.2f} |")

    # --- new section 1: static-free share-level comparison ------------------
    lines += ["", "### Static-free share comparison (percentage points)", "",
              "exp_share_i = dyn_i / (dyn_a + dyn_b) with dyn = load terms of"
              " the baseline only (b0, sm_clock, temp terms excluded)."
              " Signed error = attr_share - exp_share per instance;", ""
              "mean |error| pools both instances.", "",
              "| round | rule | a: mean signed pp | b: mean signed pp | mean |err| pp |",
              "|---|---|---|---|---|"]
    for label in sorted({l for r in rules for l in share_signed[r]}):
        for r in rules:
            per_inst = share_signed[r].get(label, {})
            abs_es = share_abs[r].get(label, [])
            if not abs_es:
                continue
            cells = []
            for i in insts:
                es = per_inst.get(i, [])
                cells.append(f"{sum(es) / len(es):+.2f}" if es else "n/a")
            lines.append(f"| {label} | {r} | {' | '.join(cells)} | "
                         f"{sum(abs_es) / len(abs_es):.2f} |")

    # --- new section 2: common-mode bias per round --------------------------
    lines += ["", "### Common-mode bias per round", "",
              "bias% = (sum of full expected energies - measured dE) / dE;"
              " quantifies static double-count + co-location interference"
              " per cell.", "",
              "| round | windows | mean bias % |", "|---|---|---|"]
    for label in sorted(bias):
        bs = bias[label]
        lines.append(f"| {label} | {len(bs)} | {sum(bs) / len(bs):+.2f} |")

    # --- verdict -------------------------------------------------------------
    workers_by_label = {}
    for e in load_jsonl(os.path.join(args.results, "events.jsonl")):
        if e.get("label") == "round_start" and isinstance(e.get("meta"), dict):
            workers_by_label[e["meta"].get("label")] = e["meta"].get("workers", {})

    def ratio_class(label):
        wk = workers_by_label.get(label) or {}
        ca, cb = wk.get("a", 0), wk.get("b", 0)
        if ca > 0 and cb > 0:
            if ca == cb:
                return "1:1"
            if ca == 3 * cb or cb == 3 * ca:
                return "3:1"
        return None

    # Aggregate mean |share error| per rule per ratio class.
    class_abs = {r: {"1:1": [], "3:1": []} for r in rules}
    for r in rules:
        for label, es in share_abs[r].items():
            cls = ratio_class(label)
            if cls in ("1:1", "3:1"):
                class_abs[r][cls].extend(es)

    lines += ["", "### Verdict (share-level)", "",
              "A rule passes if mean |share error| <= 5 percentage points in"
              " BOTH the 1:1 and 3:1 cells. Note: 1:1 cells cannot"
              " discriminate rules (all rules agree at equal shares) — the"
              " 3:1 cell L1_3to1_c62_M is the discriminating test.", "",
              "| rule | 1:1 mean |err| pp | 3:1 mean |err| pp | verdict |",
              "|---|---|---|---|"]
    passing = []
    for r in rules:
        es11, es31 = class_abs[r]["1:1"], class_abs[r]["3:1"]
        m11 = sum(es11) / len(es11) if es11 else None
        m31 = sum(es31) / len(es31) if es31 else None
        ok = m11 is not None and m31 is not None and m11 <= 5.0 and m31 <= 5.0
        if ok:
            passing.append(r)
        lines.append(
            f"| {r} | {'n/a' if m11 is None else f'{m11:.2f}'} | "
            f"{'n/a' if m31 is None else f'{m31:.2f}'} | "
            f"{'PASS' if ok else 'FAIL'} |")

    lines += ["",
              f"**L1 verdict: {'PASS — winning rule(s): ' + ', '.join(passing) if passing else 'FAIL — no rule within 5pp share error across 1:1 and 3:1'}**",
              ""]
    with open(os.path.join(args.results, "report.md"), "a") as f:
        f.write("\n".join(lines))
    print("\n".join(lines))


# ------------------------------------------------------------------ L2a -----
def cmd_l2a(args, samples, requests, inst_pids, rounds):
    """Residency tax + busy:idle interference tax (spec experiment_L2, part 1)."""
    with open(os.path.join(args.results, "idle_power_w.json")) as f:
        idle_w = json.load(f)["idle_power_w"]

    lines = ["", "## L2a residency tax & interference", ""]

    # --- residency tax: mean power between the two marks, zero traffic ------
    t_start = t_end = None
    for e in load_jsonl(os.path.join(args.results, "events.jsonl")):
        if e.get("event") != "mark":
            continue
        if e.get("label") == args.residency_start:
            t_start = e["ts"]
        elif e.get("label") == args.residency_end:
            t_end = e["ts"]
    if t_start is not None and t_end is not None and t_end > t_start:
        seg = [x["power_w"] for x in samples if t_start <= x["ts"] <= t_end]
        if seg:
            resident = sum(seg) / len(seg)
            delta = resident - idle_w
            lines += [
                "### Residency tax (both instances resident, zero traffic)", "",
                f"- window: {t_end - t_start:.0f}s between marks"
                f" `{args.residency_start}` / `{args.residency_end}`"
                f" ({len(seg)} samples)",
                f"- resident-idle power: **{resident:.2f} W**",
                f"- baseline idle power (idle_power_w.json): **{idle_w:.2f} W**",
                f"- delta: **{delta:+.2f} W ({delta / idle_w * 100:+.1f}%)**",
                f"- residency tax per instance (delta / 2): "
                f"**{delta / 2:+.2f} W**", ""]
        else:
            lines += ["Residency marks found but no sampler samples in the"
                      " window.", ""]
    else:
        lines += [f"Residency marks `{args.residency_start}` /"
                  f" `{args.residency_end}` not found in events.jsonl —"
                  " residency window not measured; run that phase and re-run"
                  " `l2a`.", ""]

    # --- interference tax: busy instance J/token, shared vs alone -----------
    lines += ["### Interference tax (J/token, busy:idle vs alone)", ""]
    jpt = {}
    for label in (args.busy_round, args.alone_round):
        if label not in rounds:
            lines.append(f"- round `{label}` not found in events.jsonl")
            continue
        t0, t1 = rounds[label]
        ws = windowize(label, t0, t1, samples, requests, inst_pids)
        dE = sum(w["dE_joules"] for w in ws)
        tok = sum(w[f"prompt_tok_{args.busy_instance}"]
                  + w[f"predicted_tok_{args.busy_instance}"] for w in ws)
        if tok > 0:
            jpt[label] = dE / tok
    if len(jpt) == 2:
        jb, ja = jpt[args.busy_round], jpt[args.alone_round]
        lines += [
            f"| round | J/token (instance {args.busy_instance}) |", "|---|---|",
            f"| {args.busy_round} (busy:idle, shared) | {jb:.4f} |",
            f"| {args.alone_round} (alone) | {ja:.4f} |", "",
            f"- interference tax on throughput-adjusted energy: "
            f"**{(jb - ja) / ja * 100:+.1f}%**", ""]
    with open(os.path.join(args.results, "report.md"), "a") as f:
        f.write("\n".join(lines))
    print("\n".join(lines))


# ------------------------------------------------------------------ main ----
def main():
    ap = argparse.ArgumentParser(description="GB10 attribution analysis")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("l0", cmd_l0), ("l1", cmd_l1), ("l2a", cmd_l2a)):
        p = sub.add_parser(name)
        p.add_argument("--results", default=RESULTS)
        p.add_argument("--sampler", default=None,
                       help="sampler JSONL (default <results>/sampler.jsonl)")
        p.add_argument("--round-prefix", default=name.upper())
        if name == "l0":
            p.add_argument("--instance", default="a",
                           help="single instance id for the L0 baseline")
        if name == "l2a":
            p.add_argument("--residency-start", default="L2_residency_start")
            p.add_argument("--residency-end", default="L2_residency_end")
            p.add_argument("--busy-round", default="L1_busyidle_c80_M",
                           help="busy:idle round label (shared)")
            p.add_argument("--alone-round", default="L0_c8_M",
                           help="same shape/concurrency round alone")
            p.add_argument("--busy-instance", default="a")
        p.set_defaults(fn=fn)
    args = ap.parse_args()

    sampler_path = args.sampler or os.path.join(args.results, "sampler.jsonl")
    samples = load_jsonl(sampler_path)
    if not samples:
        sys.exit(f"no samples in {sampler_path}")
    requests = load_requests(args.results)
    pids_path = os.path.join(args.results, "instance_pids.json")
    if not os.path.exists(pids_path):
        sys.exit(f"missing {pids_path}")
    with open(pids_path) as f:
        inst_pids = {k: set(v) for k, v in json.load(f).items()}
    rounds = load_rounds(args.results)
    if not rounds:
        sys.exit("no complete rounds found in events.jsonl")
    args.fn(args, samples, requests, inst_pids, rounds)


if __name__ == "__main__":
    main()
