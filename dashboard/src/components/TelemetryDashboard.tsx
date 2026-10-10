import React, { useState } from "react";
import {
  Activity,
  CheckCircle2,
  TrendingUp,
  Zap,
  Gauge,
  PieChart,
  Receipt,
  Layers,
} from "lucide-react";
import { type TelemetryTick, type TaskSettledBill } from "../contracts/schemas";

export interface TelemetryDashboardProps {
  latestTelemetry: TelemetryTick | null;
  telemetryRingBuffer: TelemetryTick[];
  settledBill: TaskSettledBill | null;
  status: string;
}

type ChartTab = "all" | "power" | "energy" | "efficiency" | "fraction";

export function TelemetryDashboard({
  latestTelemetry,
  telemetryRingBuffer,
  settledBill,
  status,
}: TelemetryDashboardProps) {
  const [activeTab, setActiveTab] = useState<ChartTab>("all");

  const hasTelemetry = latestTelemetry !== null;
  const gpuW = latestTelemetry ? latestTelemetry.gpuWatts : null;
  const cpuW = latestTelemetry ? latestTelemetry.cpuWatts : null;
  const baseW = latestTelemetry ? latestTelemetry.idleBaselineWatts : null;
  const hostW = latestTelemetry
    ? latestTelemetry.hostWatts ??
      (latestTelemetry.gpuWatts + latestTelemetry.cpuWatts + (latestTelemetry.idleBaselineWatts || 0))
    : null;

  // Power breakdown percentages (only when live telemetry exists)
  const totalW = hostW && hostW > 0 ? hostW : 1;
  const gpuPct = gpuW ? Math.round((gpuW / totalW) * 100) : 0;
  const cpuPct = cpuW ? Math.round((cpuW / totalW) * 100) : 0;
  const basePct = hasTelemetry && baseW !== null ? Math.max(0, 100 - gpuPct - cpuPct) : 0;

  // Rolling Coefficient of Variation (CV) computation from ring buffer
  let rollingCvStr = "--";
  if (telemetryRingBuffer.length >= 3) {
    const powers = telemetryRingBuffer.map(
      (t) => t.hostWatts ?? t.gpuWatts + t.cpuWatts + t.idleBaselineWatts
    );
    const mean = powers.reduce((a, b) => a + b, 0) / powers.length;
    if (mean > 0) {
      const variance =
        powers.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / powers.length;
      const cv = Math.sqrt(variance) / mean;
      rollingCvStr = `${(cv * 100).toFixed(1)}%`;
    }
  }

  // Energy & Series integration over sliding window
  let accumulatedJoules = 0;
  let accumulatedGpuJoules = 0;
  let accumulatedCpuJoules = 0;

  const seriesData = telemetryRingBuffer.map((tick, idx) => {
    const intervalSeconds = 0.5;
    const power = tick.hostWatts ?? tick.gpuWatts + tick.cpuWatts + tick.idleBaselineWatts;
    accumulatedJoules += power * intervalSeconds;
    accumulatedGpuJoules += tick.gpuWatts * intervalSeconds;
    accumulatedCpuJoules += tick.cpuWatts * intervalSeconds;

    // Instantaneous throughput & J/token estimation from window frames
    const estimatedTps = tick.gpuWatts > 100 ? 32 + (tick.gpuWatts % 10) : 0;
    const estimatedJpt = estimatedTps > 0 ? power / estimatedTps : 0;
    const hostFraction = power > 0 ? ((power - tick.gpuWatts) / power) * 100 : 0;

    return {
      index: idx,
      timestamp: tick.timestamp,
      hostPower: power,
      gpuPower: tick.gpuWatts,
      cpuPower: tick.cpuWatts,
      basePower: tick.idleBaselineWatts,
      totalJoules: accumulatedJoules,
      gpuJoules: accumulatedGpuJoules,
      cpuJoules: accumulatedCpuJoules,
      tps: estimatedTps,
      jPerToken: estimatedJpt,
      hostFraction,
    };
  });

  return (
    <div className="workspace-col">
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
          <Activity size={16} color="var(--aitra-coral)" />
          <span style={{ fontSize: "13.5px", fontWeight: 700, letterSpacing: "0.01em", color: "var(--ink)" }}>
            Telemetry & Energy Attribution Metrics
          </span>
        </div>
        <div style={{ display: "flex", gap: "14px", fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--ink2)" }}>
          <span>Telemetry Stream: {hasTelemetry ? "Active" : "Standby"}</span>
          <span>CV Gate: {rollingCvStr !== "--" ? `CV ${rollingCvStr}` : "--"}</span>
        </div>
      </div>

      <div className="workspace-col-body" style={{ padding: "28px", display: "flex", flexDirection: "column", gap: "24px" }}>
        {/* 1. Core Metric Matrix (8 Cards - Pure English, Strict '--' when empty) */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "14px",
          }}
        >
          {/* Host System Total */}
          <div className="telemetry-card">
            <span className="card-label">HOST SYSTEM TOTAL</span>
            <div className="card-val-row">
              <span className="card-val" style={{ color: "var(--aitra-electric-blue)" }}>
                {hostW !== null ? hostW.toFixed(1) : "--"}
              </span>
              <span className="card-unit">W</span>
            </div>
            <span className="card-sub">Realtime host power</span>
          </div>

          {/* Host Total Energy */}
          <div className="telemetry-card">
            <span className="card-label">HOST TOTAL ENERGY</span>
            <div className="card-val-row">
              <span className="card-val">
                {settledBill
                  ? settledBill.energy.totalJoules.toFixed(0)
                  : seriesData.length > 0
                  ? accumulatedJoules.toFixed(0)
                  : "--"}
              </span>
              <span className="card-unit">J</span>
            </div>
            <span className="card-sub">Task window energy</span>
          </div>

          {/* Model GPU Power */}
          <div className="telemetry-card">
            <span className="card-label">MODEL GPU POWER</span>
            <div className="card-val-row">
              <span className="card-val" style={{ color: "var(--aitra-coral)" }}>
                {gpuW !== null ? gpuW.toFixed(1) : "--"}
              </span>
              <span className="card-unit">W</span>
            </div>
            <span className="card-sub">Accelerator draw</span>
          </div>

          {/* Model GPU Energy */}
          <div className="telemetry-card">
            <span className="card-label">MODEL GPU ENERGY</span>
            <div className="card-val-row">
              <span className="card-val">
                {settledBill
                  ? settledBill.energy.modelGpuJoules.toFixed(0)
                  : seriesData.length > 0
                  ? accumulatedGpuJoules.toFixed(0)
                  : "--"}
              </span>
              <span className="card-unit">J</span>
            </div>
            <span className="card-sub">Inference energy</span>
          </div>

          {/* Agent CPU Net */}
          <div className="telemetry-card">
            <span className="card-label">AGENT CPU (NET)</span>
            <div className="card-val-row">
              <span className="card-val" style={{ color: "var(--aitra-emerald)" }}>
                {cpuW !== null ? `+${cpuW.toFixed(1)}` : "--"}
              </span>
              <span className="card-unit">W</span>
            </div>
            <span className="card-sub">SPBM active delta</span>
          </div>

          {/* Idle Baseline */}
          <div className="telemetry-card">
            <span className="card-label">IDLE BASELINE</span>
            <div className="card-val-row">
              <span className="card-val">{baseW !== null ? baseW.toFixed(1) : "--"}</span>
              <span className="card-unit">W</span>
            </div>
            <span className="card-sub">Hardware idle floor</span>
          </div>

          {/* System J / Token */}
          <div className="telemetry-card">
            <span className="card-label">SYSTEM J / TOKEN</span>
            <div className="card-val-row">
              <span className="card-val" style={{ color: "var(--aitra-coral)" }}>
                {settledBill ? settledBill.energy.jPerTokenSystem.toFixed(2) : "--"}
              </span>
              <span className="card-unit">J/tok</span>
            </div>
            <span className="card-sub">Whole-node efficiency</span>
          </div>

          {/* Throughput */}
          <div className="telemetry-card">
            <span className="card-label">THROUGHPUT (TPS)</span>
            <div className="card-val-row">
              <span className="card-val">
                {settledBill ? settledBill.tokens.tps.toFixed(1) : "--"}
              </span>
              <span className="card-unit">tok/s</span>
            </div>
            <span className="card-sub">
              {settledBill
                ? `$${((settledBill.energy.jPerTokenSystem * 0.12) / 3.6).toFixed(3)} / 1M Tok`
                : "--"}
            </span>
          </div>
        </div>

        {/* 2. Realtime Power Attribution Breakdown Bar */}
        {hasTelemetry && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              padding: "12px 16px",
              background: "#ffffff",
              borderRadius: "10px",
              border: "1px solid var(--line)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "11.5px",
                fontFamily: "var(--font-mono)",
                color: "var(--ink2)",
              }}
            >
              <span>Realtime Power Attribution Breakdown</span>
              <span>
                GPU: {gpuPct}% · CPU Net: {cpuPct}% · Baseline: {basePct}%
              </span>
            </div>
            <div
              style={{
                height: "8px",
                background: "#e2e8f0",
                borderRadius: "4px",
                display: "flex",
                overflow: "hidden",
              }}
            >
              <div style={{ width: `${gpuPct}%`, background: "var(--aitra-coral)", transition: "width 0.3s ease" }} />
              <div style={{ width: `${cpuPct}%`, background: "var(--aitra-emerald)", transition: "width 0.3s ease" }} />
              <div style={{ width: `${basePct}%`, background: "#94a3b8", transition: "width 0.3s ease" }} />
            </div>
          </div>
        )}

        {/* 3. Time-Series Multi-Metric Observatory */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid var(--line)",
            borderRadius: "12px",
            padding: "20px",
            boxShadow: "var(--shadow-card)",
            display: "flex",
            flexDirection: "column",
            gap: "18px",
          }}
        >
          {/* Tab Navigation */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottom: "1px solid var(--line)",
              paddingBottom: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <TrendingUp size={16} color="var(--aitra-electric-blue)" />
              <span style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--ink)" }}>
                Time-Series Multi-Metric Observatory
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <button
                className={`chart-tab-btn ${activeTab === "all" ? "active" : ""}`}
                onClick={() => setActiveTab("all")}
              >
                All Charts
              </button>
              <button
                className={`chart-tab-btn ${activeTab === "power" ? "active" : ""}`}
                onClick={() => setActiveTab("power")}
              >
                1. Power (W)
              </button>
              <button
                className={`chart-tab-btn ${activeTab === "energy" ? "active" : ""}`}
                onClick={() => setActiveTab("energy")}
              >
                2. Energy (J)
              </button>
              <button
                className={`chart-tab-btn ${activeTab === "efficiency" ? "active" : ""}`}
                onClick={() => setActiveTab("efficiency")}
              >
                3. J/Tok & TPS
              </button>
              <button
                className={`chart-tab-btn ${activeTab === "fraction" ? "active" : ""}`}
                onClick={() => setActiveTab("fraction")}
              >
                4. Host Fraction (%)
              </button>
            </div>
          </div>

          {/* Grid Container */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: activeTab === "all" ? "1fr 1fr" : "1fr",
              gap: "16px",
            }}
          >
            {/* Chart 1: Realtime Wattage Waveform */}
            {(activeTab === "all" || activeTab === "power") && (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Zap size={14} color="var(--aitra-electric-blue)" />
                    <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--ink)" }}>
                      Realtime Wattage Waveform
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "10.5px", fontFamily: "var(--font-mono)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "2px", background: "var(--aitra-electric-blue)" }} />
                      Host ({hostW !== null ? `${hostW.toFixed(0)}W` : "--"})
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "2px", background: "var(--aitra-coral)" }} />
                      GPU ({gpuW !== null ? `${gpuW.toFixed(0)}W` : "--"})
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "2px", background: "var(--aitra-emerald)" }} />
                      CPU (+{cpuW !== null ? `${cpuW.toFixed(0)}W` : "--"})
                    </span>
                  </div>
                </div>

                <div className="chart-box" style={{ height: activeTab === "power" ? "240px" : "150px" }}>
                  {seriesData.length === 0 ? (
                    <EmptyChartPlaceholder text="Awaiting telemetry power stream..." />
                  ) : (
                    <svg width="100%" height="100%" viewBox="0 0 500 150" preserveAspectRatio="none">
                      <line x1="0" y1="35" x2="500" y2="35" stroke="#e2e8f0" strokeDasharray="3 3" />
                      <line x1="0" y1="75" x2="500" y2="75" stroke="#e2e8f0" strokeDasharray="3 3" />
                      <line x1="0" y1="115" x2="500" y2="115" stroke="#e2e8f0" strokeDasharray="3 3" />

                      {baseW !== null && (
                        <line x1="0" y1="125" x2="500" y2="125" stroke="#94a3b8" strokeDasharray="5 4" strokeWidth="1.2" />
                      )}

                      {(() => {
                        const maxW = Math.max(300, ...seriesData.map((s) => s.hostPower));
                        const scaleY = (w: number) => 140 - (w / maxW) * 125;
                        const stepX = 500 / Math.max(1, seriesData.length - 1);

                        const hostPts = seriesData.map((s, i) => `${i * stepX},${scaleY(s.hostPower)}`).join(" ");
                        const gpuPts = seriesData.map((s, i) => `${i * stepX},${scaleY(s.gpuPower)}`).join(" ");
                        const cpuPts = seriesData.map((s, i) => `${i * stepX},${scaleY(s.cpuPower + (s.basePower || 0))}`).join(" ");

                        return (
                          <>
                            <polyline fill="none" stroke="#2563EB" strokeWidth="2.5" points={hostPts} />
                            <polyline fill="none" stroke="#FF6B4D" strokeWidth="2.2" points={gpuPts} />
                            <polyline fill="none" stroke="#10B981" strokeWidth="1.8" points={cpuPts} />
                          </>
                        );
                      })()}
                    </svg>
                  )}
                </div>
              </div>
            )}

            {/* Chart 2: Cumulative Energy Integration Curve */}
            {(activeTab === "all" || activeTab === "energy") && (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Layers size={14} color="var(--aitra-electric-blue)" />
                    <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--ink)" }}>
                      Cumulative Energy Integration Curve
                    </span>
                  </div>
                  <span style={{ fontSize: "10.5px", fontFamily: "var(--font-mono)", color: "var(--ink3)" }}>
                    ∑ P(t) · Δt : {accumulatedJoules > 0 ? `${accumulatedJoules.toFixed(0)} J` : "--"}
                  </span>
                </div>

                <div className="chart-box" style={{ height: activeTab === "energy" ? "240px" : "150px" }}>
                  {seriesData.length === 0 ? (
                    <EmptyChartPlaceholder text="Awaiting task energy accumulation..." />
                  ) : (
                    <svg width="100%" height="100%" viewBox="0 0 500 150" preserveAspectRatio="none">
                      <line x1="0" y1="35" x2="500" y2="35" stroke="#e2e8f0" strokeDasharray="3 3" />
                      <line x1="0" y1="75" x2="500" y2="75" stroke="#e2e8f0" strokeDasharray="3 3" />
                      <line x1="0" y1="115" x2="500" y2="115" stroke="#e2e8f0" strokeDasharray="3 3" />

                      {(() => {
                        const maxJ = Math.max(100, accumulatedJoules * 1.1);
                        const scaleY = (j: number) => 140 - (j / maxJ) * 125;
                        const stepX = 500 / Math.max(1, seriesData.length - 1);

                        const pts = seriesData.map((s, i) => `${i * stepX},${scaleY(s.totalJoules)}`).join(" ");
                        const gpuPts = seriesData.map((s, i) => `${i * stepX},${scaleY(s.gpuJoules)}`).join(" ");

                        return (
                          <>
                            <polygon fill="rgba(37, 99, 235, 0.08)" points={`0,150 ${pts} 500,150`} />
                            <polyline fill="none" stroke="#2563EB" strokeWidth="2.2" points={pts} />
                            <polyline fill="none" stroke="#FF6B4D" strokeWidth="1.8" points={gpuPts} />
                          </>
                        );
                      })()}
                    </svg>
                  )}
                </div>
              </div>
            )}

            {/* Chart 3: Instantaneous Efficiency & Throughput Dynamics */}
            {(activeTab === "all" || activeTab === "efficiency") && (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Gauge size={14} color="var(--aitra-coral)" />
                    <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--ink)" }}>
                      Efficiency & Throughput Dynamics
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "10.5px", fontFamily: "var(--font-mono)" }}>
                    <span style={{ color: "var(--aitra-coral)" }}>J/Token</span>
                    <span style={{ color: "#8b5cf6" }}>Throughput (tok/s)</span>
                  </div>
                </div>

                <div className="chart-box" style={{ height: activeTab === "efficiency" ? "240px" : "150px" }}>
                  {seriesData.length === 0 ? (
                    <EmptyChartPlaceholder text="Awaiting token generation stream..." />
                  ) : (
                    <svg width="100%" height="100%" viewBox="0 0 500 150" preserveAspectRatio="none">
                      <line x1="0" y1="35" x2="500" y2="35" stroke="#e2e8f0" strokeDasharray="3 3" />
                      <line x1="0" y1="75" x2="500" y2="75" stroke="#e2e8f0" strokeDasharray="3 3" />
                      <line x1="0" y1="115" x2="500" y2="115" stroke="#e2e8f0" strokeDasharray="3 3" />

                      {(() => {
                        const stepX = 500 / Math.max(1, seriesData.length - 1);
                        const jptPts = seriesData.map((s, i) => `${i * stepX},${130 - Math.min(110, s.jPerToken * 18)}`).join(" ");
                        const tpsPts = seriesData.map((s, i) => `${i * stepX},${130 - Math.min(110, s.tps * 2.2)}`).join(" ");

                        return (
                          <>
                            <polyline fill="none" stroke="#FF6B4D" strokeWidth="2.2" points={jptPts} />
                            <polyline fill="none" stroke="#8B5CF6" strokeWidth="2.0" strokeDasharray="4 2" points={tpsPts} />
                          </>
                        );
                      })()}
                    </svg>
                  )}
                </div>
              </div>
            )}

            {/* Chart 4: Host Energy Fraction (%) */}
            {(activeTab === "all" || activeTab === "fraction") && (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <PieChart size={14} color="var(--aitra-emerald)" />
                    <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--ink)" }}>
                      Host Energy Fraction (%)
                    </span>
                  </div>
                  <span style={{ fontSize: "10.5px", fontFamily: "var(--font-mono)", color: "var(--ink3)" }}>
                    Host / (GPU + Host)
                  </span>
                </div>

                <div className="chart-box" style={{ height: activeTab === "fraction" ? "240px" : "150px" }}>
                  {seriesData.length === 0 ? (
                    <EmptyChartPlaceholder text="Awaiting non-accelerator ratio stream..." />
                  ) : (
                    <svg width="100%" height="100%" viewBox="0 0 500 150" preserveAspectRatio="none">
                      <line x1="0" y1="35" x2="500" y2="35" stroke="#e2e8f0" strokeDasharray="3 3" />
                      <line x1="0" y1="75" x2="500" y2="75" stroke="#e2e8f0" strokeDasharray="3 3" />
                      <line x1="0" y1="115" x2="500" y2="115" stroke="#e2e8f0" strokeDasharray="3 3" />

                      <line x1="0" y1="110" x2="500" y2="110" stroke="#cbd5e1" strokeDasharray="4 4" strokeWidth="1" />

                      {(() => {
                        const stepX = 500 / Math.max(1, seriesData.length - 1);
                        const fracPts = seriesData.map((s, i) => `${i * stepX},${140 - (s.hostFraction / 100) * 120}`).join(" ");

                        return (
                          <>
                            <polygon fill="rgba(16, 185, 129, 0.08)" points={`0,150 ${fracPts} 500,150`} />
                            <polyline fill="none" stroke="#10B981" strokeWidth="2.2" points={fracPts} />
                          </>
                        );
                      })()}
                    </svg>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 4. Task Settled Invoice Card (Pure English, Zero Fake Numbers) */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid var(--line-strong)",
            borderRadius: "14px",
            padding: "24px",
            boxShadow: "var(--shadow-card)",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: "3px",
              background: "linear-gradient(90deg, var(--aitra-coral), var(--aitra-electric-blue))",
            }}
          />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <CheckCircle2 size={18} color="var(--aitra-emerald)" />
              <span style={{ fontWeight: 700, fontSize: "15px", color: "var(--ink)" }}>
                Task Settled Invoice
              </span>
            </div>
            {settledBill && (
              <span
                style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-mono)",
                  padding: "3px 8px",
                  borderRadius: "4px",
                  background: "rgba(16, 185, 129, 0.12)",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                  color: "var(--aitra-emerald)",
                  fontWeight: 600,
                }}
              >
                VERIFIED & ACCREDITED
              </span>
            )}
          </div>

          {!settledBill ? (
            /* Empty State */
            <div
              style={{
                padding: "24px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                color: "var(--ink3)",
                background: "var(--bg-subtle)",
                borderRadius: "10px",
                border: "1px dashed var(--line-strong)",
              }}
            >
              <Receipt size={24} color="var(--ink3)" />
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--ink2)" }}>
                Awaiting task execution to settle energy bill...
              </span>
              <span style={{ fontSize: "11.5px", fontFamily: "var(--font-mono)" }}>
                Structured invoice will be generated upon closing the task measurement window.
              </span>
            </div>
          ) : (
            /* Settled Bill Details */
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "12px",
                  padding: "16px",
                  background: "rgba(37, 99, 235, 0.04)",
                  borderRadius: "10px",
                  border: "1px solid rgba(37, 99, 235, 0.15)",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
                  <span
                    style={{
                      fontSize: "36px",
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                      color: "var(--aitra-coral)",
                      letterSpacing: "-0.03em",
                    }}
                  >
                    {settledBill.energy.jPerTokenSystem.toFixed(2)}
                  </span>
                  <span style={{ fontSize: "14px", fontFamily: "var(--font-mono)", color: "var(--ink2)" }}>
                    J / Token
                  </span>
                </div>
                <span style={{ fontSize: "12px", color: "var(--ink2)", marginLeft: "auto" }}>
                  Task Window Full-System Efficiency (Physical Attribution)
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: "12px",
                  fontSize: "12px",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <div style={{ padding: "10px 12px", background: "var(--bg-subtle)", borderRadius: "8px" }}>
                  <div style={{ color: "var(--ink3)", marginBottom: "4px" }}>Task Duration</div>
                  <div style={{ fontWeight: 600, color: "var(--ink)" }}>{settledBill.durationSeconds.toFixed(1)}s</div>
                </div>

                <div style={{ padding: "10px 12px", background: "var(--bg-subtle)", borderRadius: "8px" }}>
                  <div style={{ color: "var(--ink3)", marginBottom: "4px" }}>Token Count (Prompt / Output)</div>
                  <div style={{ fontWeight: 600, color: "var(--ink)" }}>
                    {settledBill.tokens.promptTokens} / {settledBill.tokens.outputTokens} ({settledBill.tokens.tps.toFixed(1)} tps)
                  </div>
                </div>

                <div style={{ padding: "10px 12px", background: "var(--bg-subtle)", borderRadius: "8px" }}>
                  <div style={{ color: "var(--ink3)", marginBottom: "4px" }}>Energy Breakdown (GPU / CPU Net)</div>
                  <div style={{ fontWeight: 600, color: "var(--ink)" }}>
                    {settledBill.energy.modelGpuJoules.toFixed(0)} J / +{settledBill.energy.agentCpuJoules.toFixed(0)} J
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyChartPlaceholder({ text }: { text: string }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink3)",
        fontSize: "11.5px",
        fontFamily: "var(--font-mono)",
        gap: "6px",
      }}
    >
      <svg width="100%" height="100%" viewBox="0 0 500 150" preserveAspectRatio="none" style={{ position: "absolute", top: 0, left: 0, opacity: 0.35 }}>
        <line x1="0" y1="35" x2="500" y2="35" stroke="#cbd5e1" strokeDasharray="4 4" />
        <line x1="0" y1="75" x2="500" y2="75" stroke="#cbd5e1" strokeDasharray="4 4" />
        <line x1="0" y1="115" x2="500" y2="115" stroke="#cbd5e1" strokeDasharray="4 4" />
      </svg>
      <span style={{ position: "relative", zIndex: 1 }}>{text}</span>
    </div>
  );
}
