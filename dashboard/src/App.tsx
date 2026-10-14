import React, { useState, useEffect } from "react";
import { Header } from "./components/Header";
import { AgentChat } from "./components/AgentChat";
import { TelemetryDashboard } from "./components/TelemetryDashboard";
import { createAgentFSM, type AgentFSM, type FSMSnapshot } from "./state/fsm";
import { createWSClient, resolveWsUrl, type WSClient } from "./services/wsClient";

export default function App() {
  const [fsm] = useState<AgentFSM>(() => createAgentFSM({ maxTelemetryPoints: 60, initialState: "DISCONNECTED" }));
  const [snapshot, setSnapshot] = useState<FSMSnapshot>(() => fsm.getSnapshot());
  const [wsClient, setWsClient] = useState<WSClient | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    const unsubscribe = fsm.subscribe((snap) => {
      setSnapshot(snap);
    });

    const client = createWSClient({
      fsm,
      autoConnect: true,
    });
    setWsClient(client);

    const checkInterval = setInterval(() => {
      setWsConnected(client.isConnected());
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(checkInterval);
      client.disconnect();
    };
  }, [fsm]);

  const handleRunTask = (promptText: string) => {
    const taskId = `task-${Math.random().toString(36).substring(2, 7)}`;

    // Zero-Mock Invariant: Synthetic telemetry or fake execution loops are strictly banned.
    // If upstream gateway is offline, fail fast loudly at the system boundary.
    if (!wsClient || !wsClient.isConnected()) {
      const endpoint = resolveWsUrl();
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "error",
          message:
            `[Contract Guard · Zero-Mock Policy] Backend telemetry service (${endpoint}) is currently offline. In accordance with zero-mock invariants, synthetic fallback data is strictly prohibited. Please start the backend runner service and reconnect.`,
        },
      });
      return;
    }

    wsClient.runTask(promptText, taskId);
  };

  const handleReset = () => {
    fsm.send({ type: "RESET" });
  };

  const handleToggleWs = () => {
    if (wsClient?.isConnected()) {
      wsClient.disconnect();
      setWsConnected(false);
    } else {
      wsClient?.connect();
    }
  };

  const targetNode = typeof window !== "undefined" && window.location ? window.location.host : "127.0.0.1:8000";

  return (
    <div className="app-root">
      <Header
        wsConnected={wsConnected}
        onToggleWs={handleToggleWs}
        onReset={handleReset}
        status={snapshot.state}
        targetNode={targetNode}
      />

      <div className="workspace-grid">
        <AgentChat
          prompt={snapshot.prompt}
          events={snapshot.events}
          status={snapshot.state}
          errorMessage={snapshot.errorMessage}
          onRun={handleRunTask}
        />

        <TelemetryDashboard
          latestTelemetry={snapshot.latestTelemetry}
          telemetryRingBuffer={snapshot.telemetryRingBuffer}
          settledBill={snapshot.settledBill}
          status={snapshot.state}
        />
      </div>
    </div>
  );
}
