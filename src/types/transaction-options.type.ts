import type { ISOLATION_LEVEL } from '../constants/isolation-level.constant';
import type { NestedTransaction } from './nested-transaction.type';
import type { RetryOptions } from './retry-options.type';
import type { SessionBaseline } from './session-baseline.type';
import type { TransactionObserver } from './transaction-observer.type';
import type { TransactionStage } from './transaction-stage.type';

export interface TransactionOptions {
  /**
   * Во что превратить отказ перед тем, как бросить. По умолчанию — исходная
   * ошибка как есть. Проекту, который ждёт отказ в форме TypeORM
   * `QueryFailedError`, сюда — своя фабрика.
   */
  readonly wrapFailure?: (stage: TransactionStage, error: unknown) => unknown;
  /** Уровень изоляции (по умолчанию — уровень сервера, обычно READ COMMITTED). */
  readonly isolationLevel?: (typeof ISOLATION_LEVEL)[keyof typeof ISOLATION_LEVEL];
  /** `READ ONLY`: запись в транзакции — отказ сервера. */
  readonly readOnly?: boolean;
  /**
   * `DEFERRABLE`. Действует только в SERIALIZABLE READ ONLY; в остальных режимах
   * Postgres принимает его молча и не применяет (проверено на 17: `BEGIN
   * DEFERRABLE` под READ COMMITTED — без ошибки). До BEGIN не проверяется
   * намеренно: уровень и режим могут прийти из `default_transaction_*`
   * сервера или роли, и тогда тот же `BEGIN DEFERRABLE` действует.
   */
  readonly deferrable?: boolean;
  /** Потолки транзакции (`SET LOCAL` через set_config), мс; целые > 0 и ≤ POSTGRES_LIMIT.MAX_TIMEOUT_MS. */
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  /**
   * Потолок простоя транзакции: работа, зависшая на внешнем вызове внутри
   * транзакции, держала бы соединение пула и блокировки строк бессрочно —
   * сервер прервёт сессию, и соединение будет уничтожено.
   */
  readonly idleInTransactionTimeoutMs?: number;
  /**
   * Повтор ВСЕЙ транзакции: по умолчанию на 40001 (serialization_failure) и
   * 40P01 (deadlock_detected), причины — `retry.on` (`RETRY_REASON`) и
   * `retry.when`. Выключен, пока не задан: работа обязана быть идемпотентной
   * (повтор выполнит её заново целиком). Пауза между попытками —
   * `backoffMs × 2^попытка` со случайной добавкой (full jitter).
   */
  readonly retry?: RetryOptions;
  /**
   * Отмена (SIGTERM пода, дедлайн запроса): отменённый вызов не берёт
   * соединение и не шлёт BEGIN, ожидание свободного соединения пула и пауза
   * между повторами прерываются — наружу `signal.reason`. Идущую попытку не
   * прерывает: работа, которой это нужно, слушает тот же сигнал сама.
   */
  readonly signal?: AbortSignal;
  /**
   * Свои параметры транзакции (`set_config(имя, значение, true)`) — тем же
   * запросом, что таймауты: контекст RLS (`{ 'app.tenant_id': id }`) без
   * лишнего обращения к базе. Только на транзакцию: следующему владельцу
   * соединения (и соседу под пулером) не достаются.
   */
  readonly localSettings?: Readonly<Record<string, string>>;
  /**
   * Свои параметры (`префикс.имя`), которые в конце работы, до COMMIT,
   * возвращаются к значению по умолчанию сессии (`set_config(имя, NULL, false)`
   * — как `RESET`: значение `ALTER ROLE/DATABASE … SET` или стартового пакета).
   * Для библиотеки-обёртки, задающей свой параметр на транзакцию: работа могла
   * оставить его сессионно в обход текстового фильтра пулера (`EXECUTE` в DO,
   * функция), а свои параметры сверка `transactionPooler` не видит — без сброса
   * значение досталось бы соседу. Сброс шлёт сам пакет, мимо фильтра: из работы
   * та же форма — по-прежнему `PoolerIncompatibleError`. Параметр, которого в
   * сессии нет, не объявляется. Работа поймала отказ и транзакция прервана —
   * сброс пропускается (ROLLBACK снимет её сессионные значения сам). Отложенные
   * триггеры (`DEFERRABLE INITIALLY DEFERRED`) при COMMIT видят уже сброшенное
   * значение. Под точкой сохранения — отказ: сброс посреди внешней транзакции
   * снял бы её параметры.
   */
  readonly resetAppSettings?: readonly string[];
  /**
   * Вызов внутри работы другой транзакции того же пула: по умолчанию отказ
   * (`NestedTransactionError`), `NESTED_TRANSACTION.savepoint` — точка
   * сохранения во внешней транзакции. Под точкой сохранения опции уровня
   * транзакции (изоляция, режим, таймауты, свои параметры, повтор) — отказ:
   * они принадлежат внешней.
   */
  readonly nested?: NestedTransaction;
  /**
   * Потолок ROLLBACK и уборки сессии, мс (по умолчанию
   * `TRANSACTION_DEFAULTS.ROLLBACK_TIMEOUT_MS`): «молчащее» соединение
   * уничтожается по нему, а не держит слот пула до таймаута TCP.
   */
  readonly rollbackTimeoutMs?: number;
  /**
   * Убрать сессионное состояние работы перед возвратом соединения в пул
   * (`SET` без LOCAL, `LISTEN`, сессионные advisory-локи, временные таблицы,
   * курсоры WITH HOLD) — одним запросом после конца транзакции. Без опции оно
   * уезжает следующему владельцу соединения. Не сработала — соединение
   * уничтожается. К какому состоянию — `sessionBaseline` (по умолчанию к
   * состоянию после connect).
   */
  readonly resetSession?: boolean;
  /**
   * Базовая линия `resetSession` (`SESSION_BASELINE`):
   *  - `connect` (по умолчанию) — к состоянию, в котором соединение пришло в
   *    первую транзакцию с `resetSession`: то, что задал `pool.on('connect')`
   *    (`SET search_path`, `SET TIME ZONE`, `SET ROLE`, `LISTEN`), остаётся,
   *    а то, что сменила работа, откатывается. Снимок — один раз на соединение,
   *    тем же сообщением, что BEGIN (лишнего обращения к базе нет). На
   *    соединении после connect уже есть временный объект, курсор WITH HOLD или
   *    сессионный advisory-лок — отказ: уборка сняла бы их безвозвратно;
   *  - `defaults` — к значениям по умолчанию сессии (`RESET ALL`): остаются
   *    параметры старта сессии и `ALTER ROLE/DATABASE … SET`, заданное на
   *    connect теряется.
   * Без `resetSession` — отказ.
   */
  readonly sessionBaseline?: SessionBaseline;
  /**
   * Соединение идёт через пулер в transaction mode (PgBouncer, Odyssey). Два рубежа:
   *  - до отправки: запросы работы с сессионным состоянием (`SET` без LOCAL,
   *    `RESET`, `LISTEN`, `PREPARE`/`DEALLOCATE`, `DISCARD`, `LOAD`, курсор WITH
   *    HOLD, временные объекты без ON COMMIT DROP, сессионный advisory-лок,
   *    `set_config` с `is_local`, не доказанным как true — в том числе
   *    параметром `$n` со значением false) и именованные подготовленные
   *    операторы — отказ `PoolerIncompatibleError`. По тексту запроса;
   *  - после транзакции: состояние серверного соединения (параметры сессии,
   *    роль, временные объекты, курсоры WITH HOLD, подготовленные операторы,
   *    LISTEN, сессионные advisory-локи) сверяется со снимком в начале —
   *    разница `SessionStateLeakError`. Не зависит от текста: ловит DO-блок,
   *    функцию, `EXECUTE`. Первый запрос транзакции — снимок, поэтому
   *    `SET TRANSACTION ISOLATION LEVEL`/`SNAPSHOT` в работе отвергнет сервер:
   *    уровень изоляции — опцией `isolationLevel`.
   * Проверку настроек пула на старте делает `assertPoolerCompatible`.
   */
  readonly transactionPooler?: boolean;
  /**
   * Сверка состояния серверного соединения под `transactionPooler` (по умолчанию
   * включена). `false` — остаётся только фильтр текста: сверка стоит около
   * 0,5 мс работы сервера на каждый из двух снимков (замер в README), и для
   * горячего пути это можно решить в её пользу. Без `transactionPooler` — отказ:
   * сверять нечего.
   */
  readonly sessionStateCheck?: boolean;
  /**
   * Наблюдение за пулом и попытками — для метрик. Под точкой сохранения
   * (`nested: savepoint`) не вызывается: своего соединения и попыток у неё нет,
   * их видит наблюдатель внешней транзакции.
   */
  readonly observer?: TransactionObserver;
}
