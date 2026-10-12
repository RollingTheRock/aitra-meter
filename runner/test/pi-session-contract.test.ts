import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { PiStreamEventSchema, type PiStreamEvent } from "../src/contracts.js";
import { prepareEnvironment } from "../src/piEnvironment.js";
import { createPiSession } from "../src/piSession.js";
import { MeterBridge } from "../src/meterBridge.js";
import { createServer } from "../src/server.js";
import { probeAndWarmup } from "../src/warmupProbe.js";

describe("1. PiStreamEventSchema Data Contract", () => {
  it("validates session_start event", () => {
    const event = {
      type: "session_start",
      taskId: "task-001",
      workspace: "/tmp/workspace",
    };
    const parsed = PiStreamEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("validates thought event", () => {
    const event = {
      type: "thought",
      taskId: "task-001",
      delta: "Thinking through the requirements...",
    };
    const parsed = PiStreamEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("validates tool_call event", () => {
    const event = {
      type: "tool_call",
      taskId: "task-001",
      callId: "call-1",
      tool: "bash",
      arguments: { command: "ls -la" },
    };
    const parsed = PiStreamEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("validates tool_result event", () => {
    const event = {
      type: "tool_result",
      taskId: "task-001",
      callId: "call-1",
      output: "total 0",
      exitCode: 0,
    };
    const parsed = PiStreamEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("validates message event", () => {
    const event = {
      type: "message",
      taskId: "task-001",
      delta: "Here is the response text.",
    };
    const parsed = PiStreamEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("validates settled energy event", () => {
    const event = {
      type: "settled",
      taskId: "task-001",
      durationSeconds: 12.5,
      energy: {
        agentCpuJoules: 45.2,
        modelGpuJoules: 120.8,
        totalJoules: 166.0,
        systemJpt: 1.66,
        outputTokens: 100,
      },
    };
    const parsed = PiStreamEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("validates telemetry_tick event", () => {
    const event = {
      type: "telemetry_tick",
      timestamp: 1728550000000,
      gpuWatts: 18.5,
      cpuWatts: 4.2,
      idleBaselineWatts: 25.0,
      hostWatts: 47.7,
    };
    const parsed = PiStreamEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);

    const negativeWatts = {
      ...event,
      gpuWatts: -5,
    };
    expect(PiStreamEventSchema.safeParse(negativeWatts).success).toBe(false);
  });

  it("rejects unknown event type or missing required fields", () => {
    const invalid = {
      type: "random_unknown_type",
      taskId: "task-001",
    };
    const parsed = PiStreamEventSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });
});

describe("2. PiEnvironment Sandbox Isolation", () => {
  let tempBase: string;

  beforeEach(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "pi-env-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
  });

  it("creates dedicated isolated workspace and home directories", async () => {
    const taskId = "task-sandbox-123";
    const envLayout = await prepareEnvironment(taskId, { baseDir: tempBase });

    expect(envLayout.workspaceDir).toBe(path.join(tempBase, taskId, "workspace"));
    expect(envLayout.homeDir).toBe(path.join(tempBase, taskId, "home"));

    const wsStat = await fs.stat(envLayout.workspaceDir);
    const homeStat = await fs.stat(envLayout.homeDir);
    expect(wsStat.isDirectory()).toBe(true);
    expect(homeStat.isDirectory()).toBe(true);

    expect(envLayout.env.AITRA_TASK_ID).toBe(taskId);
    expect(envLayout.env.WORKSPACE_DIR).toBe(envLayout.workspaceDir);
  });
});

describe("3. PiSession & Provider Route Binding", () => {
  let tempBase: string;

  beforeEach(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "pi-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
  });

  it("registers aitra provider bound to task-gateway path and streams structured events", async () => {
    const taskId = "task-route-test-456";
    const gatewayBaseUrl = "http://127.0.0.1:8090";

    const emittedEvents: PiStreamEvent[] = [];
    const session = await createPiSession({
      taskId,
      gatewayBaseUrl,
      baseDir: tempBase,
      onEvent: (event) => emittedEvents.push(event),
    });

    expect(session.taskId).toBe(taskId);
    expect(session.providerBaseUrl).toBe(`${gatewayBaseUrl}/t/${taskId}/v1`);

    session.dispose();
  });
});

describe("4. MeterBridge LifeCycle & Settled Bill Calculation", () => {
  it("tracks turn lifecycle and computes dual-dimension energy bill", async () => {
    const taskId = "task-meter-test-789";

    // Mock task-gateway responding to /tasks/{taskId}
    const gatewayServer = http.createServer((req, res) => {
      if (req.url === `/tasks/${taskId}`) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            task_id: taskId,
            total_calls: 2,
            output_tokens: 250,
            gpu_joules: 350.5,
            system_joules: 380.0,
          })
        );
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => gatewayServer.listen(18091, resolve));

    try {
      const bridge = new MeterBridge({
        gatewayBaseUrl: "http://127.0.0.1:18091",
        cpuAttributionSource: {
          sampleTurnStart: vi.fn().mockResolvedValue(undefined),
          sampleTurnEnd: vi.fn().mockResolvedValue(15.5), // 15.5 Joules CPU
        },
      });

      await bridge.onTurnStart(taskId, process.pid);
      await bridge.onTurnEnd(taskId);

      const bill = await bridge.settleTask(taskId, 10.0);

      expect(bill.type).toBe("settled");
      expect(bill.taskId).toBe(taskId);
      expect(bill.durationSeconds).toBe(10.0);
      expect(bill.energy.agentCpuJoules).toBe(15.5);
      expect(bill.energy.modelGpuJoules).toBe(350.5);
      expect(bill.energy.totalJoules).toBe(366.0);
      expect(bill.energy.outputTokens).toBe(250);
      expect(bill.energy.systemJpt).toBeCloseTo(366.0 / 250, 4);
    } finally {
      gatewayServer.close();
    }
  });

  it("contacts task-gateway /cpu/start and /cpu/stop via HttpCpuAttributionSource by default", async () => {
    const taskId = "task-http-cpu-test";
    let cpuStartCalled = false;
    let cpuStopCalled = false;
    let passedPid = 0;

    const gatewayServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === `/tasks/${taskId}/cpu/start`) {
        cpuStartCalled = true;
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          passedPid = parsed.pid;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", task_id: taskId, pid: passedPid }));
        });
      } else if (req.method === "POST" && req.url === `/tasks/${taskId}/cpu/stop`) {
        cpuStopCalled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ task_id: taskId, agent_cpu_joules: 18.2 }));
      } else if (req.url === `/tasks/${taskId}`) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            task_id: taskId,
            total_calls: 1,
            output_tokens: 100,
            gpu_joules: 200.0,
          })
        );
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => gatewayServer.listen(18095, resolve));

    try {
      // Constructed WITHOUT cpuAttributionSource option - should default to HttpCpuAttributionSource
      const bridge = new MeterBridge({
        gatewayBaseUrl: "http://127.0.0.1:18095",
      });

      await bridge.onTurnStart(taskId, 9999);
      expect(cpuStartCalled).toBe(true);
      expect(passedPid).toBe(9999);

      const turnJoules = await bridge.onTurnEnd(taskId);
      expect(cpuStopCalled).toBe(true);
      expect(turnJoules).toBe(18.2);

      const bill = await bridge.settleTask(taskId, 5.0);
      expect(bill.energy.agentCpuJoules).toBe(18.2);
      expect(bill.energy.modelGpuJoules).toBe(200.0);
      expect(bill.energy.totalJoules).toBe(218.2);
    } finally {
      gatewayServer.close();
    }
  });

  it("reconciles provisional cold bill by polling metrics until JPT is available", async () => {
    const taskId = "task-provisional-reconcile";
    let metricsPollCount = 0;

    const mockServer = http.createServer((req, res) => {
      if (req.url === `/tasks/${taskId}`) {
        // Task gateway returns provisional bill with 0 gpu_joules
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            task_id: taskId,
            total_calls: 1,
            output_tokens: 100,
            gpu_joules: 0,
            provisional: true,
          })
        );
      } else if (req.url === "/metrics") {
        metricsPollCount++;
        res.writeHead(200, { "Content-Type": "text/plain" });
        if (metricsPollCount === 1) {
          // First poll: aggregation loop still in quiet state
          res.end("aitra_j_per_token{model=\"test-model\"} 0\n");
        } else {
          // Second poll: 30s window closed and calculated 1.5 J/token
          res.end("aitra_j_per_token{model=\"test-model\"} 1.5\n");
        }
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(18092, resolve));

    try {
      const bridge = new MeterBridge({
        gatewayBaseUrl: "http://127.0.0.1:18092",
        metricsUrl: "http://127.0.0.1:18092/metrics",
        reconciliationPollIntervalMs: 20,
        reconciliationTimeoutMs: 1000,
        cpuAttributionSource: {
          sampleTurnStart: vi.fn().mockResolvedValue(undefined),
          sampleTurnEnd: vi.fn().mockResolvedValue(10.0),
        },
      });

      await bridge.onTurnStart(taskId, process.pid);
      await bridge.onTurnEnd(taskId);

      const settled = await bridge.settleTask(taskId, 5.0);

      expect(settled.taskId).toBe(taskId);
      expect(settled.energy.outputTokens).toBe(100);
      expect(settled.energy.agentCpuJoules).toBe(10.0);
      // Reconciled model GPU energy: 100 tokens * 1.5 J/token = 150.0 Joules
      expect(settled.energy.modelGpuJoules).toBe(150.0);
      expect(settled.energy.totalJoules).toBe(160.0);
      expect(settled.energy.systemJpt).toBe(1.6);
      expect(settled.energy.reconciled).toBe(true);
      expect(settled.energy.provisional).toBe(false);
    } finally {
      mockServer.close();
    }
  });

  it("times out deferred reconciliation gracefully if metrics never become positive", async () => {
    const taskId = "task-provisional-timeout";

    const mockServer = http.createServer((req, res) => {
      if (req.url === `/tasks/${taskId}`) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            task_id: taskId,
            total_calls: 1,
            output_tokens: 50,
            gpu_joules: 0,
            provisional: true,
          })
        );
      } else if (req.url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("aitra_j_per_token{model=\"test-model\"} 0\n");
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(18093, resolve));

    try {
      const bridge = new MeterBridge({
        gatewayBaseUrl: "http://127.0.0.1:18093",
        metricsUrl: "http://127.0.0.1:18093/metrics",
        reconciliationPollIntervalMs: 20,
        reconciliationTimeoutMs: 100, // fast timeout for test
      });

      const settled = await bridge.settleTask(taskId, 2.0);

      expect(settled.taskId).toBe(taskId);
      expect(settled.energy.modelGpuJoules).toBe(0);
      expect(settled.energy.provisional).toBe(true);
      expect(settled.energy.reconciled).toBe(false);
    } finally {
      mockServer.close();
    }
  });

  it("fetches live GPU power telemetry from Prometheus endpoint", async () => {
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(
          '# HELP aitra_gpu_power_watts Current GPU power draw in watts.\n' +
          '# TYPE aitra_gpu_power_watts gauge\n' +
          'aitra_gpu_power_watts{gpu_id="samantha-mistral-7b",node="gb10-spark"} 14.85\n' +
          'aitra_gpu_power_watts{gpu_id="unknown",node="gb10-spark"} 3.58\n'
        );
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(18094, resolve));

    try {
      const bridge = new MeterBridge({
        metricsUrl: "http://127.0.0.1:18094/metrics",
        hwmonPath: "/nonexistent/hwmon",
      });

      const sample = await bridge.fetchLiveTelemetry("samantha-mistral-7b");
      expect(sample).not.toBeNull();
      expect(sample?.gpuWatts).toBe(14.85);
      expect(sample?.hostWatts).toBe(14.85);
    } finally {
      mockServer.close();
    }
  });

  it("reads physical power channels from SPBM hwmon sysfs", async () => {
    const tempHwmon = await fs.mkdtemp(path.join(os.tmpdir(), "hwmon-test-"));
    const spbmDir = path.join(tempHwmon, "hwmon8");
    await fs.mkdir(spbmDir, { recursive: true });

    await fs.writeFile(path.join(spbmDir, "name"), "spbm\n");
    await fs.writeFile(path.join(spbmDir, "power1_label"), "dc_input\n");
    await fs.writeFile(path.join(spbmDir, "power1_input"), "36500000\n"); // 36.5W
    await fs.writeFile(path.join(spbmDir, "power2_label"), "gpu\n");
    await fs.writeFile(path.join(spbmDir, "power2_input"), "12250000\n"); // 12.25W
    await fs.writeFile(path.join(spbmDir, "power3_label"), "cpu_p\n");
    await fs.writeFile(path.join(spbmDir, "power3_input"), "2100000\n");  // 2.1W
    await fs.writeFile(path.join(spbmDir, "power4_label"), "cpu_e\n");
    await fs.writeFile(path.join(spbmDir, "power4_input"), "150000\n");   // 0.15W

    try {
      const bridge = new MeterBridge({
        hwmonPath: tempHwmon,
      });

      const sample = bridge.readSpbmHwmon();
      expect(sample).not.toBeNull();
      expect(sample?.hostWatts).toBe(36.5);
      expect(sample?.gpuWatts).toBe(12.25);
      expect(sample?.cpuWatts).toBe(2.25);
      expect(sample?.idleBaselineWatts).toBe(22.0); // 36.5 - 12.25 - 2.25
    } finally {
      await fs.rm(tempHwmon, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("5. Fastify + WebSocket Server Contract", () => {
  let serverInstance: Awaited<ReturnType<typeof createServer>>;
  let port: number;

  beforeEach(async () => {
    serverInstance = await createServer({
      port: 0, // dynamic port
      gatewayBaseUrl: "http://127.0.0.1:8090",
    });
    port = serverInstance.port;
  });

  afterEach(async () => {
    await serverInstance.close();
  });

  it("accepts WebSocket connection and broadcasts stream events", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: PiStreamEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        received.push(parsed);
      });
    });

    // Broadcast test event via server
    serverInstance.broadcast({
      type: "thought",
      taskId: "task-ws-1",
      delta: "Broadcast test",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.close();

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].type).toBe("thought");
    expect((received[0] as any).delta).toBe("Broadcast test");
  });
});

describe("6. End-to-End Session Execution & Structured Event Stream", () => {
  let mockGateway: http.Server;
  let mockPort: number;
  let tempBase: string;

  beforeEach(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "pi-e2e-test-"));

    let requestCount = 0;
    mockGateway = http.createServer((req, res) => {
      if (req.url?.includes("/chat/completions")) {
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (requestCount === 1) {
          // First turn: model thinks and calls bash tool to write a file
          res.write(
            "data: " +
              JSON.stringify({
                id: "chatcmpl-1",
                choices: [
                  {
                    delta: {
                      reasoning_content: "I will use bash to write proof.txt",
                    },
                  },
                ],
              }) +
              "\n\n"
          );
          res.write(
            "data: " +
              JSON.stringify({
                id: "chatcmpl-1",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_bash_1",
                          type: "function",
                          function: {
                            name: "bash",
                            arguments: JSON.stringify({
                              command: "echo 'aitra-meter-proof' > proof.txt",
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }) +
              "\n\n"
          );
          res.write(
            "data: " +
              JSON.stringify({
                id: "chatcmpl-1",
                choices: [{ finish_reason: "tool_calls" }],
              }) +
              "\n\n"
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          // Second turn: after tool result, model sends final message
          res.write(
            "data: " +
              JSON.stringify({
                id: "chatcmpl-2",
                choices: [
                  {
                    delta: {
                      content: "File proof.txt has been successfully created.",
                    },
                  },
                ],
              }) +
              "\n\n"
          );
          res.write(
            "data: " +
              JSON.stringify({
                id: "chatcmpl-2",
                choices: [{ finish_reason: "stop" }],
              }) +
              "\n\n"
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } else if (req.url?.includes("/tasks/")) {
        // Task gateway bill endpoint
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            task_id: "e2e-task",
            total_calls: 2,
            output_tokens: 88,
            gpu_joules: 142.0,
            system_joules: 160.0,
          })
        );
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => {
      mockGateway.listen(0, () => {
        mockPort = (mockGateway.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    mockGateway.close();
    await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
  });

  it("completes full tool execution loop and emits all structured events conforming to schema", async () => {
    const taskId = "task-e2e-full-proof";
    const collectedEvents: PiStreamEvent[] = [];

    const meterBridge = new MeterBridge({
      gatewayBaseUrl: `http://127.0.0.1:${mockPort}`,
      cpuAttributionSource: {
        sampleTurnStart: vi.fn().mockResolvedValue(undefined),
        sampleTurnEnd: vi.fn().mockResolvedValue(8.2), // 8.2J per turn
      },
    });

    const session = await createPiSession({
      taskId,
      gatewayBaseUrl: `http://127.0.0.1:${mockPort}`,
      baseDir: tempBase,
      meterBridge,
      tools: ["read", "bash", "edit", "write"],
      onEvent: (event) => {
        // Validate every event against PiStreamEventSchema
        const validated = PiStreamEventSchema.parse(event);
        collectedEvents.push(validated);
      },
    });

    try {
      await session.prompt("Please create proof.txt");

      // Verify file was physically written in the sandboxed workspace
      const writtenFilePath = path.join(session.workspaceDir, "proof.txt");
      const content = await fs.readFile(writtenFilePath, "utf-8");
      expect(content.trim()).toBe("aitra-meter-proof");

      // Verify sequence of structured events
      const eventTypes = collectedEvents.map((e) => e.type);
      expect(eventTypes).toContain("session_start");
      expect(eventTypes).toContain("thought");
      expect(eventTypes).toContain("tool_call");
      expect(eventTypes).toContain("tool_result");
      expect(eventTypes).toContain("message");
      expect(eventTypes).toContain("settled");

      // Verify tool call details
      const toolCall = collectedEvents.find((e) => e.type === "tool_call") as any;
      expect(toolCall.tool).toBe("bash");
      expect(toolCall.arguments.command).toContain("echo 'aitra-meter-proof' > proof.txt");

      // Verify settled bill structure
      const settled = collectedEvents.find((e) => e.type === "settled") as any;
      expect(settled.taskId).toBe(taskId);
      expect(settled.energy.modelGpuJoules).toBe(142.0);
      expect(settled.energy.agentCpuJoules).toBeGreaterThan(0);
      expect(settled.energy.totalJoules).toBe(
        settled.energy.agentCpuJoules + settled.energy.modelGpuJoules
      );
      expect(settled.energy.outputTokens).toBe(88);
    } finally {
      session.dispose();
    }
  });
});

describe("7. Pre-flight Silent Warmup Probe", () => {
  it("skips probe if aggregation metrics already show positive JPT", async () => {
    const mockMetricsServer = http.createServer((req, res) => {
      if (req.url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("aitra_j_per_token{model=\"samantha-mistral-7b\"} 1.271\n");
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => mockMetricsServer.listen(18094, resolve));

    try {
      const result = await probeAndWarmup({
        metricsUrl: "http://127.0.0.1:18094/metrics",
        gatewayBaseUrl: "http://127.0.0.1:18095",
        modelId: "samantha-mistral-7b",
      });

      expect(result.alreadyWarm).toBe(true);
      expect(result.triggered).toBe(false);
      expect(result.jpt).toBe(1.271);
    } finally {
      mockMetricsServer.close();
    }
  });

  it("fires lightweight completion probe with >= 30 tokens when cold", async () => {
    let completionCalled = false;
    let requestedMaxTokens = 0;

    const mockServer = http.createServer(async (req, res) => {
      if (req.url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        // Cold state: metrics gauge is 0
        res.end("aitra_j_per_token{model=\"samantha-mistral-7b\"} 0\n");
      } else if (req.url?.includes("/chat/completions")) {
        completionCalled = true;
        const bodyBuf: Buffer[] = [];
        for await (const chunk of req) {
          bodyBuf.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(bodyBuf).toString());
        requestedMaxTokens = body.max_tokens;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-probe",
            choices: [{ message: { role: "assistant", content: "1 2 3 4 5 6 7 8 9 10" } }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 35,
              total_tokens: 47,
            },
          })
        );
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(18096, resolve));

    try {
      const result = await probeAndWarmup({
        metricsUrl: "http://127.0.0.1:18096/metrics",
        gatewayBaseUrl: "http://127.0.0.1:18096",
        modelId: "samantha-mistral-7b",
        minTokens: 35,
      });

      expect(result.alreadyWarm).toBe(false);
      expect(result.triggered).toBe(true);
      expect(result.outputTokens).toBe(35);
      expect(completionCalled).toBe(true);
      // Verify tokens exceed aggregation-service minServingTokens (30)
      expect(requestedMaxTokens).toBeGreaterThanOrEqual(30);
    } finally {
      mockServer.close();
    }
  });
});

describe("8. Server Pre-flight Warmup & API Endpoints", () => {
  it("exposes /api/warmup endpoint to trigger pre-flight probe", async () => {
    const mockGateway = http.createServer((req, res) => {
      if (req.url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("aitra_j_per_token{model=\"default\"} 1.4\n");
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => mockGateway.listen(18097, resolve));

    let serverInstance: Awaited<ReturnType<typeof createServer>> | null = null;
    try {
      serverInstance = await createServer({
        port: 0,
        gatewayBaseUrl: "http://127.0.0.1:18097",
        metricsUrl: "http://127.0.0.1:18097/metrics",
      });

      const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/warmup`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");
      expect(data.warmup.alreadyWarm).toBe(true);
      expect(data.warmup.jpt).toBe(1.4);
    } finally {
      if (serverInstance) await serverInstance.close();
      mockGateway.close();
    }
  });
});


