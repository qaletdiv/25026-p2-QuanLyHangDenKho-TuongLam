#!/usr/bin/env bash
set -euo pipefail
cd /opt/tentree-scportal
set -a; . ./release.env; set +a

dc() { docker compose --env-file .env --env-file release.env \
         -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

echo "[deploy] release $IMAGE_TAG"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

dc pull backend frontend nginx
dc up -d postgres
# Recreate only what changed; postgres and its volume are untouched.
dc up -d --no-build --remove-orphans
docker image prune -f >/dev/null
