#!/bin/bash
# L2b: MPS cross-check. Stops both plain instances, starts MPS daemon + two
# MPS-enabled containers on the same ports (18080/18081), runs the two key
# cells, then restores the original inst-a container.
# Timeboxed: if MPS setup fails, record and bail — analysis must not slip.
set -u
cd "$(dirname "$0")/.."
V=.venv/bin/python
MODEL=/models/models/blobs/sha256-4a3019290402c9eadf89a3bf793102a52a2a44dd76ea7b07fca53f9cbb789a63
IMG=ghcr.io/ggml-org/llama.cpp:server-cuda
PIPE=/tmp/nvidia-mps

cleanup_and_restore() {
  docker rm -f gb10-mps-a gb10-mps-b >/dev/null 2>&1 || true
  echo quit | nvidia-cuda-mps-control >/dev/null 2>&1 || true
  docker start aitra-experiment-llama-server-1 >/dev/null 2>&1 || true
  echo "restored inst-a"
}
trap cleanup_and_restore EXIT

docker stop gb10-inst-b aitra-experiment-llama-server-1 >/dev/null
mkdir -p $PIPE
export CUDA_MPS_PIPE_DIRECTORY=$PIPE CUDA_MPS_LOG_DIRECTORY=$PIPE
if ! echo start | nvidia-cuda-mps-control; then echo "MPS_DAEMON_FAIL"; exit 1; fi

for p in 18080 18081; do
  name=gb10-mps-a; [ $p = 18081 ] && name=gb10-mps-b
  docker run -d --name $name --gpus all -p $p:8080 \
    -v lab-00_ollama:/models:ro -v $PIPE:$PIPE \
    -e CUDA_MPS_PIPE_DIRECTORY=$PIPE -e CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=50 \
    $IMG --model $MODEL --alias mps-$name --host 0.0.0.0 --port 8080 \
    -ngl 99 --ctx-size 40960 --parallel 16 --flash-attn on --metrics >/dev/null
done
for p in 18080 18081; do
  ok=""; for i in $(seq 1 45); do
    curl -sf --max-time 2 http://127.0.0.1:$p/health >/dev/null 2>&1 && { ok=1; break; }; sleep 2
  done
  [ -n "$ok" ] || { echo "MPS_CONTAINER_FAIL port=$p"; exit 1; }
done
echo "mps instances healthy"

# verify MPS actually engaged: both server pids should appear in MPS server list
docker exec gb10-mps-a bash -c 'echo get_server_list | nvidia-cuda-mps-control' 2>/dev/null || true

$V harness/orchestrate.py round --label L2_mps_1to1_c88_M --shape M --workers a:8 --workers b:8
$V harness/orchestrate.py round --label L2_mps_3to1_c62_M --shape M --workers a:6 --workers b:2
echo L2B_DONE
