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

AUTH_USER="${AUTH_USER:-openlab}"
AUTH_PASS="${AUTH_PASS:-openlab}"

# 1. 检查 Tailscale 节点互通性
echo -n "[1/5] Checking Tailscale connectivity to xpark ($XPARK_TAILSCALE_IP)... "
if ping -c 2 -W 3 "$XPARK_TAILSCALE_IP" > /dev/null 2>&1; then
    echo "OK (Reachable)"
else
    echo "FAIL (Cannot ping $XPARK_TAILSCALE_IP via Tailscale)"
    exit 1
fi

# 2. 检查网关 Basic Auth 安全拦截 (未授权返回 401) 与授权访问 200
echo -n "[2/5] Checking Gateway Basic Auth security & Cache-Control... "
UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://$BIDCORE_PUBLIC_IP/" || true)
if [[ "$UNAUTH_CODE" != "401" ]]; then
    echo "FAIL (Security Breach: Expected 401 Unauthorized without credentials, got $UNAUTH_CODE)"
    exit 1
fi
AUTH_HEADERS=$(curl -sI -u "$AUTH_USER:$AUTH_PASS" -m 5 "http://$BIDCORE_PUBLIC_IP/" || true)
if echo "$AUTH_HEADERS" | grep -q "200 OK"; then
    if echo "$AUTH_HEADERS" | grep -qi "no-cache"; then
        echo "OK (Secured: 401 rejected, authenticated 200 OK with no-cache)"
    else
        echo "FAIL (Missing Cache-Control: no-cache header)"
        exit 1
    fi
else
    echo "FAIL (Authenticated request failed or not 200 OK)"
    exit 1
fi

# 3. 检查 SPA 路由回退 (Deep Link 正常 fallback)
echo -n "[3/5] Checking SPA Deep-Link fallback on http://$BIDCORE_PUBLIC_IP/session/test-failfast... "
DEEP_STATUS=$(curl -s -u "$AUTH_USER:$AUTH_PASS" -o /dev/null -w "%{http_code}" -m 5 "http://$BIDCORE_PUBLIC_IP/session/test-failfast" || true)
if [[ "$DEEP_STATUS" == "200" ]]; then
    echo "OK (Returned 200 via try_files fallback)"
else
    echo "FAIL (Expected 200 but got $DEEP_STATUS)"
    exit 1
fi

# 4. 检查静态资产 Immutable 缓存头
echo -n "[4/5] Checking Static Asset Cache-Control policy... "
ASSET_PATH=$(curl -s -u "$AUTH_USER:$AUTH_PASS" "http://$BIDCORE_PUBLIC_IP/" | grep -oE '/assets/index-[a-zA-Z0-9_-]+\.js' | head -n 1 || true)
if [[ -n "$ASSET_PATH" ]]; then
    ASSET_HEADER=$(curl -sI -u "$AUTH_USER:$AUTH_PASS" -m 5 "http://$BIDCORE_PUBLIC_IP$ASSET_PATH" || true)
    if echo "$ASSET_HEADER" | grep -qi "immutable"; then
        echo "OK (Immutable header verified on $ASSET_PATH)"
    else
        echo "WARN (Asset header missing immutable, continuing)"
    fi
else
    echo "SKIP (No assets referenced yet in root HTML)"
fi

# 5. 检查公网 WebSocket Upgrade 握手穿透与未鉴权拦截
echo -n "[5/5] Checking WebSocket Upgrade handshake to http://$BIDCORE_PUBLIC_IP/ws... "
WS_STATUS=$(python3 -c "
import socket, base64

def probe(auth_hdr):
    s = socket.socket()
    s.settimeout(5)
    s.connect(('$BIDCORE_PUBLIC_IP', 80))
    hdrs = [
        'GET /ws HTTP/1.1',
        'Host: $BIDCORE_PUBLIC_IP',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13'
    ]
    if auth_hdr:
        hdrs.append(f'Authorization: {auth_hdr}')
    s.sendall(('\r\n'.join(hdrs) + '\r\n\r\n').encode('utf-8'))
    resp = s.recv(1024).decode('utf-8', errors='ignore')
    s.close()
    return resp.split('\r\n')[0] if resp else 'EMPTY'

unauth = probe('')
creds = base64.b64encode(b'$AUTH_USER:$AUTH_PASS').decode('ascii')
auth = probe(f'Basic {creds}')

if '401' in unauth and ('101' in auth or 'Switching Protocols' in auth):
    print('ALL_PASSED')
elif '401' not in unauth:
    print('FAIL_UNAUTH_' + unauth)
else:
    print('FAIL_AUTH_' + auth)
" 2>/dev/null || echo "CONNECT_FAIL")

if [[ "$WS_STATUS" == "ALL_PASSED" ]]; then
    echo "OK (Unauth correctly rejected with 401; Auth upgraded to 101 Switching Protocols)"
else
    echo "FAIL (WebSocket probe status: $WS_STATUS)"
    exit 1
fi

echo "=================================================="
echo " [SUCCESS] All 5 Network & Routing Gates PASSED!"
echo "=================================================="
