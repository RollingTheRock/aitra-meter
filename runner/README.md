# Pi Session Runner

A standalone TypeScript agent execution service powering the Aitra Meter Agent Control Panel.

## Overview
- Bridges browser WebSocket clients with Pi Agent Core.
- Executes agent tasks inside an isolated workspace.
- Integrates with MeterBridge to capture turn start/end boundaries.
- Contacts Task Gateway for CPU attribution and settles the dual-scope energy bill upon task completion.

## Scripts
```bash
# Install dependencies
pnpm install

# Build TypeScript to dist/
pnpm build

# Run unit and contract tests (23 tests)
pnpm test

# Run runner in development mode
pnpm dev

# Start compiled runner service
pnpm start
```

## Environment Variables
- `TASK_GW_URL`: Task Gateway base URL (default: `http://127.0.0.1:8080`)
- `METER_PROMETHEUS_URL`: Prometheus metrics endpoint (default: `http://127.0.0.1:9090`)
- `PORT`: HTTP and WebSocket listening port (default: `8000`)
- `MODEL_NAME`: Underlying model name to route through the gateway
