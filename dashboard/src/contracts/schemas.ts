import { z } from "zod";

// 1. Realtime energy & power telemetry tick contract (CPU / GPU / Whole Host / Baseline)
export const TelemetryTickSchema = z.object({
  type: z.literal("telemetry_tick"),
  timestamp: z.number(),
  gpuWatts: z.number().nonnegative(),
  cpuWatts: z.number().nonnegative(), // CPU active net wattage (noise-deducted)
  idleBaselineWatts: z.number().nonnegative(), // Hardware physical idle baseline floor
  hostWatts: z.number().nonnegative().optional(), // Whole-host realtime power (CPU+GPU+Baseline)
});

export type TelemetryTick = z.infer<typeof TelemetryTickSchema>;

// 2. Structured Task Settled Invoice Contract
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
    agentCpuJoules: z.number().nonnegative(), // Attributed CPU active energy (noise-deducted)
    modelGpuJoules: z.number().nonnegative(), // SGLang / inference GPU energy
    totalJoules: z.number().nonnegative(),    // Total system energy
    jPerTokenGpu: z.number().nonnegative(),   // GPU-only Joules per token
    jPerTokenSystem: z.number().nonnegative(),// Full-system Joules per token
  }),
});

export type TaskSettledBill = z.infer<typeof TaskSettledBillSchema>;

// 3. Client Event Discriminated Union Contract
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
    taskId: z.string().optional(),
    message: z.string(),
  }),
]);

export type ClientEvent = z.infer<typeof ClientEventSchema>;
