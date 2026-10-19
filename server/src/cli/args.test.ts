import { describe, expect, it } from "vitest";
import { CliUsageError, applyFlagsToEnv, helpText, parseCli, parseToolArgs, resolvePort } from "./args.js";

describe("parseCli", () => {
  it("defaults to serve with the web UI", () => {
    expect(parseCli([])).toEqual({ command: "serve", flags: { ui: true, open: false } });
    expect(parseCli(["--port", "4000", "--open"])).toEqual({ command: "serve", flags: { port: 4000, ui: true, open: true } });
  });

  it("turns the UI off with --headless or --no-ui", () => {
    expect(parseCli(["serve", "--headless"])).toMatchObject({ command: "serve", flags: { ui: false } });
    expect(parseCli(["serve", "--no-ui"])).toMatchObject({ command: "serve", flags: { ui: false } });
  });

  it("parses the shared flags for every command", () => {
    expect(parseCli(["mcp", "--library", "lib", "--home", "h", "--log-level", "warn", "--port", "0"]))
      .toEqual({ command: "mcp", flags: { port: 0, library: "lib", home: "h", logLevel: "warn" } });
    expect(parseCli(["tools"])).toEqual({ command: "tools", flags: {} });
    expect(parseCli(["gc-books"])).toEqual({ command: "gc-books", flags: {} });
    expect(parseCli(["doctor", "--json"])).toEqual({ command: "doctor", flags: { json: true } });
  });

  it("parses run with JSON-aware tool arguments and waits by default", () => {
    expect(parseCli(["run", "create_book", "name=demo", "count=3", "tags=[\"a\"]"])).toEqual({
      command: "run",
      tool: "create_book",
      toolArgs: { name: "demo", count: 3, tags: ["a"] },
      flags: { wait: true, timeoutSeconds: 600 },
    });
    expect(parseCli(["run", "list_books", "--no-wait", "--timeout", "30"]))
      .toMatchObject({ command: "run", tool: "list_books", flags: { wait: false, timeoutSeconds: 30 } });
  });

  it("answers help and version from any position", () => {
    expect(parseCli(["help"])).toEqual({ command: "help" });
    expect(parseCli(["--help"])).toEqual({ command: "help" });
    expect(parseCli(["serve", "-h"])).toEqual({ command: "help" });
    expect(parseCli(["-v"])).toEqual({ command: "version" });
    expect(parseCli(["version"])).toEqual({ command: "version" });
  });

  it("rejects unknown commands, flags, stray arguments and bad values", () => {
    expect(() => parseCli(["launch"])).toThrow(CliUsageError);
    expect(() => parseCli(["serve", "--wat"])).toThrow(CliUsageError);
    expect(() => parseCli(["serve", "extra"])).toThrow(CliUsageError);
    expect(() => parseCli(["doctor", "--headless"])).toThrow(CliUsageError);
    expect(() => parseCli(["--port", "70000"])).toThrow("--port must be an integer");
    expect(() => parseCli(["--port", "abc"])).toThrow(CliUsageError);
    expect(() => parseCli(["--log-level", "loud"])).toThrow("--log-level must be one of");
    expect(() => parseCli(["run"])).toThrow("run needs a tool name");
    expect(() => parseCli(["run", "x", "--timeout", "0"])).toThrow("--timeout must be a positive number");
  });
});

describe("parseToolArgs", () => {
  it("splits on the first = and keeps non-JSON values as strings", () => {
    expect(parseToolArgs(["prompt=a=b", "flag=true", "name=hello world"]))
      .toEqual({ prompt: "a=b", flag: true, name: "hello world" });
  });

  it("rejects pairs without a key", () => {
    expect(() => parseToolArgs(["=x"])).toThrow(CliUsageError);
    expect(() => parseToolArgs(["novalue"])).toThrow(CliUsageError);
  });
});

describe("applyFlagsToEnv", () => {
  it("writes absolute paths, the port and the log level", () => {
    const env: NodeJS.ProcessEnv = {};
    applyFlagsToEnv({ port: 4100, library: "lib", home: "/data/home", logLevel: "debug" }, env, "/work");
    expect(env).toEqual({ PORT: "4100", VIDEOBOOK_LIBRARY_DIR: "/work/lib", VIDEOBOOK_HOME: "/data/home", VIDEOBOOK_LOG_LEVEL: "debug" });
  });

  it("lets --home replace data paths inherited from the shell", () => {
    const env: NodeJS.ProcessEnv = {
      VIDEOBOOK_LIBRARY_DIR: "/shell/books",
      VIDEOBOOK_APP_STATE_PATH: "/shell/state.json",
      VIDEOBOOK_ENV_PATH: "/shell/.env",
      OTHER: "kept",
    };
    applyFlagsToEnv({ home: "home" }, env, "/work");
    expect(env).toEqual({ VIDEOBOOK_HOME: "/work/home", OTHER: "kept" });
  });

  it("keeps an explicit --library next to --home", () => {
    const env: NodeJS.ProcessEnv = { VIDEOBOOK_LIBRARY_DIR: "/shell/books" };
    applyFlagsToEnv({ home: "/h", library: "/l" }, env, "/work");
    expect(env).toEqual({ VIDEOBOOK_HOME: "/h", VIDEOBOOK_LIBRARY_DIR: "/l" });
  });

  it("leaves the environment alone without flags", () => {
    const env: NodeJS.ProcessEnv = { PORT: "5000", VIDEOBOOK_LIBRARY_DIR: "/shell/books" };
    applyFlagsToEnv({}, env, "/work");
    expect(env).toEqual({ PORT: "5000", VIDEOBOOK_LIBRARY_DIR: "/shell/books" });
  });
});

describe("resolvePort", () => {
  it("uses a valid PORT and 3001 otherwise", () => {
    expect(resolvePort({})).toBe(3001);
    expect(resolvePort({ PORT: "4123" })).toBe(4123);
    expect(resolvePort({ PORT: "0" })).toBe(0);
    expect(resolvePort({ PORT: "nope" })).toBe(3001);
  });
});

describe("helpText", () => {
  it("documents every command and the agent setup line", () => {
    const text = helpText();
    for (const command of ["serve", "mcp", "run", "tools", "gc-books", "doctor", "version", "help"]) {
      expect(text).toContain(`  ${command}`);
    }
    expect(text).toContain("claude mcp add videobook -- videobook mcp");
  });
});
