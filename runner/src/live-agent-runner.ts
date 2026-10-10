import { createPiSession } from "./piSession.js";
import { MeterBridge } from "./meterBridge.js";
import { PiStreamEventSchema, type PiStreamEvent } from "./contracts.js";
import { probeAndWarmup } from "./warmupProbe.js";

async function main() {
  const taskId = `live-gb10-${Date.now().toString(36)}`;
  const gatewayBaseUrl = process.env.AITRA_GATEWAY_URL ?? "http://127.0.0.1:8090";
  const metricsUrl = process.env.AITRA_METRICS_URL ?? "http://127.0.0.1:18083/metrics";
  const modelId = process.env.AITRA_MODEL_ID ?? "samantha-mistral-7b";
  const shouldWarmup = process.argv.includes("--warmup");

  console.log("=================================================");
  console.log("🚀 Starting Live End-to-End Agent Run on GB10");
  console.log(`Task ID: ${taskId}`);
  console.log(`Model Gateway: ${gatewayBaseUrl}`);
  console.log(`Metrics URL: ${metricsUrl}`);
  console.log(`Target Model: ${modelId}`);
  console.log(`Warmup Pre-flight: ${shouldWarmup ? "ENABLED (Approach 2)" : "DISABLED (testing Approach 1 Reconciliation)"}`);
  console.log("=================================================\n");

  if (shouldWarmup) {
    console.log("🔥 Running pre-flight silent warmup probe...");
    const probe = await probeAndWarmup({ gatewayBaseUrl, metricsUrl, modelId, minTokens: 35 });
    console.log("🔥 Pre-flight probe result:", JSON.stringify(probe, null, 2), "\n");
  }

  const events: PiStreamEvent[] = [];
  const meterBridge = new MeterBridge({ gatewayBaseUrl, metricsUrl });

  const session = await createPiSession({
    taskId,
    gatewayBaseUrl,
    modelId,
    meterBridge,
    onEvent: (event) => {
      // Validate event schema
      const validated = PiStreamEventSchema.parse(event);
      events.push(validated);

      const time = new Date().toISOString().split("T")[1].slice(0, 8);
      switch (validated.type) {
        case "session_start":
          console.log(`[${time}] 📦 SESSION_START: workspace=${validated.workspace}`);
          break;
        case "thought":
          process.stdout.write(validated.delta);
          break;
        case "tool_call":
          console.log(`\n[${time}] 🔧 TOOL_CALL [${validated.tool}]:`, JSON.stringify(validated.arguments));
          break;
        case "tool_result":
          console.log(`[${time}] 📋 TOOL_RESULT (exit ${validated.exitCode ?? 0}):`, validated.output.trim());
          break;
        case "message":
          process.stdout.write(validated.delta);
          break;
        case "settled":
          console.log(`\n[${time}] 💰 SETTLED BILL:`, JSON.stringify(validated.energy, null, 2));
          break;
      }
    },
  });

  const prompt = "Use the bash tool to run 'uname -m && date' and tell me the machine architecture and time.";
  console.log(`[PROMPT] ${prompt}\n`);

  try {
    await session.prompt(prompt);
    console.log("\n=================================================");
    console.log(`✅ Live Agent Execution Finished for task: ${taskId}`);
    console.log(`Total Structured Events Emitted: ${events.length}`);

    // Query task-gateway for raw billing verification
    const billResp = await fetch(`${gatewayBaseUrl}/tasks/${taskId}`);
    if (billResp.ok) {
      const bill = await billResp.json();
      console.log("\n📊 Task-Gateway Recorded Bill:");
      console.log(JSON.stringify(bill, null, 2));
    }
    console.log("=================================================");
  } finally {
    session.dispose();
  }
}

main().catch((err) => {
  console.error("❌ Live Agent Execution Failed:", err);
  process.exit(1);
});
