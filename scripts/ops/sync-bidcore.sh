#!/usr/bin/env bash
# scripts/ops/sync-bidcore.sh
# 将本地构建完成的 Dashboard 原子同步至 BidCore 云服务器并热重载 Caddy
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BIDCORE_HOST="${BIDCORE_HOST:-BidCore1}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_IP="${REMOTE_IP:-47.122.111.234}"
SSH_KEY="${SSH_KEY:-}"

SSH_OPTS=("-o" "StrictHostKeyChecking=no")
if [[ -n "$SSH_KEY" && -f "$SSH_KEY" ]]; then
    SSH_OPTS+=("-i" "$SSH_KEY")
elif [[ -f "$HOME/.ssh/aliyun_ecs.pem" ]]; then
    SSH_OPTS+=("-i" "$HOME/.ssh/aliyun_ecs.pem")
fi

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
rsync -avz -e "ssh ${SSH_OPTS[*]}" dist/ "$REMOTE_USER@$REMOTE_IP:$RELEASE_DIR/"

echo ">>> [STATE: SYNC_CADDYFILE] Deploying Caddyfile..."
rsync -avz -e "ssh ${SSH_OPTS[*]}" \
    "$REPO_ROOT/deploy/bidcore/Caddyfile" "$REMOTE_USER@$REMOTE_IP:/etc/caddy/Caddyfile"

echo ">>> [STATE: ATOMIC_SWAP] Atomically switching active release symlink..."
fab -H "$BIDCORE_HOST" -- "ln -sfn $RELEASE_DIR $TARGET_SYMLINK"

echo ">>> [STATE: CADDY_RELOAD] Validating and reloading Caddy configuration..."
fab -H "$BIDCORE_HOST" -- "caddy validate --config /etc/caddy/Caddyfile && (systemctl reload caddy 2>/dev/null || systemctl restart caddy)"

echo ">>> [STATE: PRODUCTION_LIVE] Deployment completed successfully!"
