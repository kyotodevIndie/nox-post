#!/usr/bin/env bash
# Deploy do nox-postiz-api na VPS: builda a imagem aqui, manda por SSH (docker save | load), faz backup do banco,
# roda as migrations e recria a stack "npa". Mesmo esquema do Nox.
# Pré-requisitos: `ssh $NPA_HOST` funcionando, rede docker "proxy" (caddy-docker-proxy) e /root/npa-deploy/stack.env
# no servidor (modelo em deploy/stack.env.example). Uso: NPA_HOST=minha-vps bash deploy/vps-deploy.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOST="${NPA_HOST:-hera-vps}"
DIR=/root/npa-deploy
SHA="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain)" ] || { echo "Há mudanças não commitadas; commite antes." >&2; exit 1; }

echo "→ build $SHA"
docker build -q -t "nox-postiz-api:$SHA" .

echo "→ enviando imagem"
docker save "nox-postiz-api:$SHA" | gzip -1 | ssh "$HOST" 'gunzip | docker load' >/dev/null
ssh "$HOST" "mkdir -p $DIR"
scp -q deploy/docker-compose.yml deploy/docker-compose.caddy.yml "$HOST:$DIR/"

ssh "$HOST" SHA="$SHA" DIR="$DIR" bash -s <<'REMOTE'
set -euo pipefail
ENV=$DIR/stack.env
[ -f $ENV ] || { echo "falta $ENV (modelo em deploy/stack.env.example)" >&2; exit 1; }
cd $DIR
sed -i "s/^NPA_TAG=.*/NPA_TAG=$SHA/" $ENV
grep -q '^NPA_TAG=' $ENV || echo "NPA_TAG=$SHA" >> $ENV
FILES="-f docker-compose.yml"
grep -q '^NPA_DOMAIN=.\+' $ENV && FILES="$FILES -f docker-compose.caddy.yml"
DC="docker compose -p npa --env-file $ENV $FILES"

$DC up -d --pull never postgres
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' npa-postgres-1)" = healthy ] && break; sleep 2; done

mkdir -p /root/backups
echo "→ backup"
docker exec npa-postgres-1 pg_dump -U npa -d npa -Fc > /root/backups/npa-$(date +%Y%m%d-%H%M)-$SHA.dump
ls -1t /root/backups/npa-*.dump | tail -n +15 | xargs -r rm --

echo "→ migrations"
set -a; . $ENV; set +a
docker run --rm --network npa_default \
  -e DATABASE_URL="postgresql://npa:$POSTGRES_PASSWORD@postgres:5432/npa" \
  "nox-postiz-api:$SHA" node --import tsx/esm scripts/migrate.ts

echo "→ subindo"
$DC up -d --pull never
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' npa-api-1)" = healthy ] && { echo "✔ api saudável ($SHA)"; break; }
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' npa-api-1)" = healthy ] || { docker logs --tail 20 npa-api-1; exit 1; }
docker image prune -f >/dev/null
REMOTE
