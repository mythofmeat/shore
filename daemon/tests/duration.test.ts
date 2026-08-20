import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import { ConfigDuration } from "../src/config/duration.ts";
import { parseCacheKeepalive } from "../src/config/models.ts";

type ParseCase = { raw: string; millis: string; err?: undefined } | { raw: string; millis?: undefined; err: string };

const PARSE: readonly ParseCase[] = [
  { raw: "0", millis: "0" },
  { raw: "1", millis: "1000" },
  { raw: "30", millis: "30000" },
  { raw: "007", millis: "7000" },
  { raw: "18446744073709551615", err: "duration too large: 18446744073709551615" },
  { raw: "18446744073709551616", err: "invalid duration: 18446744073709551616" },
  { raw: "99999999999999999999999", err: "invalid duration: 99999999999999999999999" },
  { raw: "500ms", millis: "500" },
  { raw: "30s", millis: "30000" },
  { raw: "2m", millis: "120000" },
  { raw: "1h", millis: "3600000" },
  { raw: "2d", millis: "172800000" },
  { raw: "0s", millis: "0" },
  { raw: "0ms", millis: "0" },
  { raw: "1.5h", millis: "5400000" },
  { raw: "0.5s", millis: "500" },
  { raw: ".5h", millis: "1800000" },
  { raw: "1.h", millis: "3600000" },
  { raw: "1.0s", millis: "1000" },
  { raw: "0.0001s", millis: "0" },
  { raw: "1.999ms", millis: "1" },
  { raw: "1.5d", millis: "129600000" },
  { raw: "1.00000000000000000000000000000000000000s", millis: "1000" },
  { raw: "1.000000000000000000000000000000000000000s", err: "duration fractional precision is too large: 1.000000000000000000000000000000000000000s" },
  { raw: "", err: "duration string is empty" },
  { raw: "   ", err: "duration string is empty" },
  { raw: "-1s", err: "duration cannot be negative" },
  { raw: "-0", err: "duration cannot be negative" },
  { raw: "abc", err: "invalid duration suffix: abc" },
  { raw: "1x", err: "invalid duration suffix: x" },
  { raw: "s", err: "invalid number in duration: s" },
  { raw: "ms", err: "invalid number in duration: ms" },
  { raw: ".", err: "invalid duration: ." },
  { raw: "..", err: "invalid duration: .." },
  { raw: ".s", err: "invalid number in duration: .s" },
  { raw: ".ms", err: "invalid number in duration: .ms" },
  { raw: "..s", err: "invalid number in duration: ..s" },
  { raw: "1.2.3h", err: "invalid number in duration: 1.2.3h" },
  { raw: "1.5", err: "invalid duration: 1.5" },
  { raw: "1 s", err: "invalid duration suffix:  s" },
  { raw: "1s ", millis: "1000" },
  { raw: " 1s", millis: "1000" },
  { raw: "1S", err: "invalid duration suffix: S" },
  { raw: "1H", err: "invalid duration suffix: H" },
  { raw: "1é", err: "invalid duration suffix: é" },
  { raw: "1🎵", err: "invalid duration suffix: 🎵" },
  { raw: "﻿30s", err: "invalid duration suffix: ﻿30s" },
  { raw: "30s", millis: "30000" },
  { raw: " 30s", millis: "30000" },
  { raw: "　30s", millis: "30000" },
  { raw: "18446744073709551615ms", millis: "18446744073709551615" },
  { raw: "18446744073709551616ms", err: "duration too large: 18446744073709551616ms" },
  { raw: "9999999999999999d", err: "duration too large: 9999999999999999d" },
];

describe("ConfigDuration.parse", () => {
  for (const c of PARSE) {
    const label = c.raw === "" ? "(empty)" : JSON.stringify(c.raw);
    test(`${label} -> ${c.err ?? `${c.millis}ms`}`, () => {
      const got = ConfigDuration.parse(c.raw);
      if (c.err !== undefined) {
        expect("err" in got, `${label} was accepted`).toBe(true);
        expect((got as { err: string }).err).toBe(c.err);
      } else {
        expect("ok" in got, `${label} was rejected`).toBe(true);
        expect((got as { ok: ConfigDuration }).ok.asMillisExact().toString()).toBe(c.millis);
      }
    });
  }

  test("the corpus still covers the shapes it was built for", () => {
    const raws = PARSE.map((c) => c.raw);
    expect(raws.some((r) => r.startsWith("\uFEFF")), "byte order mark").toBe(true);
    expect(raws.some((r) => /^[\u0085\u00A0\u3000]/.test(r)), "unicode spaces").toBe(true);
    expect(raws.some((r) => r.includes("18446744073709551616")), "u64 overflow").toBe(true);
    expect(raws.some((r) => r.startsWith("-")), "negative").toBe(true);
    expect(raws.some((r) => r.length > 30), "fractional precision ceiling").toBe(true);
    expect(PARSE.filter((c) => c.err !== undefined).length, "error cases").toBeGreaterThan(20);
  });
});

const DISPLAY: readonly { millis: string; display: string; secs: string }[] = [
  { millis: "0", display: "0s", secs: "0" },
  { millis: "1", display: "1ms", secs: "0" },
  { millis: "999", display: "999ms", secs: "0" },
  { millis: "1000", display: "1s", secs: "1" },
  { millis: "1500", display: "1500ms", secs: "1" },
  { millis: "60000", display: "1m", secs: "60" },
  { millis: "90000", display: "90s", secs: "90" },
  { millis: "3600000", display: "1h", secs: "3600" },
  { millis: "3300000", display: "55m", secs: "3300" },
  { millis: "86400000", display: "1d", secs: "86400" },
  { millis: "172800000", display: "2d", secs: "172800" },
  { millis: "18446744073709551615", display: "18446744073709551615ms", secs: "18446744073709551" },
];

describe("ConfigDuration renders back to something re-parseable", () => {
  for (const c of DISPLAY) {
    test(`${c.millis}ms -> ${c.display}`, () => {
      const d = ConfigDuration.fromMillis(BigInt(c.millis));
      expect(d.toString()).toBe(c.display);
      expect(d.asSecs().toString()).toBe(c.secs);
    });
  }

  test("every rendering parses back to the value it came from", () => {
    for (const c of DISPLAY) {
      const parsed = ConfigDuration.parse(c.display);
      expect("ok" in parsed, `${c.display} did not re-parse`).toBe(true);
      expect((parsed as { ok: ConfigDuration }).ok.asMillisExact().toString()).toBe(c.millis);
    }
  });
});

const FROM_SECS: readonly { secs: string; millis: string }[] = [
  { secs: "0", millis: "0" },
  { secs: "1", millis: "1000" },
  { secs: "30", millis: "30000" },
  { secs: "18446744073709551", millis: "18446744073709551000" },
  { secs: "18446744073709552", millis: "18446744073709551615" },
  { secs: "18446744073709551615", millis: "18446744073709551615" },
];

test("fromSecs scales without losing the value", () => {
  for (const c of FROM_SECS) {
    expect(ConfigDuration.fromSecs(BigInt(c.secs)).asMillisExact().toString(), c.secs).toBe(c.millis);
  }
});

type KeepaliveCase =
  | { raw: string; display: string; intervalMillis: string | null; err?: undefined }
  | { raw: string; display?: undefined; intervalMillis?: undefined; err: string };

const KEEPALIVE: readonly KeepaliveCase[] = [
  { raw: "off", display: "off", intervalMillis: null },
  { raw: "none", display: "off", intervalMillis: null },
  { raw: "disabled", display: "off", intervalMillis: null },
  { raw: "false", display: "off", intervalMillis: null },
  { raw: "0", display: "off", intervalMillis: null },
  { raw: "OFF", display: "off", intervalMillis: null },
  { raw: "Off", display: "off", intervalMillis: null },
  { raw: "oFf", display: "off", intervalMillis: null },
  { raw: "  off  ", display: "off", intervalMillis: null },
  { raw: "55m", display: "55m", intervalMillis: "3300000" },
  { raw: "6h", display: "6h", intervalMillis: "21600000" },
  { raw: "30s", display: "30s", intervalMillis: "30000" },
  { raw: "0s", err: "cache_keepalive interval must be > 0; use \"off\" to disable" },
  { raw: "0ms", err: "cache_keepalive interval must be > 0; use \"off\" to disable" },
  { raw: "", err: "duration string is empty" },
  { raw: "nope", err: "invalid duration suffix: nope" },
  { raw: "-1s", err: "duration cannot be negative" },
  { raw: "İ", err: "invalid duration suffix: İ" },
  { raw: "K", err: "invalid duration suffix: K" },
];

describe("parseCacheKeepalive", () => {
  for (const c of KEEPALIVE) {
    test(`${JSON.stringify(c.raw)} -> ${c.err ?? c.display}`, () => {
      const got = parseCacheKeepalive(c.raw);
      if (c.err !== undefined) {
        expect("err" in got, `${c.raw} was accepted`).toBe(true);
        expect((got as { err: string }).err).toBe(c.err);
        return;
      }
      expect("ok" in got, `${c.raw} was rejected`).toBe(true);
      const setting = (got as { ok: { kind: string; interval?: ConfigDuration } }).ok;
      if (c.intervalMillis === null) {
        expect(setting.kind).toBe("off");
      } else {
        expect(setting.kind).toBe("every");
        expect(required(setting.interval).asMillisExact().toString()).toBe(c.intervalMillis);
      }
    });
  }

  test("off has three spellings and they all mean the same thing", () => {
    for (const spelling of ["off", "none", "disabled"]) {
      const got = parseCacheKeepalive(spelling);
      expect("ok" in got, spelling).toBe(true);
      expect((got as { ok: { kind: string } }).ok.kind).toBe("off");
    }
  });
});
