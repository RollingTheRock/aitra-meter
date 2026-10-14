import { z } from "zod";

export const PiStreamEventSchema = z.discriminatedUnion("type", [
  // 1. 任务开始
  z.object({
    type: z.literal("session_start"),
    taskId: z.string(),
    workspace: z.string(),
  }),
  // 2. 流式思考块 (Thinking / Reasoning)
  z.object({
    type: z.literal("thought"),
    taskId: z.string(),
    delta: z.string(),
  }),
  // 3. 工具调用发起 (Tool Call)
  z.object({
    type: z.literal("tool_call"),
    taskId: z.string(),
    callId: z.string(),
    tool: z.string(), // e.g. "bash", "edit", "read"
    arguments: z.record(z.any()),
  }),
  // 4. 工具调用返回 (Tool Result)
  z.object({
    type: z.literal("tool_result"),
    taskId: z.string(),
    callId: z.string(),
    output: z.string(),
    exitCode: z.number().optional(),
  }),
  // 5. 最终回复文本 (Assistant Message)
  z.object({
    type: z.literal("message"),
    taskId: z.string(),
    delta: z.string(),
  }),
  // 6. 实时遥测心跳 (Realtime Telemetry Tick)
  z.object({
    type: z.literal("telemetry_tick"),
    timestamp: z.number(),
    gpuWatts: z.number().nonnegative(),
    cpuWatts: z.number().nonnegative(),
    idleBaselineWatts: z.number().nonnegative(),
    hostWatts: z.number().nonnegative().optional(),
  }),
  // 7. 任务能耗结算大账单 (Task Settled)
  z.object({
    type: z.literal("settled"),
    taskId: z.string(),
    durationSeconds: z.number(),
    energy: z.object({
      agentCpuJoules: z.number(), // METER-001 扣底噪
      modelGpuJoules: z.number(), // GW-001 SGLang 能耗
      totalJoules: z.number(),
      systemJpt: z.number(),
      outputTokens: z.number(),
      reconciled: z.boolean().optional(),
      provisional: z.boolean().optional(),
    }),
  }),
  // 8. 运行时异常通知 (Error Event)
  z.object({
    type: z.literal("error"),
    taskId: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
]);

export const TelemetryTickSchema = z.object({
  type: z.literal("telemetry_tick"),
  timestamp: z.number(),
  gpuWatts: z.number().nonnegative(),
  cpuWatts: z.number().nonnegative(),
  idleBaselineWatts: z.number().nonnegative(),
  hostWatts: z.number().nonnegative().optional(),
});

export type TelemetryTick = z.infer<typeof TelemetryTickSchema>;
export type PiStreamEvent = z.infer<typeof PiStreamEventSchema>;
