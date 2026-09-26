import Ajv2020 from "ajv/dist/2020.js";
import type { Options } from "ajv";
import { numberFormats } from "./number_formats.ts";

export function contractValidator(code?: Options["code"]): Ajv2020 {
  const validator = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, coerceTypes: false, useDefaults: false, removeAdditional: false, ...(code === undefined ? {} : { code }) });
  for (const [name, format] of Object.entries(numberFormats)) validator.addFormat(name, format);
  return validator;
}
