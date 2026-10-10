#!/usr/bin/env bash
# deploy/bidcore/test/caddyfile_contract_test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDYFILE="$SCRIPT_DIR/../Caddyfile"

if [[ ! -f "$CADDYFILE" ]]; then
  echo "FAIL: $CADDYFILE does not exist"
  exit 1
fi

grep -q "root \* /var/www/aitra-dashboard" "$CADDYFILE" || (echo "FAIL: missing root directive" && exit 1)
grep -q "try_files {path} /index.html" "$CADDYFILE" || (echo "FAIL: missing try_files SPA fallback" && exit 1)
grep -q 'header @html Cache-Control "no-cache, no-store, must-revalidate"' "$CADDYFILE" || (echo "FAIL: missing html cache-control" && exit 1)
grep -q 'header @assets Cache-Control "public, max-age=31536000, immutable"' "$CADDYFILE" || (echo "FAIL: missing assets cache-control" && exit 1)
grep -q 'reverse_proxy http://{\$XPARK_TAILSCALE_IP:100.124.203.70}:8000' "$CADDYFILE" || (echo "FAIL: missing reverse_proxy" && exit 1)

echo "PASS: Caddyfile contract matches specification."
