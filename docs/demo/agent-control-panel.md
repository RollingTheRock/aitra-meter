# Agent Control Panel & Dual-Scope Energy Telemetry — Demo Guide

The **Agent Control Panel** demo provides an interactive demonstration of end-to-end AI agent task execution combined with **dual-scope, physical energy metering** on live hardware (GPU acceleration + Host CPU attribution with idle baseline subtraction).

Every figure in this demo is physically measured:
- **GPU Inference Energy**: Measured via DCGM energy counters, attributed to tasks via proportional token-share through the Task Gateway.
- **Agent Host CPU Energy**: Measured via NVIDIA Grace-Hopper GB10 SPBM sysfs hwmon sensors, subtracting idle floor power and isolating per-task CPU tick consumption.

---

## 0. What Gets Demonstrated

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Web Browser (Dashboard)                         │
│  - 6-State FSM: IDLE -> SUBMITTING -> STREAMING_ACTIVE -> SETTLED      │
│  - Real-time 4-Chart Telemetry: Host W, GPU W, Net CPU J, Baseline W   │
│  - Zero-Mock Strict Policy: Fail-fast if telemetry unready             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ WebSocket (/ws)
┌───────────────────────────────────▼────────────────────────────────────┐
│                       Pi Session Runner (runner/)                      │
│  - Pi Agent Core execution engine with tool execution sandbox          │
│  - Structured Event Streaming: thought, tool_call, tool_result, msg    │
│  - MeterBridge: Lifecycle event hook (turn_start / turn_end / settle)  │
└──────────────┬──────────────────────────────────────────┬──────────────┘
               │ HTTP /v1/chat/completions                │ HTTP /api/tasks/attribution/cpu
┌──────────────▼──────────────────────────────────────────▼──────────────┐
│                    Task Gateway (cmd/task-gateway)                     │
│  - OpenAI-compatible streaming proxy                                   │
│  - Per-task token tracking & prompt/completion accounting              │
│  - SPBM CPU baseline subtraction & proc tick attribution               │
└──────────────┬──────────────────────────────────────────┬──────────────┘
               │                                          │
       vLLM / SGLang Fleet                     SPBM hwmon & Prometheus
    (GPU Inference Serving)                    (Hardware Telemetry Sink)
```

1. **Interactive Agent Experience**:
   - Natural language prompt submission and real-time execution.
   - Structured reasoning stream (`thought`), tool invocation (`tool_call`), execution outputs (`tool_result`), and natural language completion.
2. **Dual-Scope Energy Attribution**:
   - **Model GPU Joules**: Active inference consumption allocated by token production.
   - **Agent CPU Joules**: System runtime energy overhead spent running agent logic and tools, subtracting physical baseline noise.
   - **System JPT**: Comprehensive system-wide energy efficiency ($J/\text{token}$).
3. **Hardware Telemetry Observatory**:
   - Sub-second live charts rendering physical power fluctuations during tool invocation and model generation.

---

## 1. Component Architecture

### 1.1 Dashboard (`dashboard/`)
* **Framework**: React 19 + TypeScript + Vite + Tailwind CSS.
* **State Machine**: 6-state strictly closed FSM (`DISCONNECTED`, `IDLE`, `SUBMITTING`, `STREAMING_ACTIVE`, `SETTLED`, `ERROR`).
* **Visuals**: Dark-mode high-contrast telemetry deck with authentic brand identity, SVG time-series charts, and responsive event log.
* **Integrity**: Enforces zero-mock contract. Never synthesizes fallback data; surfaces genuine offline/standby states gracefully.

### 1.2 Session Runner (`runner/`)
* **Runtime**: Node.js 22+ (TypeScript, ESM) using Fastify and `@fastify/websocket`.
* **Agent Engine**: Built on `@earendil-works/pi-agent-core` and `@earendil-works/pi-coding-agent`.
* **MeterBridge**:
  - Automatically captures lifecycle events (`turn_start`, `turn_end`, `agent_end`).
  - Calls Task Gateway `/api/tasks/attribution/cpu/start` and `/stop` around active turns.
  - Sinks settled telemetry into a finalized dual-scope bill broadcast to the UI.
* **Pre-flight Warmup**: Exposes `/api/warmup` endpoint to ensure model weights and JPT metrics are populated before user interaction.

### 1.3 Task Gateway (`cmd/task-gateway/` & `internal/taskmeter/`)
* **Runtime**: Pure Go (`CGO_ENABLED=0`).
* **Proxy**: Low-overhead reverse proxy for `/v1/chat/completions` supporting streaming SSE tokens.
* **Attribution Algorithms**:
  - `host_attribution.go`: Grace-Hopper SPBM CPU idle noise subtraction.
  - `proc_ticks.go`: User + system tick accounting via `/proc/[pid]/stat`.
  - `meter.go`: Aggregates active window joules and token metrics into persistent records (`GET /tasks/:id`).

---

## 2. Prerequisites & Environment

### 2.1 Hardware & System Requirements
* **GPU Node**: NVIDIA GPU cluster (Ampere, Hopper, or Grace-Hopper GB10).
* **Hardware Sensors**:
  - SPBM hwmon driver mounted at `/sys/class/hwmon/hwmon*` (for Grace-Hopper host energy).
  - RAPL powercap sysfs interface (for x86 Intel/AMD host energy).
* **Toolchains**:
  - Go $\ge$ 1.22
  - Node.js $\ge$ 20 and `pnpm` $\ge$ 9

### 2.2 Environment Variables

| Variable | Target | Default | Description |
|---|---|---|---|
| `TASK_GW_URL` | Runner | `http://127.0.0.1:8080` | URL of the Task Gateway proxy |
| `RUNNER_PORT` / `PORT` | Runner | `8000` | Port for Fastify WebSocket server |
| `METER_PROMETHEUS_URL`| Runner | `http://127.0.0.1:9090` | Prometheus endpoint for GPU power queries |
| `VITE_WS_URL` | Dashboard | Dynamic | WebSocket URL for Agent Runner |
| `SPBM_HWMON_PATH` | Gateway | Auto-detected | Path to SPBM power sensor sysfs |

---

## 3. Quickstart: Running Locally

### Step 1: Start Task Gateway
```bash
# Compile and start Task Gateway proxying to your model inference backend
go run ./cmd/task-gateway \
  --listen=":8080" \
  --upstream="http://127.0.0.1:8000" \
  --prometheus="http://127.0.0.1:9090"
```

### Step 2: Start Pi Session Runner
```bash
cd runner
pnpm install
pnpm build

# Run the runner service
TASK_GW_URL=http://127.0.0.1:8080 \
METER_PROMETHEUS_URL=http://127.0.0.1:9090 \
PORT=8000 \
pnpm start
```

### Step 3: Start Agent Control Panel Dashboard
```bash
cd dashboard
pnpm install

# Start Vite dev server
pnpm dev
# Or build static bundle
pnpm build
```

Open `http://localhost:5173` in a modern browser. The dashboard connects to `ws://localhost:8000/ws` and transitions into `IDLE` state.

---

## 4. Verification & Testing

Every layer contains comprehensive unit and integration test suites:

### 4.1 Go Taskmeter & CPU Attribution Tests
```bash
go test -v -race ./cmd/task-gateway/... ./internal/taskmeter/...
```
*Coverage: CPU handler endpoints, baseline calibration, proc tick calculation, concurrent proxy requests, and Prometheus metrics parsing.*

### 4.2 Runner Contract & Lifecycle Tests
```bash
cd runner
pnpm test
```
*Coverage: 23 vitest suites testing Pi stream schema validation, sandbox isolation, MeterBridge turn lifecycle hooks, deferred reconciliation, and busy-state error handling.*

### 4.3 Dashboard FSM & Endpoint Tests
```bash
cd dashboard
pnpm test
pnpm build
```
*Coverage: 10 vitest suites testing FSM state transitions, zero-mock contract compliance, dynamic WebSocket URL resolution, and clean production compilation.*

### 4.4 End-to-End Real Hardware Test (GB10)
When running directly on an NVIDIA Grace-Hopper node with SPBM hwmon:
```bash
cd runner
pnpm --silent tsx src/xpark-live-e2e.ts
```
Expected output:
```json
{
  "type": "settled",
  "taskId": "live-e2e-XXXXX",
  "durationSeconds": 2.883,
  "energy": {
    "agentCpuJoules": 12.83,
    "modelGpuJoules": 358.20,
    "totalJoules": 371.03,
    "systemJpt": 2.47,
    "outputTokens": 150,
    "reconciled": false,
    "provisional": false
  }
}
```

---

## 5. Energy Accounting Contract

### 5.1 Host CPU Net Energy (Baseline Subtraction)
Raw host energy contains idle baseboard and CPU quiescent drain. To prevent idle penalization, Net CPU Joules is computed as:

$$\Delta E_{\text{host, active}} = \int_{t_{\text{start}}}^{t_{\text{end}}} \max(0, P_{\text{host}}(t) - P_{\text{baseline}}) \, dt$$

$$E_{\text{agent, CPU}} = \Delta E_{\text{host, active}} \times \frac{\text{Ticks}_{\text{agent\_proc}}}{\text{Ticks}_{\text{system\_total}}}$$

### 5.2 GPU Model Inference Energy
Token-share attribution calculates per-task GPU energy over concurrent inference batches:

$$E_{\text{model, GPU}} = \sum_{\text{turns}} (\text{Tokens}_{\text{output}} \times \text{JPT}_{\text{model}})$$

### 5.3 Settled Total
$$E_{\text{total}} = E_{\text{agent, CPU}} + E_{\text{model, GPU}}$$

$$\text{System JPT} = \frac{E_{\text{total}}}{\text{Tokens}_{\text{output}}}$$
