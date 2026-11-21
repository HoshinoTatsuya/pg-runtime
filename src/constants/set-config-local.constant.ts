/**
 * Разбор `set_config(имя, значение, is_local)`: вызов (в том числе
 * `pg_catalog.set_config`), третий аргумент — литерал `true` или параметр `$n`
 * (с приведением к bool или без), и значения параметра, которые сервер читает
 * как true (регистр и пробелы по краям не важны).
 */
export const SET_CONFIG_LOCAL = Object.freeze({
  call: /\bset_config\s*\(/gi,
  literal: /^true(?:\s*::\s*bool(?:ean)?)?$/i,
  parameter: /^\$(\d+)(?:\s*::\s*bool(?:ean)?)?$/i,
  trueText: /^\s*(?:true|t|on|yes|y|1)\s*$/i,
});
