const delegateOnlyLine = (nativeTools: string) =>
  `- Subagents: ${nativeTools} Start every child, same provider and model included, with \`delegate_task\`. Omit \`target\` to use your own provider and model. Set \`mode:"wait"\` when this turn needs the result. Separate checkout: \`isolation:"worktree"\`.`;

export const NO_NATIVE_SUBAGENT_TOOL_LINE = delegateOnlyLine(
  "this session has no native subagent tool.",
);
export const UNUSED_NATIVE_SUBAGENT_TOOLS_LINE = delegateOnlyLine(
  "do not use your native subagent tools.",
);

/**
 * Providers whose agents start every child with `delegate_task`. Each entry holds the instruction
 * line the provider gets. An entry with `hide` starts its sessions without the provider's own
 * subagent tools, and `hide` is what its adapter sends to remove them. An entry without `hide`
 * keeps those tools in the session, so its line forbids them and does not call them absent.
 */
export const DELEGATE_ONLY_PROVIDERS = {
  claudeAgent: {
    subagentLine: NO_NATIVE_SUBAGENT_TOOL_LINE,
    hide: {
      // SendMessage and ListAgents only reach native agents and other Claude sessions.
      disallowedTools: ["Agent", "Workflow", "SendMessage", "ListAgents"],
      // Also removes the bundled skill that tells the agent to write Workflow scripts.
      environment: { CLAUDE_CODE_DISABLE_WORKFLOWS: "1" },
    },
  },
  codex: {
    subagentLine: NO_NATIVE_SUBAGENT_TOOL_LINE,
    hide: {
      // Set per thread, where it also wins over a user's launch arguments. An enabled
      // multi_agent_v2 feature outranks agents.enabled, so both are set.
      threadConfig: { "agents.enabled": false, "features.multi_agent_v2": false },
    },
  },
  antigravity: { subagentLine: UNUSED_NATIVE_SUBAGENT_TOOLS_LINE },
} as const;

const subagentLineFor = (provider: string | undefined): string | undefined =>
  provider !== undefined && Object.hasOwn(DELEGATE_ONLY_PROVIDERS, provider)
    ? DELEGATE_ONLY_PROVIDERS[provider as keyof typeof DELEGATE_ONLY_PROVIDERS].subagentLine
    : undefined;

const NATIVE_SUBAGENT_LINE = /^- Subagents: use your native tool.*$/m;

export const orchestrationSectionsFor = (
  sections: ReadonlyArray<string>,
  provider: string | undefined,
): ReadonlyArray<string> => {
  const line = subagentLineFor(provider);
  return line === undefined
    ? sections
    : sections.map((section) => section.replace(NATIVE_SUBAGENT_LINE, () => line));
};
