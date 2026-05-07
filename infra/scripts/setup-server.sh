#!/usr/bin/env bash
# ─── CA Infrastructure Setup ────────────────────────────
# Run ONCE on the server:  bash setup-server.sh
# Run as calcium user (has sudo).

set -euo pipefail
echo "=== CA Infrastructure Setup ==="
echo ""

# ─── 1. System Update ───────────────────────────────────
echo ">>> Updating system packages..."
sudo apt-get update -qq && sudo apt-get upgrade -y -qq
echo ""

# ─── 2. Install Packages ────────────────────────────────
echo ">>> Installing certbot..."
sudo apt-get install -y -qq certbot python3-certbot-nginx
echo "  certbot installed"
echo ""

# ─── 3. Directory Structure ─────────────────────────────
echo ">>> Creating /opt/apps structure..."
sudo mkdir -p /opt/apps/landing
sudo chown -R calcium:calcium /opt/apps

# Landing page
cat > /opt/apps/landing/index.html << 'LANDING_EOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gn01stic.gr</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
main { text-align: center; padding: 2rem; }
h1 { font-size: 2.5rem; color: #58a6ff; margin-bottom: 0.5rem; }
p  { color: #8b949e; font-size: 1rem; }
.status { margin-top: 2rem; font-size: 0.85rem; color: #484f58; }
</style>
</head>
<body>
<main>
  <h1>gn01stic.gr</h1>
  <p>CA-managed infrastructure — services coming soon.</p>
  <p class="status">nginx &bull; podman &bull; ubuntu 24.04</p>
</main>
</body>
</html>
LANDING_EOF
echo "  /opt/apps/     — app root (owned by calcium)"
echo "  /opt/apps/landing/ — static landing page"
echo ""

# ─── 4. nginx Configuration ─────────────────────────────
echo ">>> Configuring nginx reverse proxy..."

# Remove default site
sudo rm -f /etc/nginx/sites-enabled/default

# Create apps config directory
sudo mkdir -p /etc/nginx/conf.d/apps

# Write main reverse proxy config (HTTP-only initially, SSL added by certbot)
sudo tee /etc/nginx/sites-available/reverse-proxy > /dev/null << 'NGINX_EOF'
# ─── CA-managed reverse proxy ───────────────────────────
# Each app gets its own file in conf.d/apps/
# Reload: sudo systemctl reload nginx
# Certbot: sudo certbot --nginx -d <domain>

server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;

    # Buffer settings
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
    proxy_busy_buffers_size 256k;

    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    # Health check
    location /health {
        access_log off;
        return 200 "OK\n";
        add_header Content-Type text/plain;
    }

    # Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Per-app proxy configs
    include /etc/nginx/conf.d/apps/*.conf;

    # Default fallback
    location / {
        root /opt/apps/landing;
        index index.html;
        try_files $uri $uri/ =404;
    }
}
NGINX_EOF

# Enable it
sudo ln -sf /etc/nginx/sites-available/reverse-proxy /etc/nginx/sites-enabled/reverse-proxy

# Create certbot webroot
sudo mkdir -p /var/www/certbot
sudo chown -R calcium:calcium /var/www/certbot

echo "  /etc/nginx/sites-available/reverse-proxy — main config"
echo "  /etc/nginx/conf.d/apps/          — per-app proxy configs"
echo "  /var/www/certbot/                — ACME challenge webroot"
echo ""

# ─── 5. Firewall ────────────────────────────────────────
echo ">>> Configuring ufw firewall..."
sudo ufw --force reset > /dev/null 2>&1
sudo ufw default deny incoming > /dev/null
sudo ufw default allow outgoing > /dev/null
sudo ufw allow 22/tcp comment 'SSH' > /dev/null
sudo ufw allow 80/tcp comment 'HTTP' > /dev/null
sudo ufw allow 443/tcp comment 'HTTPS' > /dev/null
sudo ufw --force enable > /dev/null 2>&1
echo "  Firewall enabled: SSH(22) + HTTP(80) + HTTPS(443)"
echo ""

# ─── 6. nginx Test & Reload ─────────────────────────────
echo ">>> Testing nginx config..."
sudo nginx -t
echo ">>> Reloading nginx..."
sudo systemctl reload nginx
echo "  nginx reloaded"
echo ""

# ─── 7. Podman ──────────────────────────────────────────
echo ">>> Configuring podman..."

# Enable lingering for calcium user (containers survive logout)
sudo loginctl enable-linger calcium
echo "  lingering enabled (containers survive logout)"

# Create a shared podman network for apps
podman network create app-net 2>/dev/null || echo "  network 'app-net' already exists"
echo "  podman network: app-net"
echo ""

# ─── 8. Create Cert Helper ──────────────────────────────
echo ">>> Creating certbot helper script..."
cat > /opt/apps/ssl-cert.sh << 'CERT_EOF'
#!/usr/bin/env bash
# Usage: bash /opt/apps/ssl-cert.sh <domain> [domain2 ...]
# Obtains Let's Encrypt cert and updates nginx
set -euo pipefail
DOMAINS=""
for d in "$@"; do DOMAINS="$DOMAINS -d $d"; done
if [ -z "$DOMAINS" ]; then
    echo "Usage: bash /opt/apps/ssl-cert.sh <domain> [domain2 ...]"
    exit 1
fi
echo "Requesting cert for:$DOMAINS"
sudo certbot --nginx --non-interactive --agree-tos --email admin@gn01stic.gr \
    --webroot-path /var/www/certbot \
    $DOMAINS
sudo systemctl reload nginx
echo ""
echo "Certificate installed! Auto-renewal is handled by certbot timer:"
sudo systemctl status certbot.timer --no-pager 2>/dev/null || true
CERT_EOF
chmod +x /opt/apps/ssl-cert.sh
echo "  /opt/apps/ssl-cert.sh — get SSL cert for a domain"
echo ""

# ─── 9. Verify ───────────────────────────────────────────
echo "=== Setup Complete ==="
echo ""
echo "  nginx:   $(systemctl is-active nginx)"
echo "  ufw:     $(sudo ufw status | head -1)"
echo "  podman:  $(systemctl is-active podman 2>/dev/null || echo 'socket-activated')"
echo "  certbot: $(certbot --version 2>&1 | head -1)"
echo ""
echo "  Visit:   http://$(hostname -I | awk '{print $1}')/"
echo ""
echo "  To enable HTTPS for a domain:"
echo "    bash /opt/apps/ssl-cert.sh yourdomain.com"
echo ""
