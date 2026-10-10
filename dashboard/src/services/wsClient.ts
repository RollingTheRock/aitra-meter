import { type AgentFSM } from "../state/fsm";
import { ClientEventSchema } from "../contracts/schemas";

export interface WSClientOptions {
  url?: string;
  fsm: AgentFSM;
  autoConnect?: boolean;
  maxReconnectAttempts?: number;
  initialReconnectDelayMs?: number;
}

export interface WSClient {
  connect: () => void;
  disconnect: () => void;
  runTask: (prompt: string, customTaskId?: string) => string;
  isConnected: () => boolean;
}

/**
 * Creates a resilient WebSocket client relaying runner events to the FSM.
 */
export function createWSClient(options: WSClientOptions): WSClient {
  const {
    fsm,
    maxReconnectAttempts = 10,
    initialReconnectDelayMs = 1000,
  } = options;

  let socket: WebSocket | null = null;
  let isIntentionallyClosed = false;
  let reconnectAttempts = 0;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  function resolveUrl(): string {
    if (options.url) return options.url;
    return "ws://127.0.0.1:8000/ws";
  }

  function connect(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    isIntentionallyClosed = false;
    const targetUrl = resolveUrl();

    try {
      socket = new WebSocket(targetUrl);

      socket.onopen = () => {
        reconnectAttempts = 0;
        fsm.send({ type: "WS_CONNECTED" });
      };

      socket.onmessage = (event) => {
        try {
          const raw = JSON.parse(event.data);
          const parsed = ClientEventSchema.safeParse(raw);
          if (parsed.success) {
            fsm.send({ type: "CLIENT_EVENT", event: parsed.data });
          } else {
            console.warn("Received uncontracted WebSocket frame:", raw, parsed.error);
          }
        } catch (err) {
          console.error("Failed to parse incoming WebSocket message:", err);
        }
      };

      socket.onclose = () => {
        fsm.send({ type: "WS_DISCONNECTED" });
        if (!isIntentionallyClosed && reconnectAttempts < maxReconnectAttempts) {
          const delay = Math.min(
            initialReconnectDelayMs * Math.pow(1.5, reconnectAttempts),
            15000
          );
          reconnectAttempts++;
          reconnectTimeout = setTimeout(() => {
            connect();
          }, delay);
        }
      };

      socket.onerror = (err) => {
        console.warn("WebSocket transport error:", err);
      };
    } catch (err) {
      console.error("Failed to construct WebSocket:", err);
      fsm.send({ type: "WS_DISCONNECTED" });
    }
  }

  function disconnect(): void {
    isIntentionallyClosed = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (socket) {
      socket.close();
      socket = null;
    }
    fsm.send({ type: "WS_DISCONNECTED" });
  }

  function runTask(prompt: string, customTaskId?: string): string {
    const taskId = customTaskId ?? `task-${Date.now().toString(36)}`;
    fsm.send({ type: "RUN_TASK", taskId, prompt });

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          action: "run",
          prompt,
          taskId,
        })
      );
    } else {
      console.warn("WebSocket not open when dispatching task; FSM moved to SUBMITTING pending connection");
    }

    return taskId;
  }

  function isConnected(): boolean {
    return socket !== null && socket.readyState === WebSocket.OPEN;
  }

  if (options.autoConnect !== false) {
    connect();
  }

  return {
    connect,
    disconnect,
    runTask,
    isConnected,
  };
}
