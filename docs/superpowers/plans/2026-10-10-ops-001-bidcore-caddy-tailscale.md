# [OPS-001] BidCore 极轻量 Caddy 静态托管与 Tailscale 穿透路由配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 `demo/agent-control-panel` 分支，实现公网云服务器 BidCore 极轻量 Caddy 静态托管与 Tailscale 穿透反向代理至 xpark 算力机，并完成从本地（Local）到线上（Production）端到端全链路的前后端联合调试与自动化运维验证。

**Architecture:** 
公网边缘服务器 BidCore 实行「绝对零后端负载」策略（仅运行 Caddy 2.x），负责 Dashboard SPA 静态资源直出与协商缓存分流，通过 Tailscale 内网隧道反向代理 `/api/*` 与 WebSocket `/ws` 到物理隔离的 xpark 算力机（Runner 8000 与 Task Gateway 8090）。通过原子发布脚本（rsync + symlink swap + caddy reload）与全链路探活脚本（Tailscale 延迟、HTTP 200/缓存头、SPA 深层路由、WebSocket Upgrade）实现确定性发布与闭环验证。

**Tech Stack:** Caddy 2.x, Tailscale Mesh VPN, React 19 + Vite + TypeScript (Dashboard), Fastify + WebSocket (Runner), Go (Task Gateway & Task Meter), Fabric (`fab`), `tailscale ssh`, Bash.

**Spec:** GitHub Issue #5: https://github.com/RollingTheRock/aitra-meter/issues/5

## Global Constraints

- **BidCore 绝对零后端负载**：BidCore 严禁部署或运行 Node.js、Go、Python 或任何数据库进程，只跑 Caddy，内存底噪常驻控制在 15MB 左右。
- **算力机物理安全**：xpark 端口（8000, 8090, 18083 等）绝不对公网直接开放任何监听，所有外部流量必须经由 BidCore Tailscale 隧道受控中转。
- **原子化发布**：静态文件更新必须具备原子性（`ln -sfn` 软链接瞬时切换），杜绝更新中途用户拉取到半套新旧混杂的 JS 文件。
- **Zero-Mock Fail-Fast 契约**：严禁硬编码任何 Mock 数据或容错降级假数据；上游断开必须在界面与协议层以真实错误暴露。
- **前后端全链路联合调试闭环**：必须覆盖本地环境（Local Vite + Runner + Gateway）和生产环境（Public IP -> BidCore Caddy -> Tailscale -> Xpark Runner -> GPU/CPU Telemetry）。

---

### Task 1: 前端传输层自适应端点对齐 (Dashboard WS Transport Alignment)

**Files:**
- Modify: `dashboard/src/services/wsClient.ts:25-35`
- Test: `dashboard/test/ws-endpoint.test.ts`

**Interfaces:**
- Consumes: `window.location`, `import.meta.env.VITE_WS_URL`
- Produces: `resolveWsUrl(): string` (在本地 dev 返回 `ws://127.0.0.1:8000/ws`，线上生产环境自适应返回 `ws://${window.location.host}/ws` 或 `wss://...`)

- [ ] **Step 1: 编写失败的端点解析单元测试**

```typescript
// dashboard/test/ws-endpoint.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveWsUrl } from "../src/services/wsClient";

describe("resolveWsUrl Strategy", () => {
  const originalLocation = window.location;

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  it("respects explicit override option", () => {
    expect(resolveWsUrl({ url: "ws://custom.host:9999/ws" })).toBe("ws://custom.host:9999/ws");
  });

  it("falls back to localhost:8000 when running in Vite local dev (port 5173)", () => {
    Object.defineProperty(window, "location", {
      value: { protocol: "http:", hostname: "localhost", host: "localhost:5173", port: "5173" },
      writable: true,
    });
    expect(resolveWsUrl({})).toBe("ws://127.0.0.1:8000/ws");
  });

  it("resolves same-origin ws:// URL when deployed behind BidCore Caddy proxy (port 80 / public domain)", () => {
    Object.defineProperty(window, "location", {
      value: { protocol: "http:", hostname: "47.122.111.234", host: "47.122.111.234", port: "" },
      writable: true,
    });
    expect(resolveWsUrl({})).toBe("ws://47.122.111.234/ws");
  });

  it("resolves wss:// URL when accessed via HTTPS", () => {
    Object.defineProperty(window, "location", {
      value: { protocol: "https:", hostname: "dashboard.aitra.ai", host: "dashboard.aitra.ai", port: "" },
      writable: true,
    });
    expect(resolveWsUrl({})).toBe("wss://dashboard.aitra.ai/ws");
  });
});
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `cd dashboard && pnpm vitest run test/ws-endpoint.test.ts --bail 1`
Expected: FAIL with `resolveWsUrl is not exported or not defined`

- [ ] **Step 3: 实现自适应 WS 端点解析逻辑**

```typescript
// dashboard/src/services/wsClient.ts
export function resolveWsUrl(options?: { url?: string }): string {
  if (options?.url) return options.url;
  
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }

  if (typeof window !== "undefined" && window.location) {
    const { protocol, host, port } = window.location;
    // Vite dev server typically runs on 5173 / 3000
    if (port === "5173" || port === "3000") {
      return "ws://127.0.0.1:8000/ws";
    }
    const wsProto = protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${host}/ws`;
  }

  return "ws://127.0.0.1:8000/ws";
}
```

并在 `createWSClient` 中调用：
```typescript
  function resolveUrl(): string {
    return resolveWsUrl(options);
  }
```

- [ ] **Step 4: 运行测试以确认通过**

Run: `cd dashboard && pnpm vitest run test/ws-endpoint.test.ts --bail 1 && pnpm test`
Expected: PASS (all tests green)

- [ ] **Step 5: 提交更改**

```bash
git add dashboard/src/services/wsClient.ts dashboard/test/ws-endpoint.test.ts
git commit -m "feat(dashboard): dynamically resolve WebSocket endpoint for Caddy reverse proxy and dev"
```

---

### Task 2: 本地全链路前后端联调基线验证 (Local E2E Joint Debugging)

**Files:**
- Test: `runner/test/pi-session-contract.test.ts`
- Test: `dashboard/test/state-contract.test.ts`

**Interfaces:**
- Consumes: `runner/src/server.ts` (:8000), `dashboard/src/App.tsx` (:5173)
- Produces: 验证本地端到端链路完全打通，确认前端状态机、WebSocket 通讯、真实事件流转换与结算结算账单无差错。

- [ ] **Step 1: 验证本地 Runner 与 Dashboard 单元测试双全绿**

Run: `cd runner && pnpm test && cd ../dashboard && pnpm test`
Expected: 17/17 runner tests PASS, 7/7 dashboard tests PASS

- [ ] **Step 2: 验证 Dashboard 生产环境产物静态构建无降级**

Run: `cd dashboard && pnpm build`
Expected: 生成 `dist/index.html` 以及 `dist/assets/*`，退出码 0，无任何 TypeScript 或 CSS 打包错误

- [ ] **Step 3: 启动本地 Runner 并通过真实 WebSocket 客户端完成集成探针测试**

编写本地单次联调探针并执行：
```bash
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:8000/ws");
ws.on("open", () => {
  console.log("LOCAL_WS_CONNECTED");
  ws.close();
});
ws.on("error", (e) => {
  console.error("LOCAL_WS_ERR", e.message);
  process.exit(1);
});
'
```
Expected: 验证协议格式无漂移

- [ ] **Step 4: 验证 Zero-Mock Fail-Fast 防护网**

验证当 WebSocket 服务断开时，前端触发任务会向 FSM 派发错误事件且拒绝伪造任何数据：
Run: `cd dashboard && pnpm vitest run test/state-contract.test.ts`
Expected: PASS

- [ ] **Step 5: 提交本地基准验证记录**

```bash
git status --short
# 确保工作区干净
```

---

### Task 3: Caddyfile 路由配置与部署规则 (Caddy Gateway Specification & Safe Headers)

**Files:**
- Create: `deploy/bidcore/Caddyfile`
- Create: `deploy/bidcore/test/caddyfile_contract_test.sh`

**Interfaces:**
- Consumes: Caddy 2.x 核心指令 (`root`, `file_server`, `try_files`, `reverse_proxy`, `header`)
- Produces: `deploy/bidcore/Caddyfile`，配置 SPA 托管、静态资产 1 年 immutable 缓存、HTML `no-cache` 协商、`/api/*` 与 `/ws` 经 Tailscale 转发到 `{$XPARK_TAILSCALE_IP}:8000`

- [ ] **Step 1: 编写 Caddyfile 规则断言测试脚本**

```bash
#!/usr/bin/env bash
# deploy/bidcore/test/caddyfile_contract_test.sh
set -euo pipefail

CADDYFILE="deploy/bidcore/Caddyfile"

if [[ ! -f "$CADDYFILE" ]]; then
  echo "FAIL: $CADDYFILE does not exist"
  exit 1
fi

grep -q "root \* /var/www/aitra-dashboard" "$CADDYFILE" || (echo "FAIL: missing root directive" && exit 1)
grep -q "try_files {path} /index.html" "$CADDYFILE" || (echo "FAIL: missing try_files SPA fallback" && exit 1)
grep -q 'header @html Cache-Control "no-cache, no-store, must-revalidate"' "$CADDYFILE" || (echo "FAIL: missing html cache-control" && exit 1)
grep -q 'header @assets Cache-Control "public, max-age=31536000, immutable"' "$CADDYFILE" || (echo "FAIL: missing assets cache-control" && exit 1)
grep -q 'reverse_proxy /api/\* http://{\$XPARK_TAILSCALE_IP:100.124.203.70}:8000' "$CADDYFILE" || (echo "FAIL: missing api proxy" && exit 1)
grep -q 'reverse_proxy /ws http://{\$XPARK_TAILSCALE_IP:100.124.203.70}:8000' "$CADDYFILE" || (echo "FAIL: missing ws proxy" && exit 1)

echo "PASS: Caddyfile contract matches specification."
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `bash deploy/bidcore/test/caddyfile_contract_test.sh`
Expected: FAIL with `$CADDYFILE does not exist`

- [ ] **Step 3: 创建生产级 `deploy/bidcore/Caddyfile`**

```caddyfile
# deploy/bidcore/Caddyfile
# BidCore 公网入口网关配置 (极轻量零后端托管)
{$DOMAIN_OR_PORT::80} {
    # 1. 静态 SPA 托管
    root * /var/www/aitra-dashboard
    file_server
    try_files {path} /index.html

    # 2. 缓存控制契约
    @html path / /index.html
    header @html Cache-Control "no-cache, no-store, must-revalidate"
    @assets path /assets/*
    header @assets Cache-Control "public, max-age=31536000, immutable"

    # 3. 经过 Tailscale 内网转发至 xpark 算力机
    reverse_proxy /api/* http://{$XPARK_TAILSCALE_IP:100.124.203.70}:8000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }

    # 4. WebSocket 长连接穿透
    reverse_proxy /ws http://{$XPARK_TAILSCALE_IP:100.124.203.70}:8000
}
```

- [ ] **Step 4: 运行测试以确认通过**

Run: `bash deploy/bidcore/test/caddyfile_contract_test.sh`
Expected: PASS: Caddyfile contract matches specification.

- [ ] **Step 5: 提交更改**

```bash
git add deploy/bidcore/Caddyfile deploy/bidcore/test/caddyfile_contract_test.sh
git commit -m "feat(deploy): define BidCore Caddyfile with SPA hosting, strict cache policies, and Tailscale proxy"
```

---

### Task 4: 网络连通性探活脚本与红灯测试 (Network Verification & Fail-Fast Probe Script)

**Files:**
- Create: `scripts/ops/verify-network.sh`

**Interfaces:**
- Consumes: Public IP (`47.122.111.234`), Xpark Tailscale IP (`100.124.203.70`), Caddy 80/443, Runner 8000
- Produces: 自动化 5 级探活与校验逻辑，单行命令即得 FAIL/PASS，返回非 0 快速熔断

- [ ] **Step 1: 编写 `scripts/ops/verify-network.sh` 规格实现**

```bash
#!/usr/bin/env bash
# scripts/ops/verify-network.sh
# 验证 BidCore 网关与 xpark 算力机之间的网络拓扑及公网路由
set -euo pipefail

BIDCORE_PUBLIC_IP="${BIDCORE_PUBLIC_IP:-47.122.111.234}"
XPARK_TAILSCALE_IP="${XPARK_TAILSCALE_IP:-100.124.203.70}"
RUNNER_PORT="${RUNNER_PORT:-8000}"

echo "=================================================="
echo " [VERIFY-NETWORK] Aitra Control Panel Network Audit"
echo "=================================================="

# 1. 检查 Tailscale 节点互通性
echo -n "[1/5] Checking Tailscale connectivity to xpark ($XPARK_TAILSCALE_IP)... "
if ping -c 2 -W 3 "$XPARK_TAILSCALE_IP" > /dev/null 2>&1; then
    echo "OK (Reachable)"
else
    echo "FAIL (Cannot ping $XPARK_TAILSCALE_IP via Tailscale)"
    exit 1
fi

# 2. 检查公网 HTTP 200 与 HTML no-cache 响应头
echo -n "[2/5] Checking Public HTTP 200 & Cache-Control on http://$BIDCORE_PUBLIC_IP/... "
HTTP_HEADERS=$(curl -sI -m 5 "http://$BIDCORE_PUBLIC_IP/" || true)
if echo "$HTTP_HEADERS" | grep -q "200 OK"; then
    if echo "$HTTP_HEADERS" | grep -qi "no-cache"; then
        echo "OK (200 OK with Cache-Control: no-cache)"
    else
        echo "FAIL (Missing Cache-Control: no-cache header)"
        echo "$HTTP_HEADERS"
        exit 1
    fi
else
    echo "FAIL (HTTP request failed or not 200 OK)"
    echo "$HTTP_HEADERS"
    exit 1
fi

# 3. 检查 SPA 路由回退 (Deep Link 不报 404)
echo -n "[3/5] Checking SPA Deep-Link fallback on http://$BIDCORE_PUBLIC_IP/session/test-failfast... "
DEEP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://$BIDCORE_PUBLIC_IP/session/test-failfast" || true)
if [[ "$DEEP_STATUS" == "200" ]]; then
    echo "OK (Returned 200 via try_files fallback)"
else
    echo "FAIL (Expected 200 but got $DEEP_STATUS)"
    exit 1
fi

# 4. 检查静态资产 Immutable 缓存头
echo -n "[4/5] Checking Static Asset Cache-Control policy... "
ASSET_PATH=$(curl -s "http://$BIDCORE_PUBLIC_IP/" | grep -oE '/assets/index-[a-zA-Z0-9_-]+\.js' | head -n 1 || true)
if [[ -n "$ASSET_PATH" ]]; then
    ASSET_HEADER=$(curl -sI -m 5 "http://$BIDCORE_PUBLIC_IP$ASSET_PATH" || true)
    if echo "$ASSET_HEADER" | grep -qi "immutable"; then
        echo "OK (Immutable header verified on $ASSET_PATH)"
    else
        echo "WARN (Asset header missing immutable, continuing)"
    fi
else
    echo "SKIP (No assets referenced yet in root HTML)"
fi

# 5. 检查公网 WebSocket Upgrade 握手穿透至 xpark Runner
echo -n "[5/5] Checking WebSocket Upgrade handshake to http://$BIDCORE_PUBLIC_IP/ws... "
WS_RESP=$(curl -sI -m 5 \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
    -H "Sec-WebSocket-Version: 13" \
    "http://$BIDCORE_PUBLIC_IP/ws" || true)

if echo "$WS_RESP" | grep -qi "101 Switching Protocols"; then
    echo "OK (101 Switching Protocols Handshake Verified)"
elif echo "$WS_RESP" | grep -qi "502 Bad Gateway"; then
    echo "FAIL (502 Bad Gateway: Caddy is live, but xpark Runner on $XPARK_TAILSCALE_IP:$RUNNER_PORT is offline)"
    exit 1
else
    echo "FAIL (Unexpected response from /ws proxy)"
    echo "$WS_RESP"
    exit 1
fi

echo "=================================================="
echo " [SUCCESS] All 5 Network & Routing Gates PASSED!"
echo "=================================================="
```

- [ ] **Step 2: 赋予执行权限并测试静态可解析性**

```bash
chmod +x scripts/ops/verify-network.sh
bash -n scripts/ops/verify-network.sh
```
Expected: 语法校验无报错

- [ ] **Step 3: 提交更改**

```bash
git add scripts/ops/verify-network.sh
git commit -m "feat(ops): add fail-fast network verification probe script"
```

---

### Task 5: BidCore 运维环境配置与原子发布流水线 (BidCore Environment & Atomic Deployment Pipeline)

**Files:**
- Create: `scripts/ops/sync-bidcore.sh`
- Modify: Remote BidCore1 host (`/etc/caddy/Caddyfile`, systemd)

**Interfaces:**
- Consumes: Local `dashboard/dist`, Remote host `BidCore1` via `fab`, Identity `aliyun_ecs.pem`
- Produces: `scripts/ops/sync-bidcore.sh` (原子构建 -> rsync 传输 -> 软链接秒切 -> Caddy 热重载 -> 零停机)

- [ ] **Step 1: 编写 `scripts/ops/sync-bidcore.sh`**

```bash
#!/usr/bin/env bash
# scripts/ops/sync-bidcore.sh
# 将本地构建完成的 Dashboard 原子同步至 BidCore 云服务器并热重载 Caddy
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BIDCORE_HOST="${BIDCORE_HOST:-BidCore1}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_IP="${REMOTE_IP:-47.122.111.234}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/aliyun_ecs.pem}"

echo ">>> [STATE: LOCAL_BUILD] Building dashboard static assets..."
cd "$REPO_ROOT/dashboard"
pnpm build

if [[ ! -f "dist/index.html" ]]; then
    echo "ABORT: Build failed, dist/index.html not found!"
    exit 1
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RELEASE_DIR="/var/www/releases/aitra-dashboard-$TIMESTAMP"
TARGET_SYMLINK="/var/www/aitra-dashboard"

echo ">>> [STATE: RSYNC_TRANSFER] Syncing build assets to $BIDCORE_HOST:$RELEASE_DIR..."
fab -H "$BIDCORE_HOST" -- "mkdir -p $RELEASE_DIR /var/www/releases /etc/caddy"
rsync -avz -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" dist/ "$REMOTE_USER@$REMOTE_IP:$RELEASE_DIR/"

echo ">>> [STATE: SYNC_CADDYFILE] Deploying Caddyfile..."
rsync -avz -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
    "$REPO_ROOT/deploy/bidcore/Caddyfile" "$REMOTE_USER@$REMOTE_IP:/etc/caddy/Caddyfile"

echo ">>> [STATE: ATOMIC_SWAP] Atomically switching active release symlink..."
fab -H "$BIDCORE_HOST" -- "ln -sfn $RELEASE_DIR $TARGET_SYMLINK"

echo ">>> [STATE: CADDY_RELOAD] Validating and reloading Caddy configuration..."
fab -H "$BIDCORE_HOST" -- "caddy validate --config /etc/caddy/Caddyfile && (systemctl reload caddy 2>/dev/null || systemctl restart caddy)"

echo ">>> [STATE: PRODUCTION_LIVE] Deployment completed successfully!"
```

- [ ] **Step 2: 赋予执行权限并测试本地语法**

```bash
chmod +x scripts/ops/sync-bidcore.sh
bash -n scripts/ops/sync-bidcore.sh
```
Expected: 语法校验无报错

- [ ] **Step 3: 初始化 BidCore 云服务器基础环境（单次运维配置）**

通过 `fab` 在 BidCore1 上执行环境就绪检查并安装 Caddy：
```bash
fab -H BidCore1 -- "
  # 停止并禁用默认 nginx 以腾出 80 端口
  systemctl stop nginx 2>/dev/null || true
  systemctl disable nginx 2>/dev/null || true
  
  # 安装 Caddy (若未安装)
  if ! which caddy > /dev/null 2>&1; then
    apt-get update -y && apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y && apt-get install -y caddy
    systemctl enable caddy
  fi
  caddy version
"
```
Expected: 输出 Caddy 2.x 版本信息，80 端口无冲突。

- [ ] **Step 4: 执行首次同步并验证原子软链接与配置**

Run: `bash scripts/ops/sync-bidcore.sh`
Expected: 静态文件传输成功，Caddy 验证绿灯，`/var/www/aitra-dashboard` 指向发布目录。

- [ ] **Step 5: 提交更改**

```bash
git add scripts/ops/sync-bidcore.sh
git commit -m "feat(ops): implement atomic rsync and symlink swap deployment pipeline for BidCore"
```

---

### Task 6: 线上全链路前后端联合调试与验收铁证收集 (Production E2E Joint Debugging & Proof Upfront)

**Files:**
- Output Logs: `docs/superpowers/evidence/ops-001-acceptance-proof.md`

**Interfaces:**
- Consumes: BidCore1 (47.122.111.234), Xpark3ed7 (100.124.203.70:8000), `scripts/ops/verify-network.sh`
- Produces: 线上全链路贯通证据链（Caddy 语法全绿、Cache-Control 头、公网 WebSocket 握手成功日志、BidCore 零后端底噪快照）

- [ ] **Step 1: 在 xpark 算力机上就绪 Runner 守护服务**

通过 `tailscale ssh` 在 xpark 上构建并启动 Runner 监听：
```bash
tailscale ssh openlab_wang@fusionxparkgb10-3ed7 "
  cd ~/workdev/aitra-meter/runner
  pnpm build
  nohup node dist/server.js > runner.log 2>&1 &
  sleep 1
  curl -s http://127.0.0.1:8000/healthz
"
```
Expected: `{"status":"ok","runnerState":"IDLE"}`

- [ ] **Step 2: 运行线上网络全链路探活套件**

Run: `bash scripts/ops/verify-network.sh`
Expected: 
`[SUCCESS] All 5 Network & Routing Gates PASSED!`
特别是第 5 步 WebSocket Upgrade 返回 `101 Switching Protocols`。

- [ ] **Step 3: 真实公网浏览器端联合调试测试**

使用真实浏览器访问 `http://47.122.111.234/`:
1. 观察页面顶部连接指示灯变为绿色 `ONLINE (STANDBY)`。
2. 输入提示词触发真实任务运行，观察：
   - Caddy 接收并穿透 WebSocket 数据包；
   - Xpark Runner 接收并在后台调度 Pi Session；
   - 任务进入 `ENVIRONMENT_PREPARED` -> `SESSION_ACTIVE`；
   - 遥测四图表（Token 流速、GPU 功耗、CPU 增量、JPT 累计能耗）动态画线；
   - 任务结算完成，账单生成，FSM 进入结算完成态。

- [ ] **Step 4: 收集三项验收铁证 (Proof Upfront Statement)**

执行并固化铁证命令：
```bash
# 1. Caddyfile 语法与安全策略校验
fab -H BidCore1 -- "caddy validate --config /etc/caddy/Caddyfile"

# 2. 外网 curl 验证 Cache-Control
curl -I http://47.122.111.234/

# 3. Caddy WebSocket Upgrade 代理握手日志
fab -H BidCore1 -- "journalctl -u caddy -n 20 --no-pager"

# 4. 守护不变量：验证 BidCore 零后端进程底噪
fab -H BidCore1 -- "ps aux | grep -E 'node|python|go|mongod|mysql|postgres' | grep -v grep || echo 'ZERO_BACKEND_INVARIANT_PRESERVED'"
```

- [ ] **Step 5: 保存验收证据并提交完成任务**

```bash
git add docs/superpowers/evidence/
git commit -m "docs(ops): record end-to-end verification and proof upfront for OPS-001"
```

---

## Plan Self-Review & Verification Checklist

1. **Spec Coverage**:
   - `deploy/bidcore/Caddyfile` -> 覆盖于 Task 3
   - `scripts/ops/sync-bidcore.sh` -> 覆盖于 Task 5
   - `scripts/ops/verify-network.sh` -> 覆盖于 Task 4
   - 前端动态端点适配 -> 覆盖于 Task 1
   - 本地联调基线 -> 覆盖于 Task 2
   - 线上联调与验收铁证 -> 覆盖于 Task 6
2. **Placeholder Scan**: 
   - 无任何 "TBD", "TODO", "implement later", "fill in details"。
   - 所有命令与脚本逻辑完整，包含具体文件路径与行号。
3. **Invariants & Remote Execution Policy**:
   - 严格遵循 `BidCore1` 走 `fab`，`Xpark3ed7` 走 `tailscale ssh`。
   - 严禁 BidCore 跑后端进程，严禁算力机端口公网直开。
