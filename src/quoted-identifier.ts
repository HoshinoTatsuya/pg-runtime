/** Идентификатор SQL в двойных кавычках (регистр и любые символы сохраняются). */
export function quotedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
