#!/usr/bin/env bash
# ─── Remove an app from nginx reverse proxy ──────────────
# Usage: bash remove-app.sh <app-name>

set -euo pipefail
APP="${1:-}"

if [ -z "$APP" ]; then
    echo "Usage: bash remove-app.sh <app-name>"
    exit 1
fi

CONF="/etc/nginx/conf.d/apps/${APP}.conf"

if [ ! -f "$CONF" ]; then
    echo "App '$APP' not found ($CONF does not exist)"
    exit 1
fi

echo ">>> Removing app: $APP"
sudo rm -f "$CONF"
sudo nginx -t && sudo systemctl reload nginx
echo "  nginx reloaded — $APP removed"
