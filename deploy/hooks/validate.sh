#!/usr/bin/env bash
# Wait for every container with a healthcheck to report healthy.
set -euo pipefail
cd /opt/tentree-scportal
dc() { docker compose --env-file .env --env-file release.env \
         -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

for i in $(seq 1 50); do
  unhealthy=$(dc ps --format '{{.Name}} {{.Health}}' | awk '$2!="" && $2!="healthy"{print}')
  if [ -z "$unhealthy" ] && curl -fsk -o /dev/null --resolve "localhost:443:127.0.0.1" https://localhost/login; then
    echo "[deploy] healthy"; exit 0
  fi
  sleep 5
done
echo "[deploy] not healthy after 250s:"; echo "$unhealthy"
dc logs --tail=80 backend frontend
exit 1
