import { describe, it, expect } from "vitest";
import {
  TelemetryTickSchema,
  TaskSettledBillSchema,
  ClientEventSchema,
} from "../src/contracts/schemas";
import {
  createAgentFSM,
  type AgentState,
  type TelemetryTick,
  type TaskSettledBill,
} from "../src/state/fsm";

describe("1. Zod Data Contracts & Schemas", () => {
  it("validates valid telemetry ticks and rejects invalid watts", () => {
    const validTick = {
      type: "telemetry_tick",
      timestamp: 1728550000000,
      gpuWatts: 184.5,
      cpuWatts: 42.1,
      idleBaselineWatts: 65.0,
      hostWatts: 291.6,
    };
    const parsed = TelemetryTickSchema.parse(validTick);
    expect(parsed.gpuWatts).toBe(184.5);
    expect(parsed.cpuWatts).toBe(42.1);

    // Negative power should fail
    expect(() =>
      TelemetryTickSchema.parse({
        ...validTick,
        gpuWatts: -10,
      })
    ).toThrow();
  });

  it("validates structured task settled bill", () => {
    const validBill: TaskSettledBill = {
      type: "settled",
      taskId: "task-001",
      durationSeconds: 12.5,
      tokens: {
        promptTokens: 120,
        outputTokens: 450,
        tps: 36.0,
      },
      energy: {
        agentCpuJoules: 145.2,
        modelGpuJoules: 1680.5,
        totalJoules: 1825.7,
        jPerTokenGpu: 3.73,
        jPerTokenSystem: 4.05,
      },
    };
    const parsed = TaskSettledBillSchema.parse(validBill);
    expect(parsed.taskId).toBe("task-001");
    expect(parsed.energy.totalJoules).toBe(1825.7);

    // Non-positive duration should fail
    expect(() =>
      TaskSettledBillSchema.parse({
        ...validBill,
        durationSeconds: 0,
      })
    ).toThrow();
  });

  it("discriminates union client events", () => {
    const thoughtEvent = {
      type: "thought",
      delta: "Inspecting host attribution...",
    };
    const toolCallEvent = {
      type: "tool_call",
      tool: "bash",
      arguments: { command: "go test ./..." },
    };
    const errorEvent = {
      type: "error",
      message: "Gateway timeout",
    };

    expect(ClientEventSchema.parse(thoughtEvent).type).toBe("thought");
    expect(ClientEventSchema.parse(toolCallEvent).type).toBe("tool_call");
    expect(ClientEventSchema.parse(errorEvent).type).toBe("error");

    expect(() =>
      ClientEventSchema.parse({ type: "unknown_event_type" })
    ).toThrow();
  });
});

describe("2. Pure Logic FSM State Transitions", () => {
  it("follows the exact truth table from DISCONNECTED to SETTLED and RESET", () => {
    const fsm = createAgentFSM({ maxTelemetryPoints: 10 });
    expect(fsm.getState()).toBe("DISCONNECTED");

    // 1. Handshake success -> IDLE
    fsm.send({ type: "WS_CONNECTED" });
    expect(fsm.getState()).toBe("IDLE");

    // 2. User dispatches task -> SUBMITTING
    fsm.send({ type: "RUN_TASK", taskId: "task-abc", prompt: "Fix bug" });
    expect(fsm.getState()).toBe("SUBMITTING");
    expect(fsm.getSnapshot().currentTaskId).toBe("task-abc");

    // 3. Backend emits session_start -> STREAMING_ACTIVE
    fsm.send({
      type: "CLIENT_EVENT",
      event: { type: "session_start", taskId: "task-abc" },
    });
    expect(fsm.getState()).toBe("STREAMING_ACTIVE");

    // 4. Stream events accumulated in trace
    fsm.send({
      type: "CLIENT_EVENT",
      event: { type: "thought", delta: "Analyzing code..." },
    });
    fsm.send({
      type: "CLIENT_EVENT",
      event: {
        type: "tool_call",
        tool: "bash",
        arguments: { command: "ls" },
      },
    });
    expect(fsm.getState()).toBe("STREAMING_ACTIVE");
    expect(fsm.getSnapshot().events.length).toBe(3); // session_start + thought + tool_call

    // 5. Telemetry ticks fed into ring buffer
    for (let i = 0; i < 15; i++) {
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "telemetry_tick",
          timestamp: 1000 + i * 100,
          gpuWatts: 150 + i,
          cpuWatts: 30 + i,
          idleBaselineWatts: 60,
          hostWatts: 240 + 2 * i,
        },
      });
    }
    // State remains STREAMING_ACTIVE, buffer capped at maxTelemetryPoints (10)
    expect(fsm.getState()).toBe("STREAMING_ACTIVE");
    expect(fsm.getSnapshot().telemetryRingBuffer.length).toBe(10);
    expect(fsm.getSnapshot().latestTelemetry?.gpuWatts).toBe(164); // 150 + 14

    // 6. Task settled -> SETTLED
    const bill: TaskSettledBill = {
      type: "settled",
      taskId: "task-abc",
      durationSeconds: 5.2,
      tokens: { promptTokens: 50, outputTokens: 120, tps: 23.0 },
      energy: {
        agentCpuJoules: 120,
        modelGpuJoules: 800,
        totalJoules: 920,
        jPerTokenGpu: 6.66,
        jPerTokenSystem: 7.66,
      },
    };
    fsm.send({ type: "CLIENT_EVENT", event: bill });
    expect(fsm.getState()).toBe("SETTLED");
    expect(fsm.getSnapshot().settledBill).toEqual(bill);

    // 7. Reset -> IDLE
    fsm.send({ type: "RESET" });
    expect(fsm.getState()).toBe("IDLE");
    expect(fsm.getSnapshot().currentTaskId).toBeNull();
    expect(fsm.getSnapshot().events.length).toBe(0);
    expect(fsm.getSnapshot().telemetryRingBuffer.length).toBe(0);
  });

  it("handles error transitions and recovery", () => {
    const fsm = createAgentFSM();
    fsm.send({ type: "WS_CONNECTED" });
    fsm.send({ type: "RUN_TASK", taskId: "t-1", prompt: "Test" });
    expect(fsm.getState()).toBe("SUBMITTING");

    // Error event transitions to ERROR
    fsm.send({
      type: "CLIENT_EVENT",
      event: { type: "error", message: "Process crashed" },
    });
    expect(fsm.getState()).toBe("ERROR");
    expect(fsm.getSnapshot().errorMessage).toBe("Process crashed");

    // ACK / RECONNECT resets back to IDLE
    fsm.send({ type: "ACK_ERROR" });
    expect(fsm.getState()).toBe("IDLE");
    expect(fsm.getSnapshot().errorMessage).toBeNull();
  });
});
