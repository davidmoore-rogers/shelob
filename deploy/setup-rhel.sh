#!/usr/bin/env bash
# deploy/setup-rhel.sh — IPAM deployment script for RHEL / Rocky / Alma Linux 9
#
# Run as root:  bash deploy/setup-rhel.sh
#
# What this script does:
#   1. Installs Node.js 20 and PostgreSQL 15 (if not already installed)
#   2. Creates a dedicated 'ipam' system user
#   3. Creates the PostgreSQL database and role
#   4. Clones or copies the application to /opt/ipam
#   5. Installs dependencies and runs migrations
#   6. Installs and enables a systemd service
#
# After running, the app will be available at http://<server-ip>:3000

set -euo pipefail

APP_DIR="/opt/ipam"
APP_USER="ipam"
APP_GROUP="ipam"
DB_NAME="ipam"
DB_USER="ipam"
DB_PASS="ipam"
REPO_URL="https://github.com/davidmoore-rogers/ip-management.git"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root"
fi

info "Starting IPAM deployment on $(hostname)"

# ─── 1. Install Node.js 20 ───────────────────────────────────────────────────
if command -v node &>/dev/null && [[ "$(node -v)" == v20* || "$(node -v)" == v22* ]]; then
  info "Node.js $(node -v) already installed"
else
  info "Installing Node.js 20..."
  dnf module enable -y nodejs:20
  dnf install -y nodejs npm
  info "Node.js $(node -v) installed"
fi

# ─── 2. Install PostgreSQL 15 ────────────────────────────────────────────────
if command -v psql &>/dev/null; then
  info "PostgreSQL already installed"
else
  info "Installing PostgreSQL..."
  dnf install -y postgresql-server postgresql
  postgresql-setup --initdb
  info "PostgreSQL installed"
fi

# Enable and start PostgreSQL
systemctl enable --now postgresql
info "PostgreSQL is running"

# ─── 3. Create system user ───────────────────────────────────────────────────
if id "$APP_USER" &>/dev/null; then
  info "User '$APP_USER' already exists"
else
  info "Creating system user '$APP_USER'..."
  useradd --system --shell /bin/false --home-dir "$APP_DIR" --create-home "$APP_USER"
  info "User '$APP_USER' created"
fi

# ─── 4. Create database and role ─────────────────────────────────────────────
info "Setting up PostgreSQL database..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

info "Database '$DB_NAME' ready"

# Ensure pg_hba.conf allows password auth for the ipam user
PG_HBA=$(sudo -u postgres psql -tc "SHOW hba_file;" | tr -d ' ')
if ! grep -q "$DB_USER" "$PG_HBA" 2>/dev/null; then
  warn "Adding md5 auth entry for '$DB_USER' to pg_hba.conf"
  # Insert before the first local/host line
  sed -i "/^# TYPE/a local   $DB_NAME   $DB_USER   md5\nhost    $DB_NAME   $DB_USER   127.0.0.1/32   md5\nhost    $DB_NAME   $DB_USER   ::1/128        md5" "$PG_HBA"
  systemctl reload postgresql
fi

# ─── 5. Deploy application ───────────────────────────────────────────────────
if [[ -d "$APP_DIR/.git" ]]; then
  info "Updating existing installation..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" git pull --ff-only
else
  info "Cloning repository to $APP_DIR..."
  # Remove the directory if it exists but isn't a git repo
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
fi

cd "$APP_DIR"

# ─── 6. Configure environment ────────────────────────────────────────────────
if [[ ! -f "$APP_DIR/.env" ]]; then
  info "Creating .env from template..."
  SESSION_SECRET=$(openssl rand -base64 32)
  cat > "$APP_DIR/.env" <<ENVFILE
# Database
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}

# App
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Auth
SESSION_SECRET=${SESSION_SECRET}
ENVFILE
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  info ".env created with generated SESSION_SECRET"
else
  info ".env already exists — skipping"
fi

# ─── 7. Install dependencies & build ─────────────────────────────────────────
info "Installing dependencies..."
sudo -u "$APP_USER" npm ci --production=false

info "Building TypeScript..."
sudo -u "$APP_USER" npx tsc

info "Running database migrations..."
sudo -u "$APP_USER" npx prisma migrate deploy

info "Seeding database..."
sudo -u "$APP_USER" node --env-file=.env --import tsx/esm prisma/seed.ts

# ─── 8. Install systemd service ──────────────────────────────────────────────
info "Installing systemd service..."
cp "$APP_DIR/deploy/ipam.service" /etc/systemd/system/ipam.service
systemctl daemon-reload
systemctl enable --now ipam

info "Waiting for service to start..."
sleep 2

if systemctl is-active --quiet ipam; then
  info "IPAM service is running"
else
  warn "Service may not have started — check: journalctl -u ipam -f"
fi

# ─── 9. Firewall ─────────────────────────────────────────────────────────────
if command -v firewall-cmd &>/dev/null; then
  info "Opening port 3000 in firewall..."
  firewall-cmd --permanent --add-port=3000/tcp
  firewall-cmd --reload
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "============================================"
info "  IPAM deployment complete!"
info "  URL:   http://$(hostname -I | awk '{print $1}'):3000"
info "  Login: admin / admin"
info "  Logs:  journalctl -u ipam -f"
info "============================================"
echo ""
warn "Change the default admin password after first login!"
