import { z } from "zod";

// 1. 实时能耗与功耗 Tick 契约 (CPU / GPU / 整机 Host / Baseline)
export const TelemetryTickSchema = z.object({
  type: z.literal("telemetry_tick"),
  timestamp: z.number(),
  gpuWatts: z.number().nonnegative(),
  cpuWatts: z.number().nonnegative(), // CPU 活跃净增功率 (已扣底噪)
  idleBaselineWatts: z.number().nonnegative(), // 硬件物理底噪功率
  hostWatts: z.number().nonnegative().optional(), // 整机总实时功率 (CPU+GPU+Baseline)
});

export type TelemetryTick = z.infer<typeof TelemetryTickSchema>;

// 2. 任务最终能耗与 Token 结算账单契约 (结构化收据)
export const TaskSettledBillSchema = z.object({
  type: z.literal("settled"),
  taskId: z.string(),
  durationSeconds: z.number().positive(),
  tokens: z.object({
    promptTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    tps: z.number().nonnegative(),
  }),
  energy: z.object({
    agentCpuJoules: z.number().nonnegative(), // CPU 增量 (扣底噪)
    modelGpuJoules: z.number().nonnegative(), // SGLang GPU 消耗
    totalJoules: z.number().nonnegative(),    // CPU + GPU + 系统总能耗
    jPerTokenGpu: z.number().nonnegative(),   // 模型 GPU 纯能效
    jPerTokenSystem: z.number().nonnegative(),// 系统全包黄金能效比
  }),
});

export type TaskSettledBill = z.infer<typeof TaskSettledBillSchema>;

// 3. Pi 原生事件联合类型契约
export const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_start"),
    taskId: z.string(),
    workspace: z.string().optional(),
  }),
  z.object({
    type: z.literal("thought"),
    taskId: z.string().optional(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("tool_call"),
    taskId: z.string().optional(),
    callId: z.string().optional(),
    tool: z.string(),
    arguments: z.record(z.any()),
  }),
  z.object({
    type: z.literal("tool_result"),
    taskId: z.string().optional(),
    callId: z.string().optional(),
    output: z.string(),
    exitCode: z.number().optional(),
  }),
  z.object({
    type: z.literal("message"),
    taskId: z.string().optional(),
    delta: z.string(),
  }),
  TelemetryTickSchema,
  TaskSettledBillSchema,
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

export type ClientEvent = z.infer<typeof ClientEventSchema>;
