#!/usr/bin/env bash
# snapdiff Cherry VPS bootstrap. Run ONCE, as root, on the fresh server.
# Ubuntu 24.04 (apt). Idempotent: safe to re-run.
#
# What it does:
#   * admin user with key-only SSH (password and root login are disabled ONLY
#     after a key is confirmed present, so you cannot lock yourself out)
#   * ufw: deny inbound except 22 (rate-limited), 80, 443 tcp+udp (HTTP/3)
#   * 2G swap, BBR, unattended security upgrades
#   * Node 24 (NodeSource) for snapdiff; no native modules needed
#   * a locked `snapdiff` system user that owns /srv/snapdiff and runs the unit
#   * Caddy from the official repo, reverse-proxying 127.0.0.1:8787 over TLS
#   * the snapdiff systemd unit (enabled; starts once deploy.sh ships a build)
#
# snapdiff only READS two public Farcaster node APIs. Nothing here opens a
# tunnel home, and no home address appears anywhere on this box.
set -euo pipefail

ADMIN_USER="${ADMIN_USER:-schmrdty}"
APP_USER="snapdiff"
APP_DIR="/srv/snapdiff"
KIT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

echo "== packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ufw curl gnupg rsync unattended-upgrades ca-certificates \
  debian-keyring debian-archive-keyring apt-transport-https

echo "== admin user =="
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' "$ADMIN_USER"
  usermod -aG sudo "$ADMIN_USER"
fi
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
if [ -s /root/.ssh/authorized_keys ] && [ ! -s "/home/$ADMIN_USER/.ssh/authorized_keys" ]; then
  cp /root/.ssh/authorized_keys "/home/$ADMIN_USER/.ssh/authorized_keys"
  chown "$ADMIN_USER:$ADMIN_USER" "/home/$ADMIN_USER/.ssh/authorized_keys"
  chmod 600 "/home/$ADMIN_USER/.ssh/authorized_keys"
fi
# Passwordless sudo for the admin: deploy.sh restarts the unit over ssh and
# there is no password to type (the account has none).
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"

echo "== ssh hardening (only if a key is in place) =="
if [ -s "/home/$ADMIN_USER/.ssh/authorized_keys" ]; then
  # sshd keeps the FIRST value it reads and processes sshd_config.d in
  # lexical order. Ubuntu cloud images ship 50-cloud-init.conf with
  # PasswordAuthentication yes, so this drop-in must sort before it (00-),
  # or password auth silently stays on (caught on Ubuntu 26.04, 2026-10-27).
  rm -f /etc/ssh/sshd_config.d/99-snapdiff-harden.conf
  cat > /etc/ssh/sshd_config.d/00-snapdiff-harden.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 3
X11Forwarding no
EOF
  systemctl restart ssh || systemctl restart sshd
else
  echo "!! NO key found for $ADMIN_USER. SKIPPING password-auth disable."
  echo "!! Add your pubkey to /home/$ADMIN_USER/.ssh/authorized_keys and re-run."
fi

echo "== swap =="
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== kernel tuning =="
cat > /etc/sysctl.d/99-snapdiff.conf <<'EOF'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
vm.swappiness=10
EOF
sysctl --system >/dev/null

echo "== unattended security upgrades =="
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "== firewall =="
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "== node 24 =="
# NodeSource first; on a release newer than their index (Ubuntu 26.04 at
# launch) it can fail, so fall back to the official tarball in /usr/local,
# which is distro-independent.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  if curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs; then
    echo "node via NodeSource"
  else
    echo "NodeSource unavailable for this release; installing the official tarball"
    ARCH="$(dpkg --print-architecture)"; case "$ARCH" in amd64) NARCH=x64;; arm64) NARCH=arm64;; *) echo "unsupported arch $ARCH"; exit 1;; esac
    NVER="$(curl -fsSL https://nodejs.org/dist/index.json | grep -oE '"version":"v24\.[0-9]+\.[0-9]+"' | head -1 | cut -d'"' -f4)"
    curl -fsSL "https://nodejs.org/dist/${NVER}/node-${NVER}-linux-${NARCH}.tar.xz" -o /tmp/node.tar.xz
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm -f /tmp/node.tar.xz
    ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm
  fi
fi
node --version && npm --version

echo "== app user and directories =="
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR" "$APP_DIR/data" "$APP_DIR/reports"
# deploy.sh rsyncs as the admin user, so the admin owns the code tree and the
# app user owns only what it writes (data/, reports/).
chown "$ADMIN_USER:$APP_USER" "$APP_DIR"
chmod 775 "$APP_DIR"
if [ ! -f "$APP_DIR/.env" ]; then
  install -m 640 -o "$APP_USER" -g "$APP_USER" /dev/null "$APP_DIR/.env"
  echo "!! $APP_DIR/.env is EMPTY. Fill it (NODE_A_URL, NODE_A_HEADERS, NODE_B_URL, ...) before the unit can do useful work."
fi

echo "== systemd unit =="
cp "$KIT_DIR/snapdiff.service" /etc/systemd/system/snapdiff.service
systemctl daemon-reload
systemctl enable snapdiff

echo "== caddy (official repo) =="
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
cp "$KIT_DIR/Caddyfile" /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

echo
echo "================= DONE ================="
echo "Reconnect as: ssh ${ADMIN_USER}@$(curl -4s ifconfig.me || echo '<vps-ip>')"
echo "Next: fill ${APP_DIR}/.env, point DNS at this box, then run deploy/deploy.sh from the desktop."
