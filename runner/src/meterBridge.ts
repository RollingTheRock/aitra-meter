import fs from "node:fs";
import path from "node:path";
import type { PiStreamEvent } from "./contracts.js";

export interface CpuAttributionSource {
  sampleTurnStart(taskId: string, pid: number): Promise<void>;
  sampleTurnEnd(taskId: string): Promise<number>;
}

export interface LiveTelemetrySample {
  gpuWatts: number;
  cpuWatts: number;
  idleBaselineWatts: number;
  hostWatts?: number;
}

export interface MeterBridgeOptions {
  gatewayBaseUrl?: string;
  metricsUrl?: string;
  hwmonPath?: string;
  cpuAttributionSource?: CpuAttributionSource;
  reconciliationTimeoutMs?: number;
  reconciliationPollIntervalMs?: number;
}

export interface TaskGatewayBillResponse {
  task_id: string;
  total_calls?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  gpu_joules?: number;
  system_joules?: number;
  provisional?: boolean;
}

/**
 * Real HTTP implementation of CpuAttributionSource connecting to task-gateway.
 */
export class HttpCpuAttributionSource implements CpuAttributionSource {
  constructor(private readonly gatewayBaseUrl: string) {}

  async sampleTurnStart(taskId: string, pid: number): Promise<void> {
    try {
      const resp = await fetch(`${this.gatewayBaseUrl}/tasks/${taskId}/cpu/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
      });
      if (!resp.ok && resp.status !== 503) {
        console.warn(`[HttpCpuAttributionSource] turn_start failed for ${taskId}: HTTP ${resp.status}`);
      }
    } catch {
      // Gateway might be unreachable during local test/mock setups
    }
  }

  async sampleTurnEnd(taskId: string): Promise<number> {
    try {
      const resp = await fetch(`${this.gatewayBaseUrl}/tasks/${taskId}/cpu/stop`, {
        method: "POST",
      });
      if (resp.ok) {
        const meas = (await resp.json()) as { agent_cpu_joules?: number };
        return meas.agent_cpu_joules ?? 0;
      }
    } catch {
      // Gateway might be unreachable
    }
    return 0;
  }
}

/**
 * Bridges Pi agent turns with METER-001 CPU host telemetry and GW-001 task-gateway token billing.
 */
export class MeterBridge {
  private readonly gatewayBaseUrl: string;
  private readonly metricsUrl: string;
  private readonly hwmonPath: string;
  private readonly cpuSource?: CpuAttributionSource;
  private readonly reconciliationTimeoutMs: number;
  private readonly reconciliationPollIntervalMs: number;
  private readonly accumulatedCpuJoules: Map<string, number> = new Map();

  constructor(options?: MeterBridgeOptions) {
    this.gatewayBaseUrl = options?.gatewayBaseUrl ?? "http://127.0.0.1:8090";
    this.metricsUrl =
      options?.metricsUrl ??
      process.env.AITRA_METRICS_URL ??
      "http://127.0.0.1:18083/metrics";
    this.hwmonPath =
      options?.hwmonPath ??
      process.env.AITRA_HWMON_PATH ??
      "/sys/class/hwmon";
    this.cpuSource =
      options?.cpuAttributionSource ??
      new HttpCpuAttributionSource(this.gatewayBaseUrl);
    this.reconciliationTimeoutMs = options?.reconciliationTimeoutMs ?? 35_000;
    this.reconciliationPollIntervalMs = options?.reconciliationPollIntervalMs ?? 1_000;
  }

  /**
   * Fetches the live aitra_j_per_token from the aggregation metrics endpoint.
   */
  async fetchJptFromMetrics(modelId?: string): Promise<number | null> {
    try {
      const resp = await fetch(this.metricsUrl);
      if (!resp.ok) return null;
      const text = await resp.text();
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line.startsWith("aitra_j_per_token")) continue;
        if (modelId && line.includes(`model="${modelId}"`)) {
          const parts = line.trim().split(/\s+/);
          const val = parseFloat(parts[parts.length - 1]);
          if (!isNaN(val) && val > 0) return val;
        } else if (!modelId) {
          const parts = line.trim().split(/\s+/);
          const val = parseFloat(parts[parts.length - 1]);
          if (!isNaN(val) && val > 0) return val;
        }
      }
      if (modelId) {
        for (const line of lines) {
          if (!line.startsWith("aitra_j_per_token")) continue;
          const parts = line.trim().split(/\s+/);
          const val = parseFloat(parts[parts.length - 1]);
          if (!isNaN(val) && val > 0) return val;
        }
      }
    } catch {
      // Ignore network errors during polling
    }
    return null;
  }

  /**
   * Reads hardware power sensors directly from Grace Hopper SPBM hwmon sysfs if available.
   */
  readSpbmHwmon(): LiveTelemetrySample | null {
    try {
      const base = this.hwmonPath;
      if (!fs.existsSync(base)) return null;
      const entries = fs.readdirSync(base);
      for (const dir of entries) {
        const namePath = path.join(base, dir, "name");
        if (!fs.existsSync(namePath)) continue;
        const name = fs.readFileSync(namePath, "utf8").trim().toLowerCase();
        if (name.includes("spbm") || name.includes("spark")) {
          const dirPath = path.join(base, dir);
          const readWatt = (targetLabel: string): number => {
            for (let i = 1; i <= 24; i++) {
              const lblPath = path.join(dirPath, `power${i}_label`);
              if (fs.existsSync(lblPath) && fs.readFileSync(lblPath, "utf8").trim() === targetLabel) {
                const inPath = path.join(dirPath, `power${i}_input`);
                if (fs.existsSync(inPath)) {
                  const microWatts = parseInt(fs.readFileSync(inPath, "utf8").trim(), 10);
                  if (!isNaN(microWatts) && microWatts >= 0) {
                    return microWatts / 1e6;
                  }
                }
              }
            }
            return 0;
          };

          const host = readWatt("dc_input") || readWatt("sys_total");
          const gpu = readWatt("gpu");
          const cpu = readWatt("cpu_p") + readWatt("cpu_e");
          if (host > 0 || gpu > 0) {
            const idleBaseline = Math.max(0, host - gpu - cpu);
            return {
              gpuWatts: Number(gpu.toFixed(2)),
              cpuWatts: Number(cpu.toFixed(2)),
              idleBaselineWatts: Number(idleBaseline.toFixed(2)),
              hostWatts: Number((host > 0 ? host : gpu + cpu + idleBaseline).toFixed(2)),
            };
          }
        }
      }
    } catch {
      // Fallback if hwmon sysfs is not accessible or not running on Linux
    }
    return null;
  }

  /**
   * Fetches the live physical telemetry, preferring native SPBM hwmon sensors
   * and falling back to the Aitra aggregation metrics endpoint (:18083/metrics).
   */
  async fetchLiveTelemetry(modelId?: string): Promise<LiveTelemetrySample | null> {
    const hwmonSample = this.readSpbmHwmon();
    if (hwmonSample !== null) {
      return hwmonSample;
    }

    try {
      const resp = await fetch(this.metricsUrl);
      if (!resp.ok) return null;
      const text = await resp.text();
      const lines = text.split("\n");
      let gpuWatts: number | null = null;
      for (const line of lines) {
        if (!line.startsWith("aitra_gpu_power_watts")) continue;
        if (modelId && line.includes(`gpu_id="${modelId}"`)) {
          const parts = line.trim().split(/\s+/);
          const val = parseFloat(parts[parts.length - 1]);
          if (!isNaN(val) && val >= 0) {
            gpuWatts = val;
            break;
          }
        } else if (!modelId) {
          const parts = line.trim().split(/\s+/);
          const val = parseFloat(parts[parts.length - 1]);
          if (!isNaN(val) && val >= 0) {
            gpuWatts = val;
            break;
          }
        }
      }

      if (gpuWatts !== null) {
        return {
          gpuWatts: Number(gpuWatts.toFixed(2)),
          cpuWatts: 0,
          idleBaselineWatts: 0,
          hostWatts: Number(gpuWatts.toFixed(2)),
        };
      }
    } catch {
      // Silently ignore scrape errors
    }
    return null;
  }

  /**
   * Invoked on Pi session turn_start to lock SPBM resting baseline and PID ticks.
   */
  async onTurnStart(taskId: string, pid: number): Promise<void> {
    if (this.cpuSource) {
      await this.cpuSource.sampleTurnStart(taskId, pid);
    }
  }

  /**
   * Invoked on Pi session turn_end to perform baseline deduction and CPU delta attribution.
   */
  async onTurnEnd(taskId: string): Promise<number> {
    let turnJoules = 0;
    if (this.cpuSource) {
      turnJoules = await this.cpuSource.sampleTurnEnd(taskId);
    }
    const current = this.accumulatedCpuJoules.get(taskId) ?? 0;
    const updated = current + turnJoules;
    this.accumulatedCpuJoules.set(taskId, updated);
    return turnJoules;
  }

  /**
   * Settle final energy bill by joining METER-001 CPU delta and GW-001 GPU token billing.
   * If the task's GPU energy is provisional or zero due to telemetry window lag,
   * performs deferred reconciliation against the aggregation service.
   */
  async settleTask(
    taskId: string,
    durationSeconds: number
  ): Promise<Extract<PiStreamEvent, { type: "settled" }>> {
    const agentCpuJoules = this.accumulatedCpuJoules.get(taskId) ?? 0;
    let modelGpuJoules = 0;
    let outputTokens = 0;
    let provisional = false;
    let reconciled = false;

    try {
      const resp = await fetch(`${this.gatewayBaseUrl}/tasks/${taskId}`);
      if (resp.ok) {
        const bill = (await resp.json()) as TaskGatewayBillResponse;
        modelGpuJoules = bill.gpu_joules ?? 0;
        outputTokens = bill.output_tokens ?? 0;
        provisional = Boolean(bill.provisional);
      }
    } catch {
      // If gateway is not reachable, fallback to 0 model energy without throwing
      modelGpuJoules = 0;
      outputTokens = 0;
    }

    // Approach 1: Deferred Reconciliation
    if (outputTokens > 0 && (modelGpuJoules === 0 || provisional)) {
      const deadline = Date.now() + this.reconciliationTimeoutMs;
      while (Date.now() < deadline) {
        const liveJpt = await this.fetchJptFromMetrics();
        if (liveJpt !== null && liveJpt > 0) {
          modelGpuJoules = outputTokens * liveJpt;
          reconciled = true;
          provisional = false;
          break;
        }
        await new Promise((res) => setTimeout(res, this.reconciliationPollIntervalMs));
      }
    }

    const totalJoules = agentCpuJoules + modelGpuJoules;
    const systemJpt = outputTokens > 0 ? totalJoules / outputTokens : 0;

    return {
      type: "settled",
      taskId,
      durationSeconds,
      energy: {
        agentCpuJoules,
        modelGpuJoules,
        totalJoules,
        systemJpt,
        outputTokens,
        reconciled,
        provisional,
      },
    };
  }

  cleanup(taskId: string): void {
    this.accumulatedCpuJoules.delete(taskId);
  }
}
