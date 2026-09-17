import { describe, expect, test } from "bun:test";
import { ConfigError, validateConfig } from "../src/config.ts";

function parse(toml: string): unknown {
  return Bun.TOML.parse(toml);
}

const MINIMAL = `
schema_version = 1

[[agents]]
id = "a1"
[agents.command]
executable = "bun"
stdin = "prompt"
`;

function expectConfigError(toml: string, match: string | RegExp) {
  try {
    validateConfig(parse(toml), "/fake/team.toml");
    throw new Error("expected ConfigError, got none");
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const msg = (e as ConfigError).errors.join("\n");
    if (typeof match === "string") expect(msg).toContain(match);
    else expect(msg).toMatch(match);
  }
}

describe("config validation", () => {
  test("applies defaults to a minimal config", () => {
    const cfg = validateConfig(parse(MINIMAL), "/fake/team.toml");
    expect(cfg.team).toBe("default");
    expect(cfg.defaults.timeout_ms).toBe(100_000);
    expect(cfg.defaults.max_output_bytes).toBe(200_000);
    expect(cfg.defaults.concurrency).toBe(3);
    expect(cfg.budgets.max_runs).toBe(8);
    expect(cfg.budgets.max_wall_time_ms).toBe(600_000);
    expect(cfg.budgets.max_estimated_cost_usd).toBe(5.0);
    expect(cfg.agents).toHaveLength(1);
    // MINIMAL declares [agents.command], so command is present on the parsed
    // agent (the field is optional only for console/bus kinds)
    expect(cfg.agents[0].command!.stdin).toBe("prompt");
    expect(cfg.root).toBe("/fake");
  });

  test("rejects wrong schema_version", () => {
    expectConfigError(MINIMAL.replace("schema_version = 1", "schema_version = 2"), "schema_version must be 1");
  });

  test("rejects duplicate agent ids", () => {
    expectConfigError(
      `
schema_version = 1
[[agents]]
id = "dup"
[agents.command]
executable = "bun"
[[agents]]
id = "dup"
[agents.command]
executable = "bun"
`,
      'duplicate agent id "dup"'
    );
  });

  test("rejects unknown placeholders in args", () => {
    expectConfigError(
      `
schema_version = 1
[[agents]]
id = "a1"
[agents.command]
executable = "x"
args = ["run", "{artifact}"]
`,
      "unknown placeholder {artifact}"
    );
  });

  test("rejects {prompt} in more than one arg", () => {
    expectConfigError(
      `
schema_version = 1
[[agents]]
id = "a1"
[agents.command]
executable = "x"
args = ["{prompt}", "{prompt}"]
`,
      "{prompt} may appear in at most one arg"
    );
  });

  test("rejects {prompt} arg combined with stdin prompt", () => {
    expectConfigError(
      `
schema_version = 1
[[agents]]
id = "a1"
[agents.command]
executable = "x"
args = ["{prompt}"]
stdin = "prompt"
`,
      "ambiguous"
    );
  });

  test("rejects invalid stdin mode", () => {
    expectConfigError(
      `
schema_version = 1
[[agents]]
id = "a1"
[agents.command]
executable = "x"
stdin = "pipe"
`,
      'command.stdin must be "prompt" or "null"'
    );
  });

  test("rejects unknown role reference", () => {
    expectConfigError(
      `
schema_version = 1
[[agents]]
id = "a1"
role = "ghost"
[agents.command]
executable = "x"
`,
      'unknown role "ghost"'
    );
  });

  test("rejects a config with no agents", () => {
    expectConfigError(`schema_version = 1`, "at least one [[agents]] entry");
  });

  test("rejects invalid stderr_patterns status and regex", () => {
    expectConfigError(
      MINIMAL +
        `
[[stderr_patterns]]
pattern = "ok"
status = "exploded"
`,
      'unknown status "exploded"'
    );
    expectConfigError(
      MINIMAL +
        `
[[stderr_patterns]]
pattern = "(["
`,
      "invalid regex"
    );
  });

  test("collects multiple errors at once", () => {
    try {
      validateConfig(parse(`schema_version = 9`), "/fake/team.toml");
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});
