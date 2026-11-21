#!/usr/bin/env bash
# Postgres и PgBouncer в transaction mode перед ним (docker), затем переданная команда.
# Адрес суперпользователя Postgres напрямую — в PG_TEST_URL, через пулер — в PG_POOLER_URL.
# Оба уже заданы (CI-сервисы) — docker не нужен.
#
# У пулера ОДНО серверное соединение на базу и роль (default_pool_size = 1): клиенты
# пулера делят его по очереди, и всё сессионное, что оставил один, видит следующий —
# ровно то, от чего защищает `transactionPooler`. Пароли ролей пулер проверяет
# запросом к pg_shadow (auth_query под суперпользователем стенда), сервер доверяет
# соединениям сети стенда (trust).
set -euo pipefail
if [[ -n "${PG_TEST_URL:-}" && -n "${PG_POOLER_URL:-}" ]]; then
  exec "$@"
fi
IMAGE="${PG_TEST_IMAGE:-postgres:17-alpine}"
# PgBouncer 1.26.1; образ закреплён по содержимому, а не по изменчивому тегу.
POOLER_IMAGE="${PG_POOLER_IMAGE:-edoburu/pgbouncer@sha256:8638aa563607256d3c7440437534195f1066a92b68015d89ae9d6b935b444a6d}"
TAG="pg-runtime-pooler-$$"
NET="${TAG}-net"
PG="${TAG}-pg"
POOLER="${TAG}-pgbouncer"
CONFIG="$(mktemp -d "${TMPDIR:-/tmp}/pg-runtime-pgbouncer-XXXXXX")"
cleanup() {
  docker rm -f -v "${PG}" "${POOLER}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  case "${CONFIG}" in
    "${TMPDIR:-/tmp}"/pg-runtime-pgbouncer-*) rm -rf "${CONFIG}" ;;
  esac
}
trap cleanup EXIT
docker network create "${NET}" >/dev/null
docker run -d --name "${PG}" --network "${NET}" -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:0:5432 "${IMAGE}" -c fsync=off >/dev/null
# Готовность — запросом ПО TCP: временный сервер initdb слушает только сокет.
for _ in $(seq 1 120); do
  if docker exec "${PG}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select 1' 2>/dev/null | grep -q 1; then
    break
  fi
  sleep 0.5
done
docker exec "${PG}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select 1' | grep -q 1 || { echo "postgres не поднялся" >&2; exit 1; }
cat >"${CONFIG}/pgbouncer.ini" <<INI
[databases]
* = host=${PG} port=5432

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
auth_user = test
auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename = \$1
pool_mode = transaction
default_pool_size = 1
max_client_conn = 200
admin_users = test
INI
echo '"test" "test"' >"${CONFIG}/userlist.txt"
chmod 644 "${CONFIG}/pgbouncer.ini" "${CONFIG}/userlist.txt"
docker run -d --name "${POOLER}" --network "${NET}" -v "${CONFIG}:/etc/pgbouncer:ro" \
  -p 127.0.0.1:0:5432 "${POOLER_IMAGE}" >/dev/null
port_of() { docker port "$1" 5432/tcp | head -1 | sed 's/.*://'; }
export PG_TEST_URL="postgres://test:test@127.0.0.1:$(port_of "${PG}")/postgres"
export PG_POOLER_URL="postgres://test:test@127.0.0.1:$(port_of "${POOLER}")/postgres"
ready=0
for _ in $(seq 1 60); do
  if node -e "const {Client}=require('pg');const c=new Client({connectionString:process.env.PG_POOLER_URL});c.connect().then(()=>c.query('select 1')).then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ "${ready}" == 1 ]] || { echo "pgbouncer не поднялся" >&2; docker logs "${POOLER}" >&2; exit 1; }
"$@"
