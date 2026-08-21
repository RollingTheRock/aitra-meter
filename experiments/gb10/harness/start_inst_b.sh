#!/bin/bash
# Start inst-b: second llama-server container sharing the single GB10 GPU
# (time-slicing, compute mode Default). Same image/model/flags as inst-a.
set -eu
docker rm -f gb10-inst-b >/dev/null 2>&1 || true
docker run -d --name gb10-inst-b --gpus all -p 18081:8080 \
  -v lab-00_ollama:/models:ro \
  ghcr.io/ggml-org/llama.cpp:server-cuda \
  --model /models/models/blobs/sha256-4a3019290402c9eadf89a3bf793102a52a2a44dd76ea7b07fca53f9cbb789a63 \
  --alias samantha-mistral-7b-b --host 0.0.0.0 --port 8080 \
  -ngl 99 --ctx-size 40960 --parallel 16 --flash-attn on --metrics
echo "waiting for health..."
for i in $(seq 1 60); do
  if curl -sf --max-time 2 http://127.0.0.1:18081/health >/dev/null 2>&1; then
    echo "inst-b healthy after ${i}s"; break
  fi
  sleep 2
done
curl -s http://127.0.0.1:18081/health && echo
# record host pids of both llama-server processes for per-pid attribution
A_PID=$(docker inspect -f '{{.State.Pid}}' aitra-experiment-llama-server-1)
B_PID=$(docker inspect -f '{{.State.Pid}}' gb10-inst-b)
printf '{"a": [%s], "b": [%s]}\n' "$A_PID" "$B_PID" > results/20260821/instance_pids.json
cat results/20260821/instance_pids.json
