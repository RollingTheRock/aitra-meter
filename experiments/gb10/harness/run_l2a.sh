#!/bin/bash
# L2a: residency tax — both instances resident, zero traffic, 300s window.
set -u
cd "$(dirname "$0")/.."
V=.venv/bin/python
$V harness/orchestrate.py mark --label L2_residency_start
sleep 300
$V harness/orchestrate.py mark --label L2_residency_end
echo L2A_DONE
