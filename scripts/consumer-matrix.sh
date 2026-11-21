#!/usr/bin/env bash
# Матрица потребителей: собранный пакет (npm pack) ставится в одноразовые
# проекты с разными настройками модулей, и в каждом работа БЕЗ аннотации
# транзакции пишет в таблицу потребителя (`tx.insert(своя таблица)`): тип
# транзакции обязан быть drizzle потребителя, а не копией из деклараций пакета. Проверяются tsc и ts-jest: в реальной эксплуатации проект на
# `module: commonjs` + TypeScript 6 + ts-jest 29 падал под ts-jest TS2345
# («Property 'config' is protected…»: типы drizzle из .d.ts и .d.cts одной
# установки), а tsc на том же дереве был зелёным.
#
# ESM-потребитель (`"type": "module"`, nodenext/bundler) берёт декларации пакета
# по условию `import`: без `.d.mts` он читал `.d.ts` CJS-пакета, drizzle из них
# резолвился в `.d.cts`, а у потребителя — в `.d.ts`, и `withTenant(tx)` давал
# TS2345 (два разных объявления `SQL` одной установки).
#
# Запуск: scripts/consumer-matrix.sh. Каталоги — из mkdtemp, удаляются в конце.
# Версии инструментов — как у потребителя, на котором дефект проявился, плюс
# случаи на последних drizzle-orm/pg/TypeScript (`*-latest`).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pg-runtime-consumers-XXXXXX")"
cleanup() {
  case "${WORK}" in
    "${TMPDIR:-/tmp}"/pg-runtime-consumers-*) rm -rf "${WORK}" ;;
  esac
}
trap cleanup EXIT

(cd "${ROOT}" && pnpm build >/dev/null && npm pack --silent --pack-destination "${WORK}" >/dev/null)
TARBALL="$(ls "${WORK}"/hoshinotatsuya-pg-runtime-*.tgz)"

CONSUMER_TS="import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { transactionKeepingFailure, withTenant, withAdvisoryLock, poolStats } from '@hoshinotatsuya/pg-runtime';

// skipLibCheck прячет ошибки в декларациях пакета, а нерезолвящийся импорт в них
// молча становится any: тогда транзакция «принимается» чем угодно. Утверждение
// ниже не компилируется, если хоть один экспорт стал any.
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? never : true;
export const typed: [
  NotAny<typeof transactionKeepingFailure>, NotAny<typeof withTenant>, NotAny<typeof withAdvisoryLock>,
  NotAny<typeof poolStats>,
] = [true, true, true, true];

export const counters = pgTable('counters', { value: integer('value').notNull() });
export const tableName = 'counters';
export const bump = (pool: Pool) =>
  transactionKeepingFailure(drizzle(pool), async (tx) => {
    await tx.insert(counters).values({ value: 1 });
  });
// Транзакция СОБСТВЕННОГО drizzle потребителя передаётся функции пакета.
export const tenantScoped = (pool: Pool) =>
  drizzle(pool).transaction(async (tx) => {
    await withTenant(tx, 'tenant-a');
  });
"

SPEC_TS="import { tableName } from './consumer';

it('работа без аннотации получает транзакцию drizzle потребителя', () => {
  expect(tableName).toBe('counters');
});
"

failures=0
run_case() {
  local label="$1" module="$2" resolution="$3" type="$4" jest="$5"
  local drizzle="${6:-0.45.2}" pg="${7:-8.21.0}" typescript="${8:-6.0.3}"
  local dir="${WORK}/${label}"
  mkdir -p "${dir}/src"
  cat >"${dir}/package.json" <<JSON
{
  "name": "consumer-${label}",
  "private": true,
  "type": "${type}",
  "dependencies": {
    "@hoshinotatsuya/pg-runtime": "file:${TARBALL}",
    "drizzle-orm": "${drizzle}",
    "pg": "${pg}"
  },
  "devDependencies": {
    "@types/jest": "30.0.0",
    "@types/node": "24.0.15",
    "@types/pg": "8.23.1",
    "jest": "30.4.2",
    "ts-jest": "29.4.11",
    "typescript": "${typescript}"
  }
}
JSON
  local resolution_line=""
  if [[ -n "${resolution}" ]]; then
    resolution_line="\"moduleResolution\": \"${resolution}\","
  fi
  cat >"${dir}/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "module": "${module}",
    ${resolution_line}
    "target": "ES2024",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["jest", "node"],
    "noEmit": true
  },
  "include": ["src"]
}
JSON
  printf '%s' "${CONSUMER_TS}" >"${dir}/src/consumer.ts"
  # ESM с nodenext требует расширение в относительном импорте; CJS-раннер jest — без него.
  if [[ "${type}" == "module" && "${resolution}" == "nodenext" ]]; then
    printf '%s' "${SPEC_TS}" | sed "s#'./consumer'#'./consumer.js'#" >"${dir}/src/consumer.spec.ts"
  else
    printf '%s' "${SPEC_TS}" >"${dir}/src/consumer.spec.ts"
  fi
  cat >"${dir}/jest.config.js" <<'JS'
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
};
JS
  (cd "${dir}" && pnpm install --prefer-offline --silent >"${dir}/install.log" 2>&1) || {
    echo "${label}: установка не прошла"; tail -5 "${dir}/install.log"; failures=$((failures + 1)); return
  }
  if (cd "${dir}" && node_modules/.bin/tsc -p tsconfig.json >"${dir}/tsc.log" 2>&1); then
    echo "${label}: tsc — зелёный"
  else
    echo "${label}: tsc — КРАСНЫЙ"; head -5 "${dir}/tsc.log"; failures=$((failures + 1))
  fi
  # Рантайм того же условия, которое выбирают декларации: import для ESM-проекта, require — для CJS.
  # Проверка пула читает параметры старта кодом pg ПОТРЕБИТЕЛЯ (pg/lib/connection-parameters):
  # строка без хоста с options — отказ, чистая — проходит.
  local runtime='const p = require("@hoshinotatsuya/pg-runtime"); const PG = require("pg"); if (typeof p.withTenant !== "function") process.exit(1); const { Pool } = PG; const bad = new Pool({ connectionString: "postgres://u@/db?host=/tmp&options=-c%20x%3D1" }); let refused = false; try { p.assertPoolerCompatible(bad); } catch (e) { refused = e.name === "PoolerIncompatibleError"; } p.assertPoolerCompatible(new Pool({ connectionString: "postgres://u@h/db" })); if (!refused) process.exit(2);'
  local input_type=commonjs
  if [[ "${type}" == "module" ]]; then
    runtime='const p = await import("@hoshinotatsuya/pg-runtime"); const PG = (await import("pg")).default; if (typeof p.withTenant !== "function") process.exit(1); const { Pool } = PG; const bad = new Pool({ connectionString: "postgres://u@/db?host=/tmp&options=-c%20x%3D1" }); let refused = false; try { p.assertPoolerCompatible(bad); } catch (e) { refused = e.name === "PoolerIncompatibleError"; } p.assertPoolerCompatible(new Pool({ connectionString: "postgres://u@h/db" })); if (!refused) process.exit(2);'
    input_type=module
  fi
  if (cd "${dir}" && node --input-type="${input_type}" -e "${runtime}" >"${dir}/runtime.log" 2>&1); then
    echo "${label}: рантайм входа — зелёный"
  else
    echo "${label}: рантайм входа — КРАСНЫЙ"; head -5 "${dir}/runtime.log"; failures=$((failures + 1))
  fi
  if [[ "${jest}" == "jest" ]]; then
    if (cd "${dir}" && node_modules/.bin/jest --maxWorkers=2 >"${dir}/jest.log" 2>&1); then
      echo "${label}: ts-jest — зелёный ($(grep -E '^Tests:' "${dir}/jest.log"))"
    else
      echo "${label}: ts-jest — КРАСНЫЙ"; grep -E 'TS[0-9]+|Tests:' "${dir}/jest.log" | head -5; failures=$((failures + 1))
    fi
  fi
}

run_case commonjs commonjs "" commonjs jest
run_case node16 node16 node16 commonjs jest
run_case nodenext nodenext nodenext commonjs jest
run_case bundler-esm esnext bundler module tsc-only
run_case nodenext-esm nodenext nodenext module tsc-only
# Последние версии зависимостей. ts-jest 29 не поддерживает TypeScript 7 — под ним только tsc.
run_case commonjs-latest commonjs "" commonjs jest 0.45.4 8.23.1
run_case nodenext-esm-latest nodenext nodenext module tsc-only 0.45.4 8.23.1
run_case nodenext-esm-ts7 nodenext nodenext module tsc-only 0.45.4 8.23.1 7.0.2
run_case commonjs-ts7 commonjs "" commonjs tsc-only 0.45.4 8.23.1 7.0.2

if [[ "${failures}" -gt 0 ]]; then
  echo "матрица потребителей: красных ${failures}"
  exit 1
fi
echo "матрица потребителей: все зелёные"
