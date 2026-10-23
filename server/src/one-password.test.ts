import { describe, expect, it } from "vitest";
import {
  injectionTemplate,
  isOpReference,
  parseInjection,
  planReferences,
  readOnePasswordSettings,
  redactToken,
  resolveOnePasswordEnv,
  resolveServiceToken,
  vaultReference,
} from "./one-password.js";

describe("1Password references", () => {
  it("recognises op:// references and builds vault-convention references", () => {
    expect(isOpReference("op://Apicity/OPENAI_API_KEY/password")).toBe(true);
    expect(isOpReference("  op://vault/item/field")).toBe(true);
    expect(isOpReference("sk-live")).toBe(false);
    expect(isOpReference(undefined)).toBe(false);
    expect(vaultReference("Apicity", "FAL_API_KEY")).toBe("op://Apicity/FAL_API_KEY/password");
  });

  it("reads the service token as a literal, env:VAR, $VAR or a bare variable name", () => {
    const env: NodeJS.ProcessEnv = { OP_SERVICE_ACCOUNT_TOKEN: "ops_secret", EMPTY: "" };
    expect(resolveServiceToken(undefined, env)).toEqual({ value: null, source: null });
    expect(resolveServiceToken("env:OP_SERVICE_ACCOUNT_TOKEN", env)).toEqual({ value: "ops_secret", source: "env:OP_SERVICE_ACCOUNT_TOKEN" });
    expect(resolveServiceToken("$OP_SERVICE_ACCOUNT_TOKEN", env)).toEqual({ value: "ops_secret", source: "env:OP_SERVICE_ACCOUNT_TOKEN" });
    expect(resolveServiceToken("OP_SERVICE_ACCOUNT_TOKEN", env)).toEqual({ value: "ops_secret", source: "env:OP_SERVICE_ACCOUNT_TOKEN" });
    expect(resolveServiceToken("env:EMPTY", env)).toEqual({ value: null, source: "env:EMPTY" });
    expect(resolveServiceToken("ops_literal_token", env)).toEqual({ value: "ops_literal_token", source: "literal" });
  });

  it("reads the vault and token settings from the environment", () => {
    expect(readOnePasswordSettings({ VIDEOBOOK_OP_VAULT: " Apicity ", VIDEOBOOK_OP_SERVICE_TOKEN: "env:TOKEN", TOKEN: "t" })).toEqual({
      vault: "Apicity",
      token: { value: "t", source: "env:TOKEN" },
    });
    expect(readOnePasswordSettings({})).toEqual({ vault: null, token: { value: null, source: null } });
  });

  it("redacts the token from op output", () => {
    expect(redactToken("bad token ops_x in ops_x", "ops_x")).toBe("bad token *** in ***");
    expect(redactToken("nothing to hide", null)).toBe("nothing to hide");
  });
});

describe("planReferences", () => {
  it("resolves explicit references first and fills every missing key the vault names", () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "op://Other/OPENAI/credential",
      FAL_API_KEY: "literal-key",
      CUSTOM_SETTING: "op://Apicity/CUSTOM/password",
    };
    const titles = new Set(["OPENAI_API_KEY", "FAL_API_KEY", "KIE_API_KEY", "MACHGEN_API_KEY"]);
    const plan = planReferences(env, "Apicity", titles);
    expect(plan.explicit).toEqual([
      ["OPENAI_API_KEY", "op://Other/OPENAI/credential"],
      ["CUSTOM_SETTING", "op://Apicity/CUSTOM/password"],
    ]);
    expect(plan.convention).toEqual([
      ["KIE_API_KEY", "op://Apicity/KIE_API_KEY/password"],
      ["MACHGEN_API_KEY", "op://Apicity/MACHGEN_API_KEY/password"],
    ]);
  });

  it("skips vault items that are not environment names or are the vault settings", () => {
    const titles = new Set(["Google login", "npm-token", "VIDEOBOOK_OP_VAULT", "VIDEOBOOK_OP_SERVICE_TOKEN", "B2_REGION"]);
    expect(planReferences({}, "Apicity", titles).convention).toEqual([["B2_REGION", "op://Apicity/B2_REGION/password"]]);
  });

  it("uses no vault convention without a vault", () => {
    expect(planReferences({ KIE_API_KEY: "" }, null, new Set(["KIE_API_KEY"])).convention).toEqual([]);
  });
});

describe("op inject template", () => {
  it("round-trips multi-line values through unique markers", () => {
    const entries: Array<[string, string]> = [["A", "op://v/a/password"], ["B", "op://v/b/password"], ["C", "op://v/c/password"]];
    const template = injectionTemplate(entries, "n0nce");
    expect(template).toContain("{{ op://v/a/password }}");
    const injected = template
      .replace("{{ op://v/a/password }}", "alpha")
      .replace("{{ op://v/b/password }}", "line one\nline two")
      .replace("{{ op://v/c/password }}", "");
    expect(parseInjection(injected, ["A", "B", "C", "D"], "n0nce")).toEqual(new Map([["A", "alpha"], ["B", "line one\nline two"]]));
  });
});

describe("resolveOnePasswordEnv", () => {
  it("does nothing without references or a vault, so op never runs", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-literal" };
    expect(resolveOnePasswordEnv(env)).toEqual({
      attempted: false,
      vault: null,
      tokenSource: null,
      fromReferences: [],
      fromVault: [],
      unresolved: [],
      error: null,
    });
    expect(env).toEqual({ OPENAI_API_KEY: "sk-literal" });
  });

  it("unsets references it cannot resolve instead of passing them on as keys", () => {
    const env: NodeJS.ProcessEnv = { FAL_API_KEY: "op://v/item/pass{{word}}", PATH: process.env.PATH };
    const resolution = resolveOnePasswordEnv(env);
    expect(resolution.attempted).toBe(true);
    expect(resolution.unresolved).toEqual([{ key: "FAL_API_KEY", reference: "op://v/item/pass{{word}}", reason: "malformed op:// reference" }]);
    expect(env.FAL_API_KEY).toBeUndefined();
  });
});
