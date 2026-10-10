import React, { useState, useEffect, useRef } from "react";
import {
  Terminal,
  Activity,
  Cpu,
  Zap,
  Play,
  RotateCcw,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Server,
  Layers,
  Sparkles,
  Gauge,
  Clock,
  Coins,
  Leaf,
  Wifi,
  WifiOff,
} from "lucide-react";
import { createAgentFSM, type AgentFSM, type FSMSnapshot } from "./state/fsm";
import { createWSClient, type WSClient } from "./services/wsClient";

// Sample telemetry wave points for initial demonstration
const INITIAL_TELEMETRY_SERIES = [
  { time: "00:01", gpu: 65, cpu: 5, host: 135, base: 65 },
  { time: "00:03", gpu: 180, cpu: 12, host: 257, base: 65 },
  { time: "00:05", gpu: 245, cpu: 14, host: 324, base: 65 },
  { time: "00:07", gpu: 230, cpu: 18, host: 313, base: 65 },
  { time: "00:09", gpu: 110, cpu: 45, host: 220, base: 65 },
  { time: "00:11", gpu: 70, cpu: 62, host: 197, base: 65 },
  { time: "00:13", gpu: 68, cpu: 58, host: 191, base: 65 },
  { time: "00:15", gpu: 195, cpu: 22, host: 282, base: 65 },
  { time: "00:17", gpu: 240, cpu: 16, host: 321, base: 65 },
  { time: "00:19", gpu: 185, cpu: 35, host: 285, base: 65 },
];

export default function App() {
  const [fsm] = useState<AgentFSM>(() => createAgentFSM({ maxTelemetryPoints: 60 }));
  const [snapshot, setSnapshot] = useState<FSMSnapshot>(() => fsm.getSnapshot());
  const [wsClient, setWsClient] = useState<WSClient | null>(null);

  const [inputPrompt, setInputPrompt] = useState(
    "针对 internal/taskmeter/proc_ticks.go 编写单元测试并验证 GB10 SPBM 底噪扣除边界条件"
  );
  const [thoughtOpen, setThoughtOpen] = useState(true);
  const [toolOpen, setToolOpen] = useState(true);
  const [chartSeries, setChartSeries] = useState(INITIAL_TELEMETRY_SERIES);

  // Subscribe to FSM updates
  useEffect(() => {
    const unsubscribe = fsm.subscribe((snap) => {
      setSnapshot(snap);
      if (snap.telemetryRingBuffer.length > 0) {
        const mapped = snap.telemetryRingBuffer.map((t, idx) => ({
          time: `+${(idx * 0.5).toFixed(1)}s`,
          gpu: t.gpuWatts,
          cpu: t.cpuWatts,
          host: t.hostWatts ?? t.gpuWatts + t.cpuWatts + t.idleBaselineWatts,
          base: t.idleBaselineWatts,
        }));
        setChartSeries(mapped);
      }
    });

    const client = createWSClient({
      fsm,
      autoConnect: false, // In standalone preview, let user connect or use simulation
    });
    setWsClient(client);

    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, [fsm]);

  // Handle task dispatch
  const handleRun = () => {
    if (!inputPrompt.trim() || snapshot.state === "SUBMITTING" || snapshot.state === "STREAMING_ACTIVE") {
      return;
    }

    const taskId = `task-${Math.random().toString(36).substring(2, 7)}`;
    fsm.send({ type: "RUN_TASK", taskId, prompt: inputPrompt });

    // Simulate standard streaming events if WS is disconnected
    simulateAgentFlow(taskId);
  };

  const handleReset = () => {
    fsm.send({ type: "RESET" });
    setChartSeries(INITIAL_TELEMETRY_SERIES);
  };

  // Local demo simulation runner (allowing immediate product inspection without backend)
  const simulateAgentFlow = (taskId: string) => {
    fsm.send({
      type: "CLIENT_EVENT",
      event: { type: "session_start", taskId, workspace: "/tmp/aitra-sandbox" },
    });

    // 1. Thinking step
    setTimeout(() => {
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "thought",
          delta:
            "正在读取 /proc/<pid>/stat 与 proc_ticks.go。\nGB10 SPBM 底噪公式: Delta E_active = max(0, Delta E_pkg - P_idle * Delta t)\n需要注入合成时间片验证单调递增性与硬件计数器翻转保护...",
        },
      });
      // Telemetry spike for GPU thinking
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "telemetry_tick",
          timestamp: Date.now(),
          gpuWatts: 242.0,
          cpuWatts: 14.5,
          idleBaselineWatts: 65.0,
          hostWatts: 321.5,
        },
      });
    }, 600);

    // 2. Tool call step
    setTimeout(() => {
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "tool_call",
          tool: "bash",
          arguments: { command: "go test -v -race ./internal/taskmeter/..." },
        },
      });
      // Telemetry spike for CPU compilation
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "telemetry_tick",
          timestamp: Date.now(),
          gpuWatts: 72.0,
          cpuWatts: 68.2,
          idleBaselineWatts: 65.0,
          hostWatts: 205.2,
        },
      });
    }, 1500);

    // 3. Tool result step
    setTimeout(() => {
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "tool_result",
          output:
            "=== RUN   TestHostAttribution_NoiseDeduction\n--- PASS: TestHostAttribution_NoiseDeduction (0.05s)\n=== RUN   TestProcTicks_RecursiveSubtree\n--- PASS: TestProcTicks_RecursiveSubtree (0.02s)\nPASS\nok  \tgithub.com/aitra-ai/aitra-meter/internal/taskmeter\t0.118s",
          exitCode: 0,
        },
      });
    }, 2400);

    // 4. Final message
    setTimeout(() => {
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "message",
          delta:
            "已为 `proc_ticks.go` 补齐递归子进程树活跃时间片汇总单测，并验证了零除保护与低功耗截断边界，端到端测试均在 GB10 真实硬件上通过（-race 全绿）。",
        },
      });
    }, 3100);

    // 5. Settled bill
    setTimeout(() => {
      fsm.send({
        type: "CLIENT_EVENT",
        event: {
          type: "settled",
          taskId,
          durationSeconds: 14.8,
          tokens: {
            promptTokens: 142,
            outputTokens: 486,
            tps: 32.8,
          },
          energy: {
            agentCpuJoules: 580.4,
            modelGpuJoules: 2840.0,
            totalJoules: 3420.4,
            jPerTokenGpu: 3.53,
            jPerTokenSystem: 4.25,
          },
        },
      });
    }, 3800);
  };

  // Extract latest metrics
  const latest = chartSeries[chartSeries.length - 1] || { gpu: 185.2, cpu: 35.2, host: 285.4, base: 65.0 };
  const isSettled = snapshot.state === "SETTLED" || snapshot.settledBill !== null;
  const bill = snapshot.settledBill;

  // Calculate live power split percentages
  const totalW = Math.max(1, latest.host);
  const gpuPct = Math.round((latest.gpu / totalW) * 100);
  const cpuPct = Math.round((latest.cpu / totalW) * 100);
  const basePct = Math.max(0, 100 - gpuPct - cpuPct);

  return (
    <div className="app-container">
      {/* 顶部 Aitra 官方导航栏 */}
      <header className="top-header">
        <div className="brand-section">
          <a href="https://aitra.ai" target="_blank" rel="noreferrer" className="brand-logo">
            <svg width="24" height="24" viewBox="0 0 100 100">
              <rect width="100" height="100" rx="20" fill="#312E81" />
              <circle cx="50" cy="50" r="24" fill="#FF6B4D" />
              <path d="M30 50h40M50 30v40" stroke="#2563EB" strokeWidth="6" />
            </svg>
            <span>Aitra Meter</span>
          </a>
          <span className="brand-badge">Agent Control Panel</span>
        </div>

        <div className="system-status-pills">
          <div className="status-pill">
            <Server size={13} color="#2563EB" />
            <span>NVIDIA GB10 SPBM · Qwen-32B</span>
          </div>

          <div className="status-pill">
            <div className={`status-dot ${snapshot.state === "STREAMING_ACTIVE" ? "active" : ""}`} />
            <span>Status: {snapshot.state}</span>
          </div>

          <button
            onClick={() => {
              if (wsClient?.isConnected()) {
                wsClient.disconnect();
              } else {
                wsClient?.connect();
              }
            }}
            className="status-pill"
            style={{ cursor: "pointer" }}
            title="点击切换 WebSocket 真实连接 / 离线模式"
          >
            {wsClient?.isConnected() ? <Wifi size={13} color="#10B981" /> : <WifiOff size={13} color="#7A7A82" />}
            <span>{wsClient?.isConnected() ? "WS Connected (:8000)" : "WS Standalone"}</span>
          </button>

          <button onClick={handleReset} className="status-pill" style={{ cursor: "pointer" }} title="重置状态机">
            <RotateCcw size={13} />
            <span>Reset</span>
          </button>
        </div>
      </header>

      {/* 主工作区：左侧对话 + 右侧能耗遥测与图表 */}
      <main className="main-workspace">
        {/* ▌ 左侧：标准网页 Agent 对话交互区 */}
        <section className="left-pane">
          <div className="pane-header">
            <div className="pane-title">
              <Terminal size={15} color="#2563EB" />
              <span>Pi Agent Workspace · Task Session</span>
            </div>
            {snapshot.currentTaskId && (
              <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--ink2)" }}>
                ID: {snapshot.currentTaskId}
              </span>
            )}
          </div>

          <div className="conversation-scroll-area">
            {/* 用户消息气泡 */}
            <div className="chat-msg user">
              <div className="msg-sender">USER</div>
              <div className="user-bubble">{inputPrompt}</div>
            </div>

            {/* Agent 消息卡片 */}
            <div className="chat-msg agent">
              <div className="msg-sender">
                <Sparkles size={12} color="#FF6B4D" />
                <span>PI CODING AGENT</span>
                {snapshot.state === "STREAMING_ACTIVE" && (
                  <span style={{ color: "var(--aitra-electric-blue)", fontStyle: "italic" }}>· 执行中...</span>
                )}
              </div>

              <div className="agent-card">
                {/* 1. 流式思考过程折叠块 (Thought) */}
                <div className="thought-accordion">
                  <div className="thought-summary" onClick={() => setThoughtOpen(!thoughtOpen)}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      {thoughtOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <span>💭 思考过程 (Extended Thinking)</span>
                    </div>
                    <span style={{ fontSize: "11px", color: "var(--ink3)" }}>1.8s</span>
                  </div>
                  {thoughtOpen && (
                    <div className="thought-content">
                      正在分析 `internal/taskmeter/proc_ticks.go` 与 `host_attribution.go`...{"\n"}
                      针对 GB10 架构，物理功耗采样存在待机底噪（P_idle ≈ 65W）。{"\n"}
                      增量能耗结算公式: ΔE_active = max(0, ΔE_pkg - P_idle · Δt)。{"\n"}
                      需要构建包含休眠与突发高计算进程的测试套件，以验证零除保护与单调递增性。
                    </div>
                  )}
                </div>

                {/* 2. 工具调用终端卡片 (Tool Call & Result) */}
                <div className="tool-terminal-card">
                  <div className="tool-header" onClick={() => setToolOpen(!toolOpen)} style={{ cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      {toolOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span className="tool-name-badge">tool_call: bash</span>
                      <span style={{ color: "var(--ink3)" }}>go test -v -race ./internal/taskmeter/...</span>
                    </div>
                    <span className="exit-badge">exit 0 · 0.12s</span>
                  </div>
                  {toolOpen && (
                    <div className="tool-body">
                      {`=== RUN   TestHostAttribution_NoiseDeduction
=== RUN   TestHostAttribution_ZeroDivisionSafety
--- PASS: TestHostAttribution_NoiseDeduction (0.04s)
--- PASS: TestHostAttribution_ZeroDivisionSafety (0.01s)
=== RUN   TestProcTicks_RecursiveSubtree
--- PASS: TestProcTicks_RecursiveSubtree (0.03s)
PASS
ok  \tgithub.com/aitra-ai/aitra-meter/internal/taskmeter\t0.118s`}
                    </div>
                  )}
                </div>

                {/* 3. 最终回复文本 (Assistant Message) */}
                <div className="agent-response-text">
                  我已经根据 GB10 SPBM 底噪扣除模型为 <code>proc_ticks.go</code> 和 <code>host_attribution.go</code>{" "}
                  编写了完整的测试套件。通过构造虚拟的 <code>/proc/stat</code> 与 <code>/proc/&lt;pid&gt;/stat</code>{" "}
                  快照，成功验证了单调递增性、底噪动态扣除与边界截断，端到端测试均在真实硬件上全绿通过。
                </div>
              </div>
            </div>
          </div>

          {/* 底部 Prompt 发射台 */}
          <div className="chat-input-bar">
            <div className="preset-scenarios">
              <span style={{ fontSize: "11px", color: "var(--ink3)", fontFamily: "var(--font-mono)" }}>预设场景:</span>
              <button
                className="preset-chip"
                onClick={() => setInputPrompt("验证 GB10 SPBM CPU 底噪扣除公式与并发安全性测试")}
              >
                GB10 底噪扣除测试 (CPU 密集)
              </button>
              <button
                className="preset-chip"
                onClick={() => setInputPrompt("使用 Qwen-32B 针对任务执行一次长文本架构重构")}
              >
                长文本代码生成 (GPU 密集)
              </button>
              <button
                className="preset-chip"
                onClick={() => setInputPrompt("计算 100000 个素数并触发 SGLang 并发推理")}
              >
                端到端混合压力测试
              </button>
            </div>

            <div className="input-row">
              <input
                type="text"
                className="task-input"
                value={inputPrompt}
                onChange={(e) => setInputPrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRun()}
                disabled={snapshot.state === "SUBMITTING" || snapshot.state === "STREAMING_ACTIVE"}
                placeholder="请输入 Agent 任务指令..."
              />
              <button
                className="btn-primary"
                onClick={handleRun}
                disabled={snapshot.state === "SUBMITTING" || snapshot.state === "STREAMING_ACTIVE"}
              >
                {snapshot.state === "STREAMING_ACTIVE" ? (
                  <>
                    <Activity size={14} className="status-dot active" />
                    <span>执行中...</span>
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    <span>运行任务</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </section>

        {/* ▌ 右侧：实时能耗测算与图表面板 (对齐 meter.aitra.ai) */}
        <section className="right-pane">
          <div className="pane-header">
            <div className="pane-title">
              <Activity size={15} color="#FF6B4D" />
              <span>Realtime Energy Telemetry & Metrics</span>
            </div>
            <div style={{ display: "flex", gap: "10px", fontSize: "11px", fontFamily: "var(--font-mono)" }}>
              <span style={{ color: "var(--ink2)" }}>PUE: 1.35</span>
              <span style={{ color: "var(--aitra-emerald)" }}>CV: 1.2% (Stable)</span>
            </div>
          </div>

          <div className="telemetry-content">
            {/* 1. 核心测算指标网格 (8 宫格，涵盖 CPU、GPU、整机与 AI 能效) */}
            <div className="metrics-grid">
              {/* 整机总功率 */}
              <div className="metric-card">
                <span className="metric-category">Host System Total</span>
                <div className="metric-value-row">
                  <span className="metric-val" style={{ color: "var(--aitra-electric-blue)" }}>
                    {latest.host.toFixed(1)}
                  </span>
                  <span className="metric-unit">W</span>
                </div>
                <span className="metric-sub">整机总实时功耗</span>
              </div>

              {/* 整机总能耗 */}
              <div className="metric-card">
                <span className="metric-category">Host Total Energy</span>
                <div className="metric-value-row">
                  <span className="metric-val">
                    {bill ? bill.energy.totalJoules.toFixed(0) : "3,420"}
                  </span>
                  <span className="metric-unit">J</span>
                </div>
                <span className="metric-sub">任务窗口累计焦耳</span>
              </div>

              {/* GPU 实时功率 */}
              <div className="metric-card">
                <span className="metric-category">Model GPU Power</span>
                <div className="metric-value-row">
                  <span className="metric-val" style={{ color: "var(--aitra-coral)" }}>
                    {latest.gpu.toFixed(1)}
                  </span>
                  <span className="metric-unit">W</span>
                </div>
                <span className="metric-sub">SGLang 加速器功耗</span>
              </div>

              {/* GPU 净能耗 */}
              <div className="metric-card">
                <span className="metric-category">Model GPU Energy</span>
                <div className="metric-value-row">
                  <span className="metric-val">
                    {bill ? bill.energy.modelGpuJoules.toFixed(0) : "2,840"}
                  </span>
                  <span className="metric-unit">J</span>
                </div>
                <span className="metric-sub">纯推理消耗能量</span>
              </div>

              {/* CPU 净增活跃功率 */}
              <div className="metric-card">
                <span className="metric-category">Agent CPU (Net)</span>
                <div className="metric-value-row">
                  <span className="metric-val" style={{ color: "var(--aitra-emerald)" }}>
                    +{latest.cpu.toFixed(1)}
                  </span>
                  <span className="metric-unit">W</span>
                </div>
                <span className="metric-sub">SPBM 净增 (扣底噪)</span>
              </div>

              {/* 物理待机底噪 */}
              <div className="metric-card">
                <span className="metric-category">Idle Baseline Power</span>
                <div className="metric-value-row">
                  <span className="metric-val">{latest.base.toFixed(1)}</span>
                  <span className="metric-unit">W</span>
                </div>
                <span className="metric-sub">系统待机基准能耗</span>
              </div>

              {/* 系统黄金能效比 */}
              <div className="metric-card">
                <span className="metric-category">System J / Token</span>
                <div className="metric-value-row">
                  <span className="metric-val" style={{ color: "var(--aitra-coral)" }}>
                    {bill ? bill.energy.jPerTokenSystem.toFixed(2) : "4.25"}
                  </span>
                  <span className="metric-unit">J/tok</span>
                </div>
                <span className="metric-sub">全包每 Token 能量</span>
              </div>

              {/* 吞吐与成本 */}
              <div className="metric-card">
                <span className="metric-category">Throughput & Cost</span>
                <div className="metric-value-row">
                  <span className="metric-val">
                    {bill ? bill.tokens.tps.toFixed(1) : "34.2"}
                  </span>
                  <span className="metric-unit">tok/s</span>
                </div>
                <span className="metric-sub">$0.14 / 1M Tokens</span>
              </div>
            </div>

            {/* 2. 动态时序图表 (Power Curves: GPU, CPU Net, Host Total, Baseline) */}
            <div className="chart-box">
              <div className="chart-header">
                <div className="chart-title">
                  <Layers size={14} color="#2563EB" />
                  <span>实时功率动态波形 (Wattage Waveform)</span>
                </div>
                <div className="chart-legend">
                  <div className="legend-item">
                    <div className="legend-dot" style={{ background: "var(--aitra-coral)" }} />
                    <span>GPU ({latest.gpu.toFixed(0)}W)</span>
                  </div>
                  <div className="legend-item">
                    <div className="legend-dot" style={{ background: "var(--aitra-electric-blue)" }} />
                    <span>Host ({latest.host.toFixed(0)}W)</span>
                  </div>
                  <div className="legend-item">
                    <div className="legend-dot" style={{ background: "var(--aitra-emerald)" }} />
                    <span>CPU Net (+{latest.cpu.toFixed(0)}W)</span>
                  </div>
                  <div className="legend-item">
                    <div className="legend-dot" style={{ background: "var(--ink3)" }} />
                    <span>Base (65W)</span>
                  </div>
                </div>
              </div>

              {/* 纯 SVG 动态折线图 */}
              <div className="svg-chart-container">
                <svg width="100%" height="100%" viewBox="0 0 600 180" preserveAspectRatio="none">
                  {/* 网格基线 */}
                  <line x1="0" y1="45" x2="600" y2="45" stroke="#26262A" strokeDasharray="4 4" />
                  <line x1="0" y1="90" x2="600" y2="90" stroke="#26262A" strokeDasharray="4 4" />
                  <line x1="0" y1="135" x2="600" y2="135" stroke="#26262A" strokeDasharray="4 4" />

                  {/* 待机基准线 (65W 虚线) */}
                  <line x1="0" y1="145" x2="600" y2="145" stroke="#7A7A82" strokeWidth="1.5" strokeDasharray="6 4" />

                  {/* 折线路径绘制生成 */}
                  {(() => {
                    const maxW = 380;
                    const scaleY = (w: number) => 170 - (w / maxW) * 150;
                    const stepX = 600 / (chartSeries.length - 1 || 1);

                    const hostPoints = chartSeries.map((p, i) => `${i * stepX},${scaleY(p.host)}`).join(" ");
                    const gpuPoints = chartSeries.map((p, i) => `${i * stepX},${scaleY(p.gpu)}`).join(" ");
                    const cpuPoints = chartSeries.map((p, i) => `${i * stepX},${scaleY(p.cpu + p.base)}`).join(" ");

                    return (
                      <>
                        {/* Host Total Curve */}
                        <polyline fill="none" stroke="#2563EB" strokeWidth="2.5" points={hostPoints} />
                        {/* GPU Curve */}
                        <polyline fill="none" stroke="#FF6B4D" strokeWidth="2.5" points={gpuPoints} />
                        {/* CPU Curve */}
                        <polyline fill="none" stroke="#10B981" strokeWidth="1.8" points={cpuPoints} />
                      </>
                    );
                  })()}
                </svg>
              </div>

              {/* 实时功耗配比条形图 */}
              <div className="power-split-bar">
                <div className="split-labels">
                  <span>功耗配比分解</span>
                  <span>
                    GPU: {gpuPct}% · CPU 净增: {cpuPct}% · 硬件底噪: {basePct}%
                  </span>
                </div>
                <div className="stacked-bar-container">
                  <div className="bar-segment" style={{ width: `${gpuPct}%`, background: "var(--aitra-coral)" }} />
                  <div className="bar-segment" style={{ width: `${cpuPct}%`, background: "var(--aitra-emerald)" }} />
                  <div className="bar-segment" style={{ width: `${basePct}%`, background: "var(--ink3)" }} />
                </div>
              </div>
            </div>

            {/* 3. 终态账单结算卡片 (Settled Energy Invoice) */}
            <div className="settled-card">
              <div className="settled-header">
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <CheckCircle2 size={16} color="#10B981" />
                  <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--ink)" }}>
                    任务能耗结算大账单 (Task Settled Invoice)
                  </span>
                </div>
                <span className="settled-stamp">VERIFIED & ACCREDITED</span>
              </div>

              <div className="gold-stat-banner">
                <span className="gold-number">
                  {bill ? bill.energy.jPerTokenSystem.toFixed(2) : "4.25"}
                </span>
                <span className="gold-label">
                  J / Token (全包整机能效 · GB10 SPBM Hardware Attributed)
                </span>
              </div>

              <table className="settled-table">
                <tbody>
                  <tr>
                    <td style={{ color: "var(--ink2)" }}>任务生命周期 (Task Duration)</td>
                    <td>{bill ? `${bill.durationSeconds.toFixed(1)}s` : "14.8s"}</td>
                  </tr>
                  <tr>
                    <td style={{ color: "var(--ink2)" }}>Token 统计 (Prompt / Output / TPS)</td>
                    <td>
                      {bill
                        ? `${bill.tokens.promptTokens} / ${bill.tokens.outputTokens} (${bill.tokens.tps} tps)`
                        : "142 / 486 (32.8 tps)"}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: "var(--ink2)" }}>Model GPU 消耗 (SGLang Inference)</td>
                    <td style={{ color: "var(--aitra-coral)" }}>
                      {bill ? `${bill.energy.modelGpuJoules.toFixed(1)} J` : "2,840.0 J"} (
                      {bill ? bill.energy.jPerTokenGpu.toFixed(2) : "3.53"} J/tok)
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: "var(--ink2)" }}>Agent CPU 增量消耗 (已扣除底噪)</td>
                    <td style={{ color: "var(--aitra-emerald)" }}>
                      {bill ? `${bill.energy.agentCpuJoules.toFixed(1)} J` : "+580.4 J"}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: "var(--ink)", fontWeight: 700 }}>系统整机总耗能 (Total Energy)</td>
                    <td style={{ color: "var(--aitra-electric-blue)", fontWeight: 700, fontSize: "13px" }}>
                      {bill ? `${bill.energy.totalJoules.toFixed(1)} J` : "3,420.4 J"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
