#!/bin/bash
# L0 single-instance baseline: 12 interleaved cells + 3 reversed anchors.
set -u
cd "$(dirname "$0")/.."
V=.venv/bin/python

cells="8:A 2:M 16:B 4:A 2:B 16:M 8:B 4:M 16:A 2:A 8:M 4:B"
for cell in $cells; do
  c=${cell%%:*}; s=${cell##*:}
  echo "=== L0_c${c}_${s} $(date +%H:%M:%S) ==="
  $V harness/orchestrate.py round --label L0_c${c}_${s} --shape $s --workers a:$c || echo "ROUND FAILED: L0_c${c}_${s}"
done

for c in 16 8 4; do
  echo "=== L0_c${c}_M_anchor $(date +%H:%M:%S) ==="
  $V harness/orchestrate.py round --label L0_c${c}_M_anchor --shape M --workers a:$c || echo "ROUND FAILED: anchor c${c}"
done
echo L0_DONE
