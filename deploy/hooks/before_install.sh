#!/usr/bin/env bash
# Fail early, before anything is replaced, if the host is not set up.
set -euo pipefail
APP=/opt/tentree-scportal
mkdir -p "$APP/backend" "$APP/nginx/logs" "$APP/nginx/opt/nginx/ssl" "$APP/backups"

missing=()
[ -f "$APP/.env" ]                          || missing+=("$APP/.env  (from deploy.env.example)")
[ -f "$APP/backend/.env" ]                  || missing+=("$APP/backend/.env")
[ -f "$APP/nginx/opt/nginx/ssl/origin.pem" ] || missing+=("$APP/nginx/opt/nginx/ssl/origin.pem")
[ -f "$APP/nginx/opt/nginx/ssl/origin.key" ] || missing+=("$APP/nginx/opt/nginx/ssl/origin.key")
command -v docker >/dev/null || missing+=("docker (scripts/setup-docker.sh)")
command -v aws    >/dev/null || missing+=("aws cli v2")

if [ ${#missing[@]} -gt 0 ]; then
  printf '[deploy] host is missing:\n'; printf '  - %s\n' "${missing[@]}"; exit 1
fi
