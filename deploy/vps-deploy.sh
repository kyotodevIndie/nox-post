#!/usr/bin/env bash
# Deploy do post-nox na VPS: builda a imagem aqui, manda por SSH (docker save | load), faz backup do banco,
# roda as migrations e recria a stack "post-nox". Mesmo esquema do Nox.
# Pré-requisitos: `ssh $POSTNOX_HOST` funcionando, rede docker "proxy" (caddy-docker-proxy) e /root/post-nox-deploy/stack.env
# no servidor (modelo em deploy/stack.env.example). Uso: POSTNOX_HOST=minha-vps bash deploy/vps-deploy.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOST="${POSTNOX_HOST:-hera-vps}"
DIR=/root/post-nox-deploy
SHA="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain)" ] || { echo "Há mudanças não commitadas; commite antes." >&2; exit 1; }

echo "→ build $SHA"
docker build -q -t "post-nox:$SHA" .

echo "→ enviando imagem"
docker save "post-nox:$SHA" | gzip -1 | ssh "$HOST" 'gunzip | docker load' >/dev/null
ssh "$HOST" "mkdir -p $DIR"
scp -q deploy/docker-compose.yml deploy/docker-compose.caddy.yml "$HOST:$DIR/"

ssh "$HOST" SHA="$SHA" DIR="$DIR" bash -s <<'REMOTE'
set -euo pipefail
ENV=$DIR/stack.env
[ -f $ENV ] || { echo "falta $ENV (modelo em deploy/stack.env.example)" >&2; exit 1; }
cd $DIR
sed -i "s/^POSTNOX_TAG=.*/POSTNOX_TAG=$SHA/" $ENV
grep -q '^POSTNOX_TAG=' $ENV || echo "POSTNOX_TAG=$SHA" >> $ENV
FILES="-f docker-compose.yml"
grep -q '^POSTNOX_DOMAIN=.\+' $ENV && FILES="$FILES -f docker-compose.caddy.yml"
DC="docker compose -p post-nox --env-file $ENV $FILES"

$DC up -d --pull never postgres
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' post-nox-postgres-1)" = healthy ] && break; sleep 2; done

mkdir -p /root/backups
echo "→ backup"
docker exec post-nox-postgres-1 pg_dump -U postnox -d postnox -Fc > /root/backups/post-nox-$(date +%Y%m%d-%H%M)-$SHA.dump
ls -1t /root/backups/post-nox-*.dump | tail -n +15 | xargs -r rm --

echo "→ migrations"
set -a; . $ENV; set +a
docker run --rm --network post-nox_default \
  -e DATABASE_URL="postgresql://postnox:$POSTGRES_PASSWORD@postgres:5432/postnox" \
  "post-nox:$SHA" node --import tsx/esm scripts/migrate.ts

echo "→ subindo"
$DC up -d --pull never
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' post-nox-api-1)" = healthy ] && { echo "✔ api saudável ($SHA)"; break; }
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' post-nox-api-1)" = healthy ] || { docker logs --tail 20 post-nox-api-1; exit 1; }
docker image prune -f >/dev/null
REMOTE
