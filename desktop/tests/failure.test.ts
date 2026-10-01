import { describe, expect, test } from "bun:test";
import { describeHttpFailure, describeLoadFailure, retryDelay } from "../src/failure.ts";

describe("describeLoadFailure", () => {
  test("names the likely cause for common network errors", () => {
    expect(describeLoadFailure("ERR_CONNECTION_REFUSED").title).toBe("Nothing is listening at this address");
    expect(describeLoadFailure("ERR_NAME_NOT_RESOLVED").detail).toContain("Tailscale");
    expect(describeLoadFailure("ERR_CONNECTION_TIMED_OUT").title).toBe("The daemon's host didn't answer");
    expect(describeLoadFailure("ERR_ADDRESS_UNREACHABLE")).toEqual(describeLoadFailure("ERR_CONNECTION_TIMED_OUT"));
  });

  test("a non-HTTP answer points at the port, including the CLI's", () => {
    for (const error of ["ERR_EMPTY_RESPONSE", "ERR_INVALID_HTTP_RESPONSE", "ERR_CONNECTION_RESET"]) {
      expect(describeLoadFailure(error).detail).toContain("Port 7320 is the CLI's");
    }
  });

  test("TLS problems mention the certificate and the scheme", () => {
    expect(describeLoadFailure("ERR_CERT_AUTHORITY_INVALID").detail).toContain("tls_cert");
    expect(describeLoadFailure("ERR_SSL_PROTOCOL_ERROR").detail).toContain("http://");
  });

  test("unknown errors keep Chromium's code", () => {
    expect(describeLoadFailure("ERR_SOMETHING_NEW")).toEqual({ title: "Shore couldn't load", detail: "ERR_SOMETHING_NEW" });
  });
});

describe("describeHttpFailure", () => {
  test("503 is the daemon still starting", () => {
    expect(describeHttpFailure(503).title).toBe("The daemon isn't ready yet");
  });

  test("other statuses are reported as they are", () => {
    expect(describeHttpFailure(404).title).toBe("The server answered with HTTP 404");
  });
});

describe("retryDelay", () => {
  test("backs off to thirty seconds and stays there", () => {
    expect([0, 1, 2, 3, 4, 5, 40].map(retryDelay)).toEqual([2, 2, 5, 10, 30, 30, 30]);
  });
});
