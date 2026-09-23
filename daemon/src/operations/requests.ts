import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { OperationField } from "../protocol/OperationField.ts";
import type { EngineBody } from "../handler/router.ts";
import wire from "../protocol/wire.generated.json" with { type: "json" };

export type CoreRequest = Exclude<ClientMessage, { type: "hello" | "command" }>;
type RequestPlan = { kind: "cancel" } | { kind: "generation"; body: EngineBody; regen: boolean };
type Presentation<N extends CoreRequest["type"]> = Pick<OperationDescriptor, "label" | "scope" | "effects"> & {
  fields: { [K in Exclude<keyof Extract<CoreRequest, { type: N }>, "type" | "rid">]-?: OperationField };
};

function register<N extends CoreRequest["type"]>(name: N, presentation: Presentation<N>, prepare: (request: Extract<CoreRequest, { type: N }>) => RequestPlan) {
  return { name, presentation, invoke(request: CoreRequest): RequestPlan {
    if (request.type !== name) throw new Error(`Wrong request handler: ${name}`);
    return prepare(request as Extract<CoreRequest, { type: N }>);
  } };
}

const stream = { label: "Stream response", hint: "Show the response as it arrives. Turn off to wait for the completed response." };
export const coreRequests = {
  message: register("message", { label: "Send message", scope: "character", effects: ["history_write", "provider_call"], fields: {
    text: { label: "Message", multiline: true }, stream,
    images: { label: "Original image paths", hint: "Record the original names of images that could not be uploaded. Paths alone do not attach files; use Attach images to upload them." },
    image_data: { label: "Attached images", hint: "Choose files or paste images into the composer." },
    absence_seconds: { label: "Time away in seconds", hint: "Compatibility field. This daemon accepts the value but does not use it to change responses." },
  } }, (request) => ({ kind: "generation", regen: false, body: {
    rid: request.rid ?? null, text: request.text, stream: request.stream, images: request.images ?? [], image_data: request.image_data ?? [],
    ...(request.absence_seconds === undefined ? {} : { absence_seconds: request.absence_seconds }),
  } })),
  regen: register("regen", { label: "Regenerate response", scope: "character", effects: ["history_write", "provider_call"], fields: {
    stream, guidance: { label: "Guidance", multiline: true, hint: "Optional instructions for the alternative response." },
  } }, (request) => ({ kind: "generation", regen: true, body: {
    rid: request.rid ?? null, text: "", stream: request.stream, images: [], image_data: [],
    ...(request.guidance === undefined || request.guidance === null ? {} : { guidance: request.guidance }),
  } })),
  cancel: register("cancel", { label: "Stop work", scope: "global", effects: ["runtime_write"], fields: {} }, () => ({ kind: "cancel" })),
} satisfies Record<CoreRequest["type"], { invoke(request: CoreRequest): RequestPlan }>;

export function requestCatalogue(characterAvailable = true): OperationDescriptor[] {
  const variants = wire.client.oneOf.filter((variant) => !["hello", "command"].includes(variant.properties.type.const));
  if (variants.length !== Object.keys(coreRequests).length) throw new Error("Unaccounted core request handlers");
  return Object.values(coreRequests).map(({ name, presentation }) => {
    const variant = variants.find((item) => item.properties.type.const === name);
    if (variant === undefined) throw new Error(`Missing core request contract: ${name}`);
    const definitions: Record<string, { type: string; properties?: Record<string, unknown>; required?: readonly string[] }> = wire.client.$defs;
    const payload = definitions[variant.$ref.slice("#/$defs/".length)];
    if (payload === undefined) throw new Error(`Missing core request payload: ${name}`);
    const properties = Object.fromEntries(Object.entries(payload.properties ?? {}).filter(([key]) => key !== "rid"));
    if (Object.keys(properties).sort().join(",") !== Object.keys(presentation.fields).sort().join(",")) throw new Error(`Unaccounted core request fields: ${name}`);
    const completion = wire.server.oneOf.find((item) => item.properties.type.const === "request_finished");
    return { name, ...presentation, category: "Conversation", prerequisites: [], confirmation: "none", available: presentation.scope !== "character" || characterAvailable,
      input: { type: "object", properties, required: (payload.required ?? []).filter((key) => key !== "rid"), additionalProperties: false, $defs: wire.client.$defs },
      output: name === "cancel" ? { type: "null", description: "Cancellation has no separate acknowledgement. Observe the interrupted requests and their completion events." } : { ...completion, $defs: wire.server.$defs },
    };
  });
}
