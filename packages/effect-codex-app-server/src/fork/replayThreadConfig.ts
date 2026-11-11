// The fork turns Codex's subagent tools off in every thread, and no recorded transcript has these keys.
const FORK_THREAD_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "agents.enabled",
  "features.multi_agent_v2",
]);

export const isForkThreadConfigKey = (key: string) => FORK_THREAD_CONFIG_KEYS.has(key);
