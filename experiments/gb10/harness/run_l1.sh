#!/bin/bash
# L1 two-instance time-slicing attribution rounds.
# Requires: inst-b already running (start_inst_b.sh), idle baseline exists.
set -u
cd "$(dirname "$0")/.."
V=.venv/bin/python

run() { # label shape workers...
  local label=$1 shape=$2; shift 2
  echo "=== $label $(date +%H:%M:%S) ==="
  $V harness/orchestrate.py round --label "$label" --shape "$shape" "$@" || echo "ROUND FAILED: $label"
}

run L1_1to1_c88_M  M --workers a:8 --workers b:8
run L1_1to1_c44_M  M --workers a:4 --workers b:4
run L1_3to1_c62_M  M --workers a:6 --workers b:2
run L1_busyidle_c80_M M --workers a:8          # b resident, zero traffic
run L1_1to1_c44_A  A --workers a:4 --workers b:4
run L1_1to1_c44_B  B --workers a:4 --workers b:4
echo L1_DONE
