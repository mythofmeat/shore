import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import { Field } from "./components.tsx";
import { actionControl, initialValue } from "./forms.ts";

export function RequestFields({ request, values, change, omit = [], secret = [] }: { request: OperationDescriptor; values: Record<string, unknown>; change: (values: Record<string, unknown>) => void; omit?: readonly string[]; secret?: readonly string[] }) {
  const control = actionControl(request);
  return <>{Object.entries(control.fields).filter(([key]) => !omit.includes(key)).map(([key, field]) => {
    const presentation = request.fields[key];
    const label = presentation?.label ?? key;
    return <section className="action-field" key={key}>
      {control.required.includes(key) ? null : <label className="check"><input type="checkbox" checked={Object.hasOwn(values, key)} onChange={(event) => change(event.target.checked ? { ...values, [key]: initialValue(field) } : Object.fromEntries(Object.entries(values).filter(([name]) => name !== key)))} />Set {label}</label>}
      {Object.hasOwn(values, key) ? <Field control={field} value={values[key]} label={label} secret={secret.includes(key)} {...(presentation === undefined ? {} : { presentation })} change={(value) => change({ ...values, [key]: value })} /> : <p className="muted">{label}: omitted</p>}
      {presentation?.hint === undefined ? null : <small>{presentation.hint}</small>}
    </section>;
  })}</>;
}
