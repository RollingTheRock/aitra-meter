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
WS_STATUS=$(python3 -c "
import socket
s = socket.socket()
s.settimeout(5)
s.connect(('$BIDCORE_PUBLIC_IP', 80))
req = (
    b'GET /ws HTTP/1.1\r\n'
    b'Host: $BIDCORE_PUBLIC_IP\r\n'
    b'Connection: Upgrade\r\n'
    b'Upgrade: websocket\r\n'
    b'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
    b'Sec-WebSocket-Version: 13\r\n\r\n'
)
s.sendall(req)
resp = s.recv(1024).decode('utf-8', errors='ignore')
s.close()
if '101' in resp or 'Switching Protocols' in resp:
    print('101_OK')
elif '502' in resp:
    print('502_BAD_GATEWAY')
else:
    print(resp.split('\r\n')[0] if resp else 'EMPTY')
" 2>/dev/null || echo "CONNECT_FAIL")

if [[ "$WS_STATUS" == "101_OK" ]]; then
    echo "OK (101 Switching Protocols Handshake Verified)"
elif [[ "$WS_STATUS" == "502_BAD_GATEWAY" ]]; then
    echo "FAIL (502 Bad Gateway: Caddy is live, but xpark Runner on $XPARK_TAILSCALE_IP:$RUNNER_PORT is offline)"
    exit 1
else
    echo "FAIL (Unexpected response from /ws proxy: $WS_STATUS)"
    exit 1
fi

echo "=================================================="
echo " [SUCCESS] All 5 Network & Routing Gates PASSED!"
echo "=================================================="
