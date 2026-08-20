export function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("required value is absent");
  return value;
}
