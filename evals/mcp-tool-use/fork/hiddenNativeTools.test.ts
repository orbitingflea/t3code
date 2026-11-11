import { assert, it } from "@effect/vitest";

import { isHiddenClaudeTool, withoutCodexSubagentTools } from "./hiddenNativeTools.ts";

it("takes the subagent tools out of a captured harness turn and keeps the rest", () => {
  assert.deepEqual(
    ["Agent", "Workflow", "SendMessage", "ListAgents", "Bash", "TaskStop"].filter(
      (name) => !isHiddenClaudeTool(name),
    ),
    ["Bash", "TaskStop"],
  );

  const functions = { type: "namespace", name: "functions", tools: [{ name: "exec" }] };
  const tools = {
    type: "additional_tools",
    tools: [
      functions,
      { type: "namespace", name: "collaboration", tools: [{ name: "spawn_agent" }] },
      { type: "namespace", name: "multi_agent_v1", tools: [{ name: "spawn_agent" }] },
    ],
  };
  assert.deepEqual(withoutCodexSubagentTools(tools), [{ ...tools, tools: [functions] }]);

  const message = (text: string) => ({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
  });
  const mode = message("<collaboration_mode>Default</collaboration_mode>");
  assert.deepEqual(withoutCodexSubagentTools(mode), [mode]);
  assert.deepEqual(
    withoutCodexSubagentTools(message("<multi_agent_role>You are `/root`.</multi_agent_role>")),
    [],
  );
});
