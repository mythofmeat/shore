import { InvalidArgs } from "./errors.ts";

function named(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(" or ");
}

export function actionOf<Action extends string>(
  input: Record<string, unknown>,
  takes: Readonly<Record<Action, readonly string[]>>,
): Action {
  const actions = Object.keys(takes) as Action[];
  const action = actions.find((each) => each === input["action"]);
  if (action === undefined) throw new InvalidArgs(`action must be one of ${actions.join(", ")}`);
  const misplaced = Object.keys(input).flatMap((field) => {
    if (takes[action].includes(field)) return [];
    const takenBy = actions.filter((other) => takes[other].includes(field));
    return takenBy.length === 0 ? [] : [`\`${field}\` goes with ${named(takenBy)}, not \`${action}\``];
  });
  if (misplaced.length > 0) throw new InvalidArgs(misplaced.join("; "));
  return action;
}
