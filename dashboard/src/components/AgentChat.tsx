import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Terminal,
  ArrowRight,
  Sparkles,
  Brain,
  Cpu,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { type ClientEvent } from "../contracts/schemas";
import { AitraHeroIllustration } from "./AitraLogo";

export interface AgentChatProps {
  prompt: string | null;
  events: ClientEvent[];
  status: string;
  errorMessage?: string | null;
  onRun: (promptText: string) => void;
}

export function AgentChat({ prompt, events, status, errorMessage, onRun }: AgentChatProps) {
  // Input strictly starts empty - zero hardcoded pre-fill
  const [inputText, setInputText] = useState("");
  const [thoughtOpen, setThoughtOpen] = useState(true);
  const [toolOpen, setToolOpen] = useState(true);

  const isSubmittingOrRunning = status === "SUBMITTING" || status === "STREAMING_ACTIVE";

  const handleSend = () => {
    if (!inputText.trim() || isSubmittingOrRunning) return;
    onRun(inputText.trim());
  };

  const thoughts = events.filter((e) => e.type === "thought") as Array<{ type: "thought"; delta: string }>;
  const toolCalls = events.filter((e) => e.type === "tool_call") as Array<{
    type: "tool_call";
    tool: string;
    arguments: Record<string, any>;
  }>;
  const toolResults = events.filter((e) => e.type === "tool_result") as Array<{
    type: "tool_result";
    output: string;
    exitCode?: number;
  }>;
  const messages = events.filter((e) => e.type === "message") as Array<{ type: "message"; delta: string }>;

  const hasEvents = events.length > 0 || prompt !== null;

  return (
    <div className="workspace-col" style={{ borderRight: "1px solid var(--line)" }}>
      {/* Header Bar */}
      <div
        style={{
          padding: "16px 28px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#ffffff",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Sparkles size={16} color="var(--aitra-electric-blue)" />
          <span style={{ fontSize: "13.5px", fontWeight: 700, letterSpacing: "0.01em", color: "var(--ink)" }}>
            Agent Execution Workspace
          </span>
        </div>
        <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--ink3)" }}>
          {status === "STREAMING_ACTIVE"
            ? "Executing Task..."
            : status === "SETTLED"
            ? "Task Settled"
            : status === "SUBMITTING"
            ? "Dispatching..."
            : status === "ERROR"
            ? "Execution Interrupted"
            : "Agent Standby"}
        </span>
      </div>

      {/* Main Workspace Body */}
      <div className="workspace-col-body" style={{ padding: "28px" }}>
        {/* Fail-Fast Zero-Mock Alert Banner */}
        {errorMessage && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fca5a5",
              borderRadius: "10px",
              padding: "16px 20px",
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
              color: "#991b1b",
              boxShadow: "var(--shadow-sm)",
              marginBottom: "20px",
            }}
          >
            <AlertTriangle size={18} color="#ef4444" style={{ marginTop: "2px", flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: "13px", marginBottom: "4px" }}>
                System Boundary Guard · Zero Mock Enforced
              </div>
              <div style={{ fontSize: "12px", fontFamily: "var(--font-mono)", lineHeight: 1.6 }}>
                {errorMessage}
              </div>
            </div>
          </div>
        )}

        {!hasEvents ? (
          /* Empty State: 100% Aligned with aitra.ai Hero Section */
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "28px",
              maxWidth: "680px",
              margin: "20px auto 0",
              paddingBottom: "20px",
            }}
          >
            {/* Pill Badge */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "4px 12px",
                background: "rgba(37, 99, 235, 0.08)",
                border: "1px solid rgba(37, 99, 235, 0.2)",
                borderRadius: "999px",
                fontSize: "11px",
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: "var(--aitra-electric-blue)",
                letterSpacing: "0.06em",
                alignSelf: "flex-start",
              }}
            >
              OPEN SOURCE · SODA FOUNDATION
            </div>

            {/* Hero Heading & Authentic Owl Illustration */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "24px" }}>
              <div style={{ flex: 1 }}>
                <h1
                  style={{
                    fontSize: "36px",
                    lineHeight: 1.15,
                    fontWeight: 700,
                    letterSpacing: "-0.03em",
                    color: "var(--ink)",
                    marginBottom: "8px",
                  }}
                >
                  AI Infrastructure Intelligence,
                  <br />
                  <span style={{ color: "var(--aitra-coral)" }}>from model to facility</span>
                </h1>
                <p
                  style={{
                    fontSize: "14px",
                    lineHeight: 1.6,
                    color: "var(--ink2)",
                    marginTop: "12px",
                  }}
                >
                  Aitra is an open source project to measure, understand, and optimize how AI uses infrastructure,
                  from the model down to the facility. It starts with measurement and attribution you can trust, then
                  builds the shared standards and tools the industry needs.
                </p>
              </div>

              <div style={{ flexShrink: 0, marginTop: "6px" }}>
                <AitraHeroIllustration width={175} />
              </div>
            </div>

            {/* Quick Benchmark Prompt Templates */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <span style={{ fontSize: "11.5px", fontFamily: "var(--font-mono)", color: "var(--ink3)", fontWeight: 600 }}>
                QUICK BENCHMARK PROMPTS:
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <button
                  onClick={() =>
                    setInputText("Run concurrency unit tests with -race detector to verify time-slice attribution safety under high concurrency")
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    background: "#ffffff",
                    border: "1px solid var(--line)",
                    borderRadius: "8px",
                    fontSize: "12.5px",
                    color: "var(--ink2)",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--aitra-electric-blue)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line)")}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Cpu size={14} color="var(--aitra-electric-blue)" />
                    <span>Run concurrency test suite with -race detector</span>
                  </div>
                  <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--ink3)" }}>
                    CPU Intensive · Time-slice attribution
                  </span>
                </button>

                <button
                  onClick={() =>
                    setInputText("Execute 1,000 steps of autoregressive token generation on Transformer model to profile realtime J/token efficiency")
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    background: "#ffffff",
                    border: "1px solid var(--line)",
                    borderRadius: "8px",
                    fontSize: "12.5px",
                    color: "var(--ink2)",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--aitra-coral)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line)")}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Zap size={14} color="var(--aitra-coral)" />
                    <span>Autoregressive token generation energy profiling</span>
                  </div>
                  <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--ink3)" }}>
                    GPU Intensive · J/token trajectory
                  </span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Active Session Flow */
          <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "800px", margin: "0 auto" }}>
            {/* User Prompt */}
            {prompt && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: "6px",
                }}
              >
                <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--ink3)" }}>USER PROMPT</span>
                <div
                  style={{
                    background: "var(--aitra-indigo-deep)",
                    color: "#ffffff",
                    padding: "12px 18px",
                    borderRadius: "12px 12px 2px 12px",
                    fontSize: "13.5px",
                    lineHeight: 1.5,
                    maxWidth: "85%",
                    boxShadow: "var(--shadow-sm)",
                  }}
                >
                  {prompt}
                </div>
              </div>
            )}

            {/* Extended Thinking Accordion */}
            {thoughts.length > 0 && (
              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid var(--line)",
                  borderRadius: "10px",
                  overflow: "hidden",
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <div
                  onClick={() => setThoughtOpen(!thoughtOpen)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    background: "var(--bg-subtle)",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--ink2)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    {thoughtOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Brain size={14} color="var(--aitra-electric-blue)" />
                    <span>Extended Thinking</span>
                  </div>
                  <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--ink3)" }}>
                    {thoughts.length} Thought Steps
                  </span>
                </div>

                {thoughtOpen && (
                  <div
                    style={{
                      padding: "14px 18px",
                      fontSize: "12.5px",
                      lineHeight: 1.6,
                      color: "var(--ink2)",
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                      borderTop: "1px solid var(--line)",
                      background: "#ffffff",
                    }}
                  >
                    {thoughts.map((t) => t.delta).join("")}
                  </div>
                )}
              </div>
            )}

            {/* Tool Execution Block */}
            {toolCalls.length > 0 && (
              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid var(--line)",
                  borderRadius: "10px",
                  overflow: "hidden",
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <div
                  onClick={() => setToolOpen(!toolOpen)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    background: "var(--bg-subtle)",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--ink2)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    {toolOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Terminal size={14} color="var(--aitra-coral)" />
                    <span>Tool Call: {toolCalls.map((tc) => `${tc.tool} (${tc.arguments.command || ""})`).join(", ")}</span>
                  </div>
                  {(() => {
                    if (toolResults.length === 0) {
                      return (
                        <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--aitra-amber)" }}>
                          running
                        </span>
                      );
                    }
                    const hasError = toolResults.some((tr) => tr.exitCode !== undefined && tr.exitCode !== 0);
                    const lastExit = toolResults[toolResults.length - 1].exitCode ?? 0;
                    return (
                      <span
                        style={{
                          fontSize: "11px",
                          fontFamily: "var(--font-mono)",
                          color: hasError ? "#ef4444" : "var(--aitra-emerald)",
                        }}
                      >
                        {hasError ? `exit ${lastExit}` : "exit 0"}
                      </span>
                    );
                  })()}
                </div>

                {toolOpen && (
                  <div
                    style={{
                      padding: "14px 18px",
                      background: "#0f172a",
                      color: "#f8fafc",
                      fontSize: "12px",
                      lineHeight: 1.5,
                      fontFamily: "var(--font-mono)",
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {toolResults.length > 0
                      ? toolResults.map((tr, idx) => <div key={idx}>{tr.output}</div>)
                      : "Executing tool command..."}
                  </div>
                )}
              </div>
            )}

            {/* Final Agent Message */}
            {messages.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: "6px",
                }}
              >
                <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--ink3)" }}>
                  AGENT RESPONSE
                </span>
                <div
                  style={{
                    background: "#ffffff",
                    border: "1px solid var(--line)",
                    borderRadius: "12px 12px 12px 2px",
                    padding: "16px 20px",
                    fontSize: "13.5px",
                    lineHeight: 1.6,
                    color: "var(--ink)",
                    boxShadow: "var(--shadow-card)",
                    maxWidth: "92%",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {messages.map((m) => m.delta).join("")}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sticky Input Dock */}
      <div className="chat-input-dock">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            disabled={isSubmittingOrRunning}
            placeholder="Enter agent task instructions (e.g. Profile memory bandwidth and energy attribution)..."
            style={{
              flex: 1,
              background: "#ffffff",
              border: "1px solid var(--line-strong)",
              borderRadius: "8px",
              padding: "12px 16px",
              fontSize: "13.5px",
              color: "var(--ink)",
              outline: "none",
              boxShadow: "var(--shadow-sm)",
            }}
          />

          <button
            onClick={handleSend}
            disabled={isSubmittingOrRunning || !inputText.trim()}
            style={{
              background: "var(--btn-primary-bg)",
              color: "#ffffff",
              border: "none",
              borderRadius: "8px",
              padding: "12px 22px",
              fontSize: "13.5px",
              fontWeight: 600,
              cursor: isSubmittingOrRunning || !inputText.trim() ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              opacity: isSubmittingOrRunning || !inputText.trim() ? 0.6 : 1,
              boxShadow: "var(--shadow-sm)",
              transition: "all 0.15s ease",
              flexShrink: 0,
            }}
          >
            <span>{isSubmittingOrRunning ? "Executing..." : "Run Task"}</span>
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
