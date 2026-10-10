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
// Fully aligned with RUNNER-001 (PiStreamEventSchema), GW-001 token billing, and METER-001 SPBM CPU attribution
export const TaskSettledBillSchema = z.object({
  type: z.literal("settled"),
  taskId: z.string(),
  durationSeconds: z.number().nonnegative(),
  energy: z.object({
    agentCpuJoules: z.number().nonnegative(), // METER-001 CPU active energy (noise-deducted)
    modelGpuJoules: z.number().nonnegative(), // GW-001 SGLang model GPU energy
    totalJoules: z.number().nonnegative(),    // Total system energy (CPU + GPU)
    systemJpt: z.number().nonnegative().optional(), // Whole-system Joules per token
    outputTokens: z.number().int().nonnegative().optional(), // Generated tokens
    reconciled: z.boolean().optional(),       // Deferred reconciliation flag (telemetry lag recovery)
    provisional: z.boolean().optional(),      // Provisional indicator flag
    jPerTokenGpu: z.number().nonnegative().optional(),   // Optional GPU J/token
    jPerTokenSystem: z.number().nonnegative().optional(),// Optional system J/token alias
  }),
  tokens: z
    .object({
      promptTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      tps: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type TaskSettledBill = z.infer<typeof TaskSettledBillSchema>;

// 3. Error Event Contract (supports both error and message fields from runner)
export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  taskId: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

// 4. Client Event Discriminated Union Contract
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
  ErrorEventSchema,
]);

export type ClientEvent = z.infer<typeof ClientEventSchema>;
