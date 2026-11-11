import { DELEGATE_ONLY_PROVIDERS } from "@t3tools/provider-core/server/fork/nativeSubagents";

// A harness capture can hold the provider's subagent tools, which T3 Code hides in real sessions,
// so the eval takes them out of the capture.
const CLAUDE_HIDDEN_TOOLS: ReadonlySet<string> = new Set(
  DELEGATE_ONLY_PROVIDERS.claudeAgent.hide.disallowedTools,
);
const CODEX_SUBAGENT_NAMESPACES: ReadonlySet<unknown> = new Set([
  "collaboration",
  "multi_agent_v1",
]);
const CODEX_SUBAGENT_CONTEXT = /<multi_agent_(?:role|mode)>/;

/** `name` is a Claude tool name as the eval grades it, without a capture's prefix. */
export const isHiddenClaudeTool = (name: string) => CLAUDE_HIDDEN_TOOLS.has(name);

type CodexItem = { readonly type: string; readonly [key: string]: unknown };

/** A captured Codex input item without the subagent tools and the messages that describe them. */
export const withoutCodexSubagentTools = <Item extends CodexItem>(
  item: Item,
): ReadonlyArray<Item> => {
  if (item.type === "additional_tools" && Array.isArray(item.tools)) {
    const tools = item.tools.filter(
      (namespace: { readonly name?: unknown }) => !CODEX_SUBAGENT_NAMESPACES.has(namespace.name),
    );
    return [{ ...item, tools }];
  }
  return CODEX_SUBAGENT_CONTEXT.test(JSON.stringify(item.content ?? "")) ? [] : [item];
};
