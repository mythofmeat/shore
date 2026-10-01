import { describe, expect, test } from "bun:test";
import { externalUrl, needsSecureOverride, parseAddress, sameOrigin } from "../src/address.ts";

describe("parseAddress", () => {
  test("a bare host gets http:// and the default web port", () => {
    expect(parseAddress("meat.hydra-char.ts.net")).toEqual({ ok: true, origin: "http://meat.hydra-char.ts.net:7340" });
    expect(parseAddress("  localhost  ")).toEqual({ ok: true, origin: "http://localhost:7340" });
  });

  test("an explicit port is kept", () => {
    expect(parseAddress("100.101.102.103:9000")).toEqual({ ok: true, origin: "http://100.101.102.103:9000" });
    expect(parseAddress("[::1]:7341")).toEqual({ ok: true, origin: "http://[::1]:7341" });
  });

  test("an explicit scheme is kept without adding a port", () => {
    expect(parseAddress("https://shore.example.com")).toEqual({ ok: true, origin: "https://shore.example.com" });
    expect(parseAddress("http://localhost")).toEqual({ ok: true, origin: "http://localhost" });
  });

  test("the result is the origin, without path, query or case differences", () => {
    expect(parseAddress("HTTP://Meat:7340/workspace/nova/main?x=1#end")).toEqual({ ok: true, origin: "http://meat:7340" });
    expect(parseAddress("meat:7340/workspace")).toEqual({ ok: true, origin: "http://meat:7340" });
    expect(parseAddress("https://shore.example.com:443/")).toEqual({ ok: true, origin: "https://shore.example.com" });
  });

  test("empty, malformed and non-web addresses are refused with a reason", () => {
    for (const input of ["", "   ", "host:notaport", "http://", "ftp://host:7340", "ws://host:7340", "http://user:secret@host:7340"]) {
      const parsed = parseAddress(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).not.toBe("");
    }
  });
});

describe("needsSecureOverride", () => {
  test("plain HTTP to another machine needs the override", () => {
    expect(needsSecureOverride("http://meat.hydra-char.ts.net:7340")).toBe(true);
    expect(needsSecureOverride("http://192.168.1.20:7340")).toBe(true);
    expect(needsSecureOverride("http://localhost.example.com:7340")).toBe(true);
  });

  test("HTTPS and loopback addresses are already secure contexts", () => {
    for (const origin of ["https://shore.example.com", "http://localhost:7340", "http://shore.localhost:7340", "http://127.0.0.1:7340", "http://127.10.0.3:7340", "http://[::1]:7340"]) {
      expect(needsSecureOverride(origin)).toBe(false);
    }
  });
});

describe("externalUrl", () => {
  test("web and mail links can leave the app", () => {
    expect(externalUrl("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(externalUrl("http://example.com")).toBe("http://example.com/");
    expect(externalUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  test("other schemes never reach the system opener", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "blob:http://meat:7340/1234", "data:text/html,hi", "smb://host/share", "not a url"]) {
      expect(externalUrl(url)).toBeNull();
    }
  });
});

describe("sameOrigin", () => {
  test("compares scheme, host and port", () => {
    expect(sameOrigin("http://meat:7340/workspace/nova", "http://meat:7340")).toBe(true);
    expect(sameOrigin("http://meat:7341/", "http://meat:7340")).toBe(false);
    expect(sameOrigin("https://meat:7340/", "http://meat:7340")).toBe(false);
    expect(sameOrigin("garbage", "http://meat:7340")).toBe(false);
  });
});
