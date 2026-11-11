import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_SECTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationInstructions,
  t3OrchestrationSections,
} from "../orchestrationInstructions.ts";
import {
  DELEGATE_ONLY_PROVIDERS,
  NO_NATIVE_SUBAGENT_TOOL_LINE,
  UNUSED_NATIVE_SUBAGENT_TOOLS_LINE,
} from "./nativeSubagents.ts";

const NATIVE_FIRST = "use your native tool when the child uses your provider";
// Codex truncates a section over this many bytes.
const SECTION_MAX_BYTES = 4_000;

describe("orchestration instructions per provider", () => {
  it.each([
    ["claudeAgent", NO_NATIVE_SUBAGENT_TOOL_LINE],
    ["codex", NO_NATIVE_SUBAGENT_TOOL_LINE],
    ["antigravity", UNUSED_NATIVE_SUBAGENT_TOOLS_LINE],
  ])(
    "send every subagent of %s to delegate_task and name no native subagent tool",
    (provider, line) => {
      const sections = t3OrchestrationSections(provider);
      const text = sections.join("\n\n");
      assert.include(text, line);
      assert.include(
        text,
        "Start every child, same provider and model included, with `delegate_task`.",
      );
      for (const native of [NATIVE_FIRST, "`Agent`", "spawn_agent", "run_in_background"]) {
        assert.notInclude(text, native);
      }
      assert.deepEqual(
        sections.map((section) => section.split("\n").length),
        T3_CODE_ORCHESTRATION_SECTIONS.map((section) => section.split("\n").length),
      );
      for (const section of sections) {
        assert.isAtMost(new TextEncoder().encode(section).length, SECTION_MAX_BYTES);
      }
      assert.equal(t3OrchestrationInstructions(provider), `\n\n${text}\n`);
    },
  );

  it("say a session has no native subagent tool only where the adapter hides it", () => {
    for (const [provider, entry] of Object.entries(DELEGATE_ONLY_PROVIDERS)) {
      assert.equal(
        entry.subagentLine.includes("has no native subagent tool"),
        "hide" in entry,
        provider,
      );
    }
    assert.include(UNUSED_NATIVE_SUBAGENT_TOOLS_LINE, "do not use your native subagent tools");
  });

  it.each(["cursor", "opencode", "grok", "pi", undefined])(
    "keep the native-first text for %s",
    (provider) => {
      assert.deepEqual(t3OrchestrationSections(provider), T3_CODE_ORCHESTRATION_SECTIONS);
      assert.include(t3OrchestrationInstructions(provider), NATIVE_FIRST);
    },
  );

  it("reach an ACP agent in the text of its own provider", () => {
    const prompt = (provider: string) =>
      t3AcpPromptWithInstructions({
        prompt: "Review the diff.",
        state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false },
        provider,
      });
    assert.include(prompt("antigravity"), UNUSED_NATIVE_SUBAGENT_TOOLS_LINE);
    assert.notInclude(prompt("antigravity"), "has no native subagent tool");
    assert.notInclude(prompt("antigravity"), NATIVE_FIRST);
    assert.include(prompt("grok"), NATIVE_FIRST);
  });
});
