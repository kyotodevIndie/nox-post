#!/usr/bin/env bash
# Deploy do nox-post na VPS: builda a imagem aqui, manda por SSH (docker save | load), faz backup do banco,
# roda as migrations e recria a stack "nox-post". Mesmo esquema do Nox.
# Pré-requisitos: `ssh $NOX_POST_HOST` funcionando (usuário no grupo docker), rede docker "proxy" (caddy-docker-proxy),
# a pasta da stack no servidor (NOX_POST_DIR) e o stack.env dentro dela (modelo em deploy/stack.env.example).
# Uso: NOX_POST_HOST=<alias ssh> NOX_POST_DIR=<pasta> bash deploy/vps-deploy.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOST="${NOX_POST_HOST:?defina NOX_POST_HOST com o alias ssh do servidor}"
DIR="${NOX_POST_DIR:?defina NOX_POST_DIR com a pasta da stack no servidor}"
SHA="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain)" ] || { echo "Há mudanças não commitadas; commite antes." >&2; exit 1; }

echo "→ build $SHA"
docker build -q -t "nox-post:$SHA" .

echo "→ enviando imagem"
docker save "nox-post:$SHA" | gzip -1 | ssh "$HOST" 'gunzip | docker load' >/dev/null
ssh "$HOST" "test -w $DIR" || { echo "$HOST:$DIR não existe ou não é do usuário do ssh" >&2; exit 1; }
scp -q deploy/docker-compose.yml deploy/docker-compose.caddy.yml "$HOST:$DIR/"

ssh "$HOST" SHA="$SHA" DIR="$DIR" bash -s <<'REMOTE'
set -euo pipefail
ENV=$DIR/stack.env
[ -f $ENV ] || { echo "falta $ENV (modelo em deploy/stack.env.example)" >&2; exit 1; }
cd $DIR
# stack.env do nome antigo (post-nox): troca o prefixo POSTNOX_ por NOX_POST_ uma vez
sed -i 's/^POSTNOX_/NOX_POST_/' $ENV
sed -i "s/^NOX_POST_TAG=.*/NOX_POST_TAG=$SHA/" $ENV
grep -q '^NOX_POST_TAG=' $ENV || echo "NOX_POST_TAG=$SHA" >> $ENV
FILES="-f docker-compose.yml"
grep -q '^NOX_POST_DOMAIN=.\+' $ENV && FILES="$FILES -f docker-compose.caddy.yml"
DC="docker compose -p nox-post --env-file $ENV $FILES"

$DC up -d --pull never postgres
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' nox-post-postgres-1)" = healthy ] && break; sleep 2; done

mkdir -p $DIR/backups
echo "→ backup"
docker exec nox-post-postgres-1 pg_dump -U noxpost -d noxpost -Fc > $DIR/backups/nox-post-$(date +%Y%m%d-%H%M)-$SHA.dump
ls -1t $DIR/backups/nox-post-*.dump | tail -n +15 | xargs -r rm --

echo "→ migrations"
set -a; . $ENV; set +a
docker run --rm --network nox-post_default \
  -e DATABASE_URL="postgresql://noxpost:$POSTGRES_PASSWORD@postgres:5432/noxpost" \
  "nox-post:$SHA" node --import tsx/esm scripts/migrate.ts

echo "→ subindo"
$DC up -d --pull never
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' nox-post-api-1)" = healthy ] && { echo "✔ api saudável ($SHA)"; break; }
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' nox-post-api-1)" = healthy ] || { docker logs --tail 20 nox-post-api-1; exit 1; }
docker image prune -f >/dev/null
REMOTE
