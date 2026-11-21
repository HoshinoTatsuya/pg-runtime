import { deepFreeze } from '../deep-freeze';

/**
 * Почему транзакцию можно повторить целиком (`retry.on`). По умолчанию —
 * `serialization` и `deadlock`, как до 0.6.0.
 */
export const RETRY_REASON = {
  /** 40001 serialization_failure. */
  serialization: 'serialization',
  /** 40P01 deadlock_detected. */
  deadlock: 'deadlock',
  /**
   * 55P03 lock_not_available — истёк `lockTimeoutMs` (чужая транзакция держала
   * строку или таблицу) или advisory-лок `withAdvisoryLock` не взят за `timeoutMs`
   * (`AdvisoryLockTimeoutError`, код тот же).
   */
  lockTimeout: 'lock-timeout',
  /**
   * Обрыв соединения ДО работы: соединение пула не получено или BEGIN не
   * прошёл по обрыву (класс 08, 57P01–57P03, FATAL, ошибка сокета). Работа
   * не начиналась — повтор безопасен и для неидемпотентной работы.
   */
  connectionBeforeWork: 'connection-before-work',
} as const;

deepFreeze(RETRY_REASON);
