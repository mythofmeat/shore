import Ajv2020 from "ajv/dist/2020.js";

export function contractValidator(): Ajv2020 {
  const validator = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  validator.addFormat("uint64", { type: "number", validate: Number.isSafeInteger });
  validator.addFormat("uint32", { type: "number", validate: (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 4294967295 });
  return validator;
}
