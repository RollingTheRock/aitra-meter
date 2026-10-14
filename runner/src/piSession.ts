import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { PiStreamEvent } from "./contracts.js";
import { prepareEnvironment } from "./piEnvironment.js";
import { MeterBridge } from "./meterBridge.js";

export interface CreatePiSessionOptions {
  taskId: string;
  gatewayBaseUrl?: string;
  baseDir?: string;
  meterBridge?: MeterBridge;
  onEvent?: (event: PiStreamEvent) => void;
  modelId?: string;
  tools?: string[];
}

export interface PiSessionInstance {
  taskId: string;
  workspaceDir: string;
  homeDir: string;
  env: Record<string, string>;
  providerBaseUrl: string;
  prompt: (text: string) => Promise<void>;
  dispose: () => void;
}

/**
 * Creates and supervises an isolated Pi AgentSession bounded to task-gateway.
 */
export async function createPiSession(
  options: CreatePiSessionOptions
): Promise<PiSessionInstance> {
  const { taskId, onEvent } = options;
  const gatewayBaseUrl = options.gatewayBaseUrl ?? "http://127.0.0.1:8090";
  const meterBridge = options.meterBridge;

  // 1. Prepare sandboxed environment layout
  const envLayout = await prepareEnvironment(taskId, { baseDir: options.baseDir });
  const providerBaseUrl = `${gatewayBaseUrl}/t/${taskId}/v1`;

  // 2. Configure ModelRuntime with aitra provider bound to task-gateway
  const modelRuntime = await ModelRuntime.create();
  modelRuntime.registerProvider("aitra", {
    name: "aitra",
    baseUrl: providerBaseUrl,
    apiKey: "none",
    api: "openai-completions",
    models: [
      {
        id: options.modelId ?? "default",
        name: "Aitra SGLang Model",
        type: "chat",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });

  const model = modelRuntime.getModel("aitra", options.modelId ?? "default");
  if (!model) {
    throw new Error(`Failed to resolve aitra model for task ${taskId}`);
  }

  // 3. Create Pi native AgentSession
  const sessionManager = SessionManager.inMemory(envLayout.workspaceDir);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const defaultTools =
    process.env.AITRA_ALLOW_BASH === "true"
      ? ["read", "bash", "edit", "write"]
      : ["read", "edit", "write"];
  const activeTools = options.tools ?? defaultTools;

  const { session } = await createAgentSession({
    cwd: envLayout.workspaceDir,
    agentDir: envLayout.homeDir,
    model,
    modelRuntime,
    sessionManager,
    settingsManager,
    tools: activeTools,
  });

  const startTime = Date.now();

  // 4. Emit session_start
  onEvent?.({
    type: "session_start",
    taskId,
    workspace: envLayout.workspaceDir,
  });

  // 5. Wire native session event subscription to PiStreamEventSchema
  const unsubscribe = session.subscribe(async (event) => {
    switch (event.type) {
      case "turn_start": {
        if (meterBridge) {
          await meterBridge.onTurnStart(taskId, process.pid);
        }
        break;
      }
      case "message_update": {
        const subEvent = event.assistantMessageEvent;
        if (subEvent.type === "thinking_delta") {
          onEvent?.({
            type: "thought",
            taskId,
            delta: subEvent.delta,
          });
        } else if (subEvent.type === "text_delta") {
          onEvent?.({
            type: "message",
            taskId,
            delta: subEvent.delta,
          });
        }
        break;
      }
      case "tool_execution_start": {
        onEvent?.({
          type: "tool_call",
          taskId,
          callId: event.toolCallId,
          tool: event.toolName,
          arguments: event.args ?? {},
        });
        break;
      }
      case "tool_execution_end": {
        let outputStr = "";
        if (typeof event.result === "string") {
          outputStr = event.result;
        } else if (event.result && typeof event.result === "object") {
          if (Array.isArray(event.result.content)) {
            outputStr = event.result.content
              .map((c: any) => c.text ?? JSON.stringify(c))
              .join("\n");
          } else {
            outputStr = JSON.stringify(event.result);
          }
        }
        onEvent?.({
          type: "tool_result",
          taskId,
          callId: event.toolCallId,
          output: outputStr,
          exitCode: event.isError ? 1 : 0,
        });
        break;
      }
      case "turn_end": {
        if (meterBridge) {
          await meterBridge.onTurnEnd(taskId);
        }
        break;
      }
      case "agent_end": {
        if (meterBridge) {
          const durationSec = Math.max(0.1, (Date.now() - startTime) / 1000);
          const settledBill = await meterBridge.settleTask(taskId, durationSec);
          onEvent?.(settledBill);
        }
        break;
      }
    }
  });

  return {
    taskId,
    workspaceDir: envLayout.workspaceDir,
    homeDir: envLayout.homeDir,
    env: envLayout.env,
    providerBaseUrl,
    prompt: async (text: string) => {
      await session.prompt(text);
    },
    dispose: () => {
      unsubscribe();
      session.dispose();
      meterBridge?.cleanup(taskId);
    },
  };
}
