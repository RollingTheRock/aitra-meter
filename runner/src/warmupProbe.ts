export interface WarmupProbeOptions {
  gatewayBaseUrl?: string;
  metricsUrl?: string;
  modelId?: string;
  minTokens?: number;
  timeoutMs?: number;
}

export interface WarmupProbeResult {
  triggered: boolean;
  alreadyWarm: boolean;
  jpt?: number;
  outputTokens?: number;
}

/**
 * Checks if the telemetry window is warm (aitra_j_per_token > 0).
 * If cold, sends a lightweight completion probe (>= 30 tokens to exceed aggregation minServingTokens)
 * to prime the aggregation window and prevent cold-run JPT=0 attribution.
 */
export async function probeAndWarmup(
  options?: WarmupProbeOptions
): Promise<WarmupProbeResult> {
  const gatewayBaseUrl = options?.gatewayBaseUrl ?? "http://127.0.0.1:8090";
  const metricsUrl =
    options?.metricsUrl ??
    process.env.AITRA_METRICS_URL ??
    "http://127.0.0.1:18083/metrics";
  const modelId =
    options?.modelId ??
    process.env.AITRA_MODEL_ID ??
    "default";
  const minTokens = options?.minTokens ?? 35;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  // 1. Check if aggregation metrics already show positive J/token
  let liveJpt: number | null = null;
  try {
    const metricsResp = await fetch(metricsUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (metricsResp.ok) {
      const text = await metricsResp.text();
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line.startsWith("aitra_j_per_token")) continue;
        if (modelId && line.includes(`model="${modelId}"`)) {
          const parts = line.trim().split(/\s+/);
          const val = parseFloat(parts[parts.length - 1]);
          if (!isNaN(val) && val > 0) {
            liveJpt = val;
            break;
          }
        } else {
          const parts = line.trim().split(/\s+/);
          const val = parseFloat(parts[parts.length - 1]);
          if (!isNaN(val) && val > 0) {
            liveJpt = val;
            break;
          }
        }
      }
    }
  } catch {
    // If metrics endpoint is unreachable, proceed to probe
  }

  if (liveJpt !== null && liveJpt > 0) {
    return {
      triggered: false,
      alreadyWarm: true,
      jpt: liveJpt,
    };
  }

  // 2. Cold state: send lightweight completion request through task-gateway
  let outputTokens = 0;
  try {
    const probeUrl = `${gatewayBaseUrl}/t/probe-warmup/v1/chat/completions`;
    const resp = await fetch(probeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: "Count from 1 to 20: 1 2 3",
          },
        ],
        max_tokens: minTokens,
        stream: false,
      }),
    });

    if (resp.ok) {
      const data = (await resp.json()) as any;
      outputTokens = data.usage?.completion_tokens ?? minTokens;
    }
  } catch {
    // Probe attempt failed or timed out
  }

  return {
    triggered: true,
    alreadyWarm: false,
    outputTokens,
  };
}
