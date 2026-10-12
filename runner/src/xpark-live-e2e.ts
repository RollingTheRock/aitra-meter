import { spawn } from "node:child_process";
import { MeterBridge } from "./meterBridge.js";
import type { PiStreamEvent } from "./contracts.js";

async function runChildWorkload(): Promise<void> {
  return new Promise((resolve, reject) => {
    // 2-3 seconds of real CPU calculation on Grace ARM
    const proc = spawn("python3", [
      "-c",
      "import time; start = time.time(); x = sum(i * i for i in range(8000000)); print('Calculated in', time.time() - start)",
    ]);
    proc.stdout.on("data", (data) => process.stdout.write(`[CPU Workload] ${data}`));
    proc.stderr.on("data", (data) => process.stderr.write(`[CPU Err] ${data}`));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exit code ${code}`));
    });
  });
}

async function runModelInference(gatewayBaseUrl: string, taskId: string, modelId: string): Promise<any> {
  const url = `${gatewayBaseUrl}/t/${taskId}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: "user",
          content: "Explain Grace Hopper superchip architecture in 3 concise bullet points.",
        },
      ],
      max_tokens: 150,
      stream: false,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Model completion failed: HTTP ${resp.status}`);
  }
  return resp.json();
}

async function main() {
  const taskId = `live-e2e-${Date.now().toString(36)}`;
  const gatewayBaseUrl = process.env.AITRA_GATEWAY_URL ?? "http://127.0.0.1:8092";
  const metricsUrl = process.env.AITRA_METRICS_URL ?? "http://127.0.0.1:18083/metrics";
  const modelId = process.env.AITRA_MODEL_ID ?? "samantha-mistral-7b";

  console.log("===============================================================");
  console.log("⚡ XPARK GB10 GRACE-HOPPER DUAL-DIMENSION REAL HARDWARE AUDIT");
  console.log(`Task ID:         ${taskId}`);
  console.log(`Agent PID:       ${process.pid}`);
  console.log(`Gateway:         ${gatewayBaseUrl}`);
  console.log(`Metrics Source:  ${metricsUrl}`);
  console.log(`Model ID:        ${modelId}`);
  console.log("===============================================================\n");

  const meterBridge = new MeterBridge({ gatewayBaseUrl, metricsUrl });

  // 1. Start agent turn: locks SPBM hwmon baseline and records start ticks
  console.log("[1/4] ⏱️  Locking SPBM hwmon resting baseline & sampling initial PID ticks...");
  const turnStartTime = Date.now();
  await meterBridge.onTurnStart(taskId, process.pid);

  // 2. Concurrently execute:
  //    A) Real LLM generation on NVIDIA GB10 GPU via task-gateway
  //    B) Real agent child-process computation on NVIDIA Grace ARM CPU
  console.log("[2/4] 🔥 Executing concurrent workload:");
  console.log("      - GPU: Invoking real LLM inference on GB10 GPU...");
  console.log("      - CPU: Spawning intensive computational process on Grace ARM cores...");

  const [modelResult] = await Promise.all([
    runModelInference(gatewayBaseUrl, taskId, modelId),
    runChildWorkload(),
  ]);

  const outputTokens = modelResult.usage?.completion_tokens ?? 0;
  console.log(`      -> Model completed with ${outputTokens} output tokens.`);
  console.log(`      -> Assistant reply snippet: ${JSON.stringify(modelResult.choices?.[0]?.message?.content?.slice(0, 100))}...`);

  // 3. Stop agent turn: reads ending ticks, computes active Joules after baseline deduction
  console.log("\n[3/4] 🛑 Stopping turn, attributing CPU delta via SPBM hwmon...");
  const attributedCpuJoules = await meterBridge.onTurnEnd(taskId);
  const durationSec = (Date.now() - turnStartTime) / 1000;
  console.log(`      -> Turn duration: ${durationSec.toFixed(2)}s`);
  console.log(`      -> Attributed Agent CPU Energy: ${attributedCpuJoules.toFixed(3)} Joules`);

  // 4. Settle task bill through MeterBridge
  console.log("\n[4/4] 💰 Settling dual-dimension task bill...");
  const settled = await meterBridge.settleTask(taskId, durationSec);
  console.log("\n==================== SETTLED BILL OUTPUT ====================");
  console.log(JSON.stringify(settled, null, 2));

  // 5. Query task-gateway persistence
  const gwBillResp = await fetch(`${gatewayBaseUrl}/tasks/${taskId}`);
  if (gwBillResp.ok) {
    const gwBill = await gwBillResp.json();
    console.log("\n================ TASK-GATEWAY RECORDED BILL ================");
    console.log(JSON.stringify(gwBill, null, 2));
  }
  console.log("===============================================================");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
