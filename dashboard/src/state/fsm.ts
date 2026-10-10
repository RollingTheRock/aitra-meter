import {
  type ClientEvent,
  type TelemetryTick,
  type TaskSettledBill,
  ClientEventSchema,
} from "../contracts/schemas";

export type { TelemetryTick, TaskSettledBill };

export type AgentState =
  | "DISCONNECTED"
  | "IDLE"
  | "SUBMITTING"
  | "STREAMING_ACTIVE"
  | "SETTLED"
  | "ERROR";

export interface FSMSnapshot {
  state: AgentState;
  currentTaskId: string | null;
  prompt: string | null;
  events: ClientEvent[];
  telemetryRingBuffer: TelemetryTick[];
  latestTelemetry: TelemetryTick | null;
  settledBill: TaskSettledBill | null;
  errorMessage: string | null;
}

export type FSMAction =
  | { type: "WS_CONNECTED" }
  | { type: "WS_DISCONNECTED" }
  | { type: "RUN_TASK"; taskId: string; prompt: string }
  | { type: "CLIENT_EVENT"; event: ClientEvent | unknown }
  | { type: "RESET" }
  | { type: "ACK_ERROR" };

export interface FSMOptions {
  maxTelemetryPoints?: number;
  initialState?: AgentState;
}

export interface AgentFSM {
  getState: () => AgentState;
  getSnapshot: () => FSMSnapshot;
  send: (action: FSMAction) => void;
  subscribe: (listener: (snapshot: FSMSnapshot) => void) => () => void;
}

/**
 * Creates a pure logic state machine managing the Agent conversation lifecycle,
 * telemetry ring buffer, and billing settlement.
 */
export function createAgentFSM(options?: FSMOptions): AgentFSM {
  const maxTelemetryPoints = options?.maxTelemetryPoints ?? 60;
  let state: AgentState = options?.initialState ?? "DISCONNECTED";

  let currentTaskId: string | null = null;
  let prompt: string | null = null;
  let events: ClientEvent[] = [];
  let telemetryRingBuffer: TelemetryTick[] = [];
  let latestTelemetry: TelemetryTick | null = null;
  let settledBill: TaskSettledBill | null = null;
  let errorMessage: string | null = null;

  const listeners = new Set<(snapshot: FSMSnapshot) => void>();

  function notify(): void {
    const snap = getSnapshot();
    for (const listener of listeners) {
      listener(snap);
    }
  }

  function getSnapshot(): FSMSnapshot {
    return {
      state,
      currentTaskId,
      prompt,
      events: [...events],
      telemetryRingBuffer: [...telemetryRingBuffer],
      latestTelemetry,
      settledBill,
      errorMessage,
    };
  }

  function handleClientEvent(rawEvent: unknown): void {
    // Validate with Zod schema contract
    const parsedEvent = ClientEventSchema.safeParse(rawEvent);
    if (!parsedEvent.success) {
      console.warn("Dropped invalid client event frame:", rawEvent, parsedEvent.error);
      return;
    }

    const event = parsedEvent.data;

    // Handle generic error event across any state
    if (event.type === "error") {
      state = "ERROR";
      errorMessage = event.message;
      events.push(event);
      notify();
      return;
    }

    switch (state) {
      case "SUBMITTING": {
        if (event.type === "session_start") {
          state = "STREAMING_ACTIVE";
          currentTaskId = event.taskId;
          events.push(event);
          notify();
        }
        break;
      }

      case "STREAMING_ACTIVE": {
        if (event.type === "telemetry_tick") {
          // Push to sliding window ring buffer
          telemetryRingBuffer.push(event);
          if (telemetryRingBuffer.length > maxTelemetryPoints) {
            telemetryRingBuffer.shift();
          }
          latestTelemetry = event;
          notify();
        } else if (event.type === "settled") {
          state = "SETTLED";
          settledBill = event;
          events.push(event);
          notify();
        } else {
          // thought, tool_call, tool_result, message
          events.push(event);
          notify();
        }
        break;
      }

      default:
        // Ignore unhandled events in other states
        break;
    }
  }

  function send(action: FSMAction): void {
    switch (action.type) {
      case "WS_CONNECTED": {
        if (state === "DISCONNECTED") {
          state = "IDLE";
          notify();
        }
        break;
      }

      case "WS_DISCONNECTED": {
        state = "DISCONNECTED";
        notify();
        break;
      }

      case "RUN_TASK": {
        if (state === "IDLE") {
          state = "SUBMITTING";
          currentTaskId = action.taskId;
          prompt = action.prompt;
          events = [];
          telemetryRingBuffer = [];
          latestTelemetry = null;
          settledBill = null;
          errorMessage = null;
          notify();
        }
        break;
      }

      case "CLIENT_EVENT": {
        handleClientEvent(action.event);
        break;
      }

      case "RESET": {
        if (state === "SETTLED" || state === "ERROR" || state === "IDLE") {
          state = "IDLE";
          currentTaskId = null;
          prompt = null;
          events = [];
          telemetryRingBuffer = [];
          latestTelemetry = null;
          settledBill = null;
          errorMessage = null;
          notify();
        }
        break;
      }

      case "ACK_ERROR": {
        if (state === "ERROR") {
          state = "IDLE";
          errorMessage = null;
          notify();
        }
        break;
      }
    }
  }

  return {
    getState: () => state,
    getSnapshot,
    send,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
