import type { PiStreamEvent } from "./contracts.js";

export interface CpuAttributionSource {
  sampleTurnStart(taskId: string, pid: number): Promise<void>;
  sampleTurnEnd(taskId: string): Promise<number>;
}

export interface MeterBridgeOptions {
  gatewayBaseUrl?: string;
  metricsUrl?: string;
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
 * Bridges Pi agent turns with METER-001 CPU host telemetry and GW-001 task-gateway token billing.
 */
export class MeterBridge {
  private readonly gatewayBaseUrl: string;
  private readonly metricsUrl: string;
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
    this.cpuSource = options?.cpuAttributionSource;
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
