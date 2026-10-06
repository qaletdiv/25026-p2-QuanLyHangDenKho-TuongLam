#!/usr/bin/env bash
set -e

echo "[Docker] === START ==="

####################################
# 0. Check root
####################################
if [ "$EUID" -ne 0 ]; then
  echo "[Docker] Please run as root or with sudo"
  exit 1
fi

####################################
# 1. Check Docker installed
####################################
if command -v docker >/dev/null 2>&1; then
  echo "[Docker] Docker already installed:"
  docker --version
  docker compose version
  exit 0
fi

echo "[Docker] Docker not found. Installing..."

####################################
# 2. Remove conflicting packages
####################################
echo "[Docker] Removing conflicting packages..."

CONFLICT_PKGS="docker.io docker-doc docker-compose podman-docker containerd runc"

apt remove -y $CONFLICT_PKGS 2>/dev/null || true

####################################
# 3. Install dependencies
####################################
echo "[Docker] Installing dependencies..."

apt update -y
apt install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings

####################################
# 4. Add Docker GPG key
####################################
echo "[Docker] Adding Docker GPG key..."

curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc

chmod a+r /etc/apt/keyrings/docker.asc

####################################
# 5. Add Docker repository
####################################
echo "[Docker] Adding Docker repository..."

ARCH=$(dpkg --print-architecture)
CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")

cat <<EOF > /etc/apt/sources.list.d/docker.sources
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $CODENAME
Components: stable
Architectures: $ARCH
Signed-By: /etc/apt/keyrings/docker.asc
EOF

####################################
# 6. Install Docker
####################################
echo "[Docker] Installing Docker Engine..."

apt update -y

apt install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

####################################
# 7. Enable and start Docker
####################################
echo "[Docker] Starting Docker service..."

systemctl enable docker
systemctl start docker

####################################
# 8. Add user to docker group
####################################
if [ -n "${SUDO_USER:-}" ]; then
  usermod -aG docker "$SUDO_USER"
  echo "[Docker] Added $SUDO_USER to docker group"
else
  echo "[Docker] No sudo user found. Skipping adding to docker group."
fi

####################################
# 9. Verify installation
####################################
echo "[Docker] Docker installed successfully"

docker --version
docker compose version

echo "[Docker] === DONE ==="
