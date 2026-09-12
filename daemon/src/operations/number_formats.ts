export const numberFormats = {
  uint64: { type: "number", validate: (value: number) => Number.isSafeInteger(value) && value >= 0 },
  uint: { type: "number", validate: (value: number) => Number.isSafeInteger(value) && value >= 0 },
  uint32: { type: "number", validate: (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 4294967295 },
  uint16: { type: "number", validate: (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 65535 },
  double: { type: "number", validate: Number.isFinite },
} as const;
