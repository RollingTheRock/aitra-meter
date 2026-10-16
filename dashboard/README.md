# Agent Control Panel (Web Dashboard)

A high-performance React SPA for real-time agent task control, thought stream inspection, and physical energy telemetry observation.

## Features
- **6-State FSM**: Strict state machine handling transitions from `DISCONNECTED` to `SETTLED`.
- **4-Chart Telemetry Deck**: Renders live Host Power, GPU Power, Net CPU Dynamic Joules, and SPBM Baseline Floor.
- **Zero-Mock Policy**: Rejects synthesized or fake data; strictly fails fast if backend telemetry is absent.
- **Pure English Interface**: Internationalized typography and token-driven design system.

## Scripts
```bash
# Install dependencies
pnpm install

# Start Vite dev server with Hot Module Replacement (HMR)
pnpm dev

# Run Vitest test suites (10 tests)
pnpm test

# Build production bundle with TypeScript check
pnpm build

# Preview production build locally
pnpm preview
```

## Environment Variables
- `VITE_WS_URL`: Optional explicit WebSocket endpoint (defaults to dynamic resolution based on `window.location`).
