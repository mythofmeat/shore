import { createHash } from "node:crypto";
import inventory from "./capabilities.generated.json" with { type: "json" };
import schemas from "../operations/schemas.generated.json" with { type: "json" };
import web from "./schemas.generated.json" with { type: "json" };
import wire from "../protocol/wire.generated.json" with { type: "json" };

export const WEB_PROTOCOL = 1;
export const WEB_CONTRACT = createHash("sha256").update(JSON.stringify({ protocol: WEB_PROTOCOL, inventory, schemas, web, wire })).digest("hex");
export const WEB_SUBPROTOCOL = `shore-web-${String(WEB_PROTOCOL)}.${WEB_CONTRACT}`;
