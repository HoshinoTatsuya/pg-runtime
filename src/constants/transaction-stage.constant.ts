import { deepFreeze } from '../deep-freeze';
import { TRANSACTION_COMMAND } from './transaction-command.constant';

/**
 * Шаг транзакции, на котором случился отказ: команда начала (транзакция не
 * началась — соединение уничтожается), работа (всё между ответом на BEGIN и
 * отправкой COMMIT: работа вызывающего и запросы самого пакета внутри
 * транзакции — параметры `localSettings`, разбор снимка сессии, сброс
 * `resetAppSettings`; откат — ROLLBACK на исправном соединении) или фиксация. Для команд значение — текст ушедшей команды:
 * проекты кладут его в `query` своего `QueryFailedError` (`wrapFailure`) и
 * сравнивают стадию с `TRANSACTION_STAGE.work`, а не со строкой.
 */
export const TRANSACTION_STAGE = {
  begin: TRANSACTION_COMMAND.begin,
  work: 'work',
  commit: TRANSACTION_COMMAND.commit,
} as const;

deepFreeze(TRANSACTION_STAGE);
