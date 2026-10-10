import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { PiStreamEventSchema, type PiStreamEvent } from "./contracts.js";
import { createPiSession, type PiSessionInstance } from "./piSession.js";
import { MeterBridge } from "./meterBridge.js";
import { probeAndWarmup, type WarmupProbeResult } from "./warmupProbe.js";

export type RunnerState =
  | "IDLE"
  | "ENVIRONMENT_PREPARED"
  | "SESSION_ACTIVE"
  | "ENERGY_SETTLING"
  | "FAILED";

export interface CreateServerOptions {
  port?: number;
  host?: string;
  gatewayBaseUrl?: string;
  metricsUrl?: string;
  meterBridge?: MeterBridge;
  warmupOnStartup?: boolean;
  allowedTools?: string[];
}

export interface ServerInstance {
  app: FastifyInstance;
  port: number;
  broadcast: (event: PiStreamEvent) => void;
  getState: () => RunnerState;
  close: () => Promise<void>;
}

/**
 * Creates the lightweight Fastify/WebSocket relay server broadcasting Pi stream events.
 */
export async function createServer(
  options?: CreateServerOptions
): Promise<ServerInstance> {
  const port = options?.port ?? 8000;
  const host = options?.host ?? "0.0.0.0";
  const gatewayBaseUrl = options?.gatewayBaseUrl ?? "http://127.0.0.1:8090";
  const metricsUrl =
    options?.metricsUrl ??
    process.env.AITRA_METRICS_URL ??
    "http://127.0.0.1:18083/metrics";
  const meterBridge =
    options?.meterBridge ??
    new MeterBridge({ gatewayBaseUrl, metricsUrl });

  if (options?.warmupOnStartup) {
    probeAndWarmup({ gatewayBaseUrl, metricsUrl }).catch(() => {});
  }

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  const clients = new Set<WebSocket>();
  let currentState: RunnerState = "IDLE";
  let activeSession: PiSessionInstance | null = null;
  let telemetryTimer: NodeJS.Timeout | null = null;

  function broadcast(event: PiStreamEvent): void {
    const serialized = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(serialized);
      }
    }
  }

  function stopTelemetryLoop(): void {
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
  }

  function startTelemetryLoop(): void {
    stopTelemetryLoop();

    // Fire one immediate sample on session start
    meterBridge.fetchLiveTelemetry().then((sample) => {
      if (sample && currentState === "SESSION_ACTIVE") {
        broadcast({
          type: "telemetry_tick",
          timestamp: Date.now(),
          gpuWatts: sample.gpuWatts,
          cpuWatts: sample.cpuWatts,
          idleBaselineWatts: sample.idleBaselineWatts,
          hostWatts: sample.hostWatts,
        });
      }
    }).catch(() => {});

    // Periodic 250ms telemetry ticker
    let isFetching = false;
    telemetryTimer = setInterval(async () => {
      if (currentState !== "SESSION_ACTIVE") {
        stopTelemetryLoop();
        return;
      }
      if (isFetching) return;
      isFetching = true;
      try {
        const sample = await meterBridge.fetchLiveTelemetry();
        if (sample && currentState === "SESSION_ACTIVE") {
          broadcast({
            type: "telemetry_tick",
            timestamp: Date.now(),
            gpuWatts: sample.gpuWatts,
            cpuWatts: sample.cpuWatts,
            idleBaselineWatts: sample.idleBaselineWatts,
            hostWatts: sample.hostWatts,
          });
        }
      } catch {
        // Silently tolerate transient scrape errors
      } finally {
        isFetching = false;
      }
    }, 250);
  }

  async function handleRunTask(prompt: string, customTaskId?: string): Promise<{ taskId: string }> {
    if (currentState !== "IDLE" && currentState !== "FAILED") {
      throw new Error(`Runner is currently busy in state ${currentState}`);
    }

    const taskId = customTaskId ?? `task-${randomUUID().slice(0, 8)}`;
    currentState = "ENVIRONMENT_PREPARED";

    try {
      activeSession = await createPiSession({
        taskId,
        gatewayBaseUrl,
        meterBridge,
        tools: options?.allowedTools,
        onEvent: async (event) => {
          if (event.type === "settled") {
            stopTelemetryLoop();
            try {
              const finalSample = await meterBridge.fetchLiveTelemetry();
              if (finalSample) {
                broadcast({
                  type: "telemetry_tick",
                  timestamp: Date.now(),
                  gpuWatts: finalSample.gpuWatts,
                  cpuWatts: finalSample.cpuWatts,
                  idleBaselineWatts: finalSample.idleBaselineWatts,
                  hostWatts: finalSample.hostWatts,
                });
              }
            } catch {
              // Ignore scrape error during settle
            }
            broadcast(event);
            currentState = "IDLE";
            activeSession?.dispose();
            activeSession = null;
          } else {
            broadcast(event);
          }
        },
      });

      currentState = "SESSION_ACTIVE";
      startTelemetryLoop();

      // Execute the prompt asynchronously in the background
      activeSession.prompt(prompt).catch((err) => {
        stopTelemetryLoop();
        currentState = "FAILED";
        activeSession?.dispose();
        activeSession = null;
      });

      return { taskId };
    } catch (err) {
      stopTelemetryLoop();
      currentState = "FAILED";
      activeSession?.dispose();
      activeSession = null;
      throw err;
    }
  }

  app.get("/healthz", async () => {
    return { status: "ok", runnerState: currentState };
  });

  const wsHandler = (socket: WebSocket) => {
    clients.add(socket);

    socket.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.action === "run" && typeof message.prompt === "string") {
          await handleRunTask(message.prompt, message.taskId);
        }
      } catch (err: any) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "error", error: err?.message ?? "unknown error" }));
        }
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });

    socket.on("error", () => {
      clients.delete(socket);
    });
  };

  app.get("/ws", { websocket: true }, wsHandler);
  app.get("/ws/stream", { websocket: true }, wsHandler);

  app.post("/api/run", async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body.prompt !== "string") {
      return reply.status(400).send({ error: "Missing required 'prompt' in request body" });
    }
    try {
      const res = await handleRunTask(body.prompt, body.taskId);
      return reply.status(202).send(res);
    } catch (err: any) {
      return reply.status(409).send({ error: err?.message ?? "Execution failed" });
    }
  });

  app.post("/api/warmup", async (request, reply) => {
    try {
      const warmup = await probeAndWarmup({
        gatewayBaseUrl,
        metricsUrl,
      });
      return reply.status(200).send({ status: "ok", warmup });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? "Warmup probe failed" });
    }
  });

  await app.listen({ port, host });
  const actualPort = (app.server.address() as any)?.port ?? port;

  return {
    app,
    port: actualPort,
    broadcast,
    getState: () => currentState,
    close: async () => {
      stopTelemetryLoop();
      for (const ws of clients) {
        ws.terminate();
      }
      clients.clear();
      activeSession?.dispose();
      await app.close();
    },
  };
}

// Support direct invocation if run as main
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PORT ?? "8000", 10);
  createServer({ port }).then((server) => {
    console.log(`Runner listening on port ${server.port}`);
  });
}
