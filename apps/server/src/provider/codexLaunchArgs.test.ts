import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexSkillRoot,
} from "./codexLaunchArgs.ts";

describe("resolveCodexSkillRoot", () => {
  it("returns the configured skill root without surrounding whitespace", () => {
    NodeAssert.equal(
      resolveCodexSkillRoot({ T3CODE_CODEX_SKILL_ROOT: " /opt/whiteboard/skills " }),
      "/opt/whiteboard/skills",
    );
  });

  it("ignores an empty skill root", () => {
    NodeAssert.equal(resolveCodexSkillRoot({ T3CODE_CODEX_SKILL_ROOT: "   " }), undefined);
  });
});

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
