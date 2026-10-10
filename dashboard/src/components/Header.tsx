import React from "react";
import { AitraBrandHeader } from "./AitraLogo";
import { Server, Wifi, WifiOff, RotateCcw } from "lucide-react";

export interface HeaderProps {
  wsConnected: boolean;
  onToggleWs: () => void;
  onReset: () => void;
  status: string;
}

export function Header({ wsConnected, onToggleWs, onReset, status }: HeaderProps) {
  return (
    <header
      style={{
        width: "100%",
        background: "#ffffff",
        borderBottom: "1px solid var(--line)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          maxWidth: "1680px",
          margin: "0 auto",
          padding: "14px 32px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Left: Authentic Aitra Brand Logo & Navigation */}
        <div style={{ display: "flex", alignItems: "center", gap: "28px" }}>
          <AitraBrandHeader />

          <nav
            style={{
              display: "flex",
              alignItems: "center",
              gap: "22px",
              fontSize: "13.5px",
              fontWeight: 500,
              color: "var(--ink2)",
            }}
          >
            <a
              href="https://github.com/aitra-ai/aitra-meter/tree/main/docs"
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              Docs
            </a>
            <a
              href="https://github.com/aitra-ai/aitra-meter/releases"
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              Download
            </a>
            <a
              href="https://meter.aitra.ai"
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              Benchmark
            </a>
            <span
              style={{
                fontSize: "11px",
                padding: "2px 8px",
                background: "rgba(37, 99, 235, 0.08)",
                color: "var(--aitra-electric-blue)",
                borderRadius: "4px",
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
              }}
            >
              Agent Control Panel
            </span>
          </nav>
        </div>

        {/* Right: Dynamic System Status Indicators (Zero Chinese, Zero Fake Badges) */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {/* Target Node Indicator */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              fontFamily: "var(--font-mono)",
              color: "var(--ink2)",
              padding: "5px 12px",
              background: "var(--bg-subtle)",
              borderRadius: "6px",
              border: "1px solid var(--line)",
            }}
          >
            <Server size={13} color="var(--aitra-electric-blue)" />
            <span>Target Node: {wsConnected ? "127.0.0.1:8000" : "Standalone"}</span>
          </div>

          {/* FSM Status Indicator */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              fontFamily: "var(--font-mono)",
              color: "var(--ink2)",
              padding: "5px 12px",
              background: "var(--bg-subtle)",
              borderRadius: "6px",
              border: "1px solid var(--line)",
            }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background:
                  status === "STREAMING_ACTIVE"
                    ? "var(--aitra-coral)"
                    : status === "SETTLED"
                    ? "var(--aitra-emerald)"
                    : status === "SUBMITTING"
                    ? "var(--aitra-amber)"
                    : status === "ERROR"
                    ? "#ef4444"
                    : "var(--ink3)",
              }}
            />
            <span>Status: {status}</span>
          </div>

          {/* WebSocket Connection Toggle */}
          <button
            onClick={onToggleWs}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              fontFamily: "var(--font-mono)",
              color: "var(--ink2)",
              padding: "5px 12px",
              background: "var(--bg-subtle)",
              borderRadius: "6px",
              border: "1px solid var(--line)",
              cursor: "pointer",
            }}
            title="Toggle WebSocket Connection"
          >
            {wsConnected ? <Wifi size={13} color="var(--aitra-emerald)" /> : <WifiOff size={13} color="var(--ink3)" />}
            <span>{wsConnected ? "WS Online" : "WS Standby"}</span>
          </button>

          {/* Session Reset Button */}
          <button
            onClick={onReset}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "12px",
              fontFamily: "var(--font-mono)",
              color: "var(--ink2)",
              padding: "5px 12px",
              background: "var(--bg-subtle)",
              borderRadius: "6px",
              border: "1px solid var(--line)",
              cursor: "pointer",
            }}
            title="Reset Control Panel State Machine"
          >
            <RotateCcw size={12} />
            <span>Reset</span>
          </button>
        </div>
      </div>
    </header>
  );
}
