import type { WebProblem } from "../protocol/WebProblem.ts";
import type { LoginFailures } from "./auth.ts";
import { validWebPassword, validWebProblem, validWebSignInStart, validWebSignInState } from "./contracts.ts";
import { DEVICE_NAME_RULE, deviceName, type DeviceStore } from "./devices.ts";
import { acceptablePassword, PASSWORD_RULE, PasswordFileError, type PasswordStore } from "./password.ts";
import { checked, securityHeaders } from "./policy.ts";

export const NO_PASSWORD = "This daemon has no password yet. Choose one first.";
export const BUSY = "Too many sign-in attempts; try again in a minute";

export function problem(status: number, code: WebProblem["code"], message: string): Response {
  return Response.json(checked(validWebProblem, { code, message }, "browser error response"), { status, headers: securityHeaders() });
}

export class SignInDoor {
  #attempts = 0;

  constructor(
    readonly passwords: PasswordStore,
    readonly devices: DeviceStore,
    readonly failures: LoginFailures,
    readonly capacity: number,
  ) {}

  state(): Response {
    return Response.json(checked(validWebSignInState, { password_set: this.passwords.isSet() }, "sign-in state"), { headers: securityHeaders() });
  }

  async attempt(work: () => Promise<Response>): Promise<Response> {
    if (this.#attempts >= this.capacity) return problem(429, "too_many_requests", BUSY);
    this.#attempts += 1;
    try { return await work(); } catch (error) {
      if (error instanceof PasswordFileError) return problem(503, "unavailable", error.message);
      throw error;
    } finally {
      this.#attempts -= 1;
    }
  }

  async refusal(client: string, password: string): Promise<Response | undefined> {
    if (this.failures.refused(client)) return problem(429, "too_many_requests", BUSY);
    if (!this.passwords.isSet()) return problem(403, "forbidden", NO_PASSWORD);
    if (await this.passwords.matches(password)) {
      this.failures.succeeded(client);
      return undefined;
    }
    this.failures.failed(client);
    return problem(401, "unauthorized", "That password isn’t right");
  }

  async cli(body: unknown, client: string): Promise<Response> {
    if (!validWebSignInStart(body)) return problem(400, "invalid_request", "Name this device and give the daemon’s password");
    const name = deviceName(body.name);
    if (name === undefined) return problem(400, "invalid_request", DEVICE_NAME_RULE);
    const refused = await this.refusal(client, body.password);
    if (refused !== undefined) return refused;
    const created = this.devices.create("cli", name);
    return Response.json({ token: created.token }, { headers: securityHeaders() });
  }

  async password(body: unknown, client: string): Promise<Response> {
    if (!validWebPassword(body)) return problem(400, "invalid_request", "Send the new password, and the current one if the daemon has one");
    if (!acceptablePassword(body.password)) return problem(400, "invalid_request", PASSWORD_RULE);
    if (body.current === undefined) {
      if (!await this.passwords.choose(body.password)) return problem(403, "forbidden", "This daemon already has a password. Give the current one to change it.");
    } else {
      const refused = await this.refusal(client, body.current);
      if (refused !== undefined) return refused;
      await this.passwords.change(body.password);
    }
    return new Response(null, { status: 204, headers: securityHeaders() });
  }
}
