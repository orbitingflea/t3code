import {
  REPLACE_SEND_TO_USER_TOOL_NAME,
  SEND_TO_USER_TOOL_NAME,
} from "@t3tools/shared/displayModes";

// Claude Code 2.1.311 asks again after a final reply with no text, in words the agent takes for the
// user's. This setting, a comma list, makes a successful send or rewrite count as that reply. It is
// undocumented, so claudeTerminalTool.contract.test.ts runs it against the real CLI.
export const claudeTerminalToolEnvironment = {
  CLAUDE_CODE_TERMINAL_MCP_TOOLS: [SEND_TO_USER_TOOL_NAME, REPLACE_SEND_TO_USER_TOOL_NAME]
    .map((tool) => `mcp__t3-code__${tool}`)
    .join(","),
};
