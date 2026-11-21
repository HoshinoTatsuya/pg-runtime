/** Целое > 0 или `undefined`; иначе отказ с именем опции. 0 у Postgres — «без потолка». */
export function positiveInt(name: string, value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`transactionKeepingFailure: ${name} — целое больше нуля, получено ${value}`);
  }
  return value;
}
