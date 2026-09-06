import { afterEach, describe, expect, it } from "vitest";

import {
  configureLoggerForTests,
  logger,
  resetLoggerForTests,
  resolveLogLevel,
} from "./logger.js";

describe("resolveLogLevel", () => {
  it("defaults to error under Vitest so warn/info stay silent", () => {
    expect(resolveLogLevel({ VITEST: "true" })).toBe("error");
  });

  it("restores info when VIDEOBOOK_TEST_LOG=1", () => {
    expect(resolveLogLevel({ VITEST: "true", VIDEOBOOK_TEST_LOG: "1" })).toBe("info");
  });

  it("keeps info outside Vitest so the dev server still logs", () => {
    expect(resolveLogLevel({})).toBe("info");
  });

  it("lets VIDEOBOOK_LOG_LEVEL override both defaults", () => {
    expect(resolveLogLevel({ VITEST: "true", VIDEOBOOK_LOG_LEVEL: "silent" })).toBe("silent");
    expect(resolveLogLevel({ VIDEOBOOK_LOG_LEVEL: "debug" })).toBe("debug");
  });
});

describe("logger sink", () => {
  afterEach(() => {
    resetLoggerForTests();
  });

  it("drops warn/info at the Vitest default and keeps error", () => {
    const lines: string[] = [];
    configureLoggerForTests({
      level: "error",
      sink: {
        error: (...args) => lines.push(`error:${args.map(String).join(" ")}`),
        warn: (...args) => lines.push(`warn:${args.map(String).join(" ")}`),
        info: (...args) => lines.push(`info:${args.map(String).join(" ")}`),
        debug: (...args) => lines.push(`debug:${args.map(String).join(" ")}`),
      },
    });
    logger.info("mcp", { status: "ok", durationMs: 12 });
    logger.warn("heartbeat-failed");
    logger.error("startup-failed");
    expect(lines).toEqual(['error:[startup-failed] {"event":"startup-failed"}']);
  });

  it("restores warn and info when the test log flag is on", () => {
    const lines: string[] = [];
    configureLoggerForTests({
      level: resolveLogLevel({ VITEST: "true", VIDEOBOOK_TEST_LOG: "1" }),
      sink: {
        error: (...args) => lines.push(`error:${args.map(String).join(" ")}`),
        warn: (...args) => lines.push(`warn:${args.map(String).join(" ")}`),
        info: (...args) => lines.push(`info:${args.map(String).join(" ")}`),
        debug: (...args) => lines.push(`debug:${args.map(String).join(" ")}`),
      },
    });
    logger.info("mcp", { status: "ok", durationMs: 12 });
    logger.warn("provider-poll-failed");
    expect(lines).toEqual([
      'info:[mcp] {"event":"mcp","durationMs":12,"status":"ok"}',
      'warn:[provider-poll-failed] {"event":"provider-poll-failed"}',
    ]);
  });
});
