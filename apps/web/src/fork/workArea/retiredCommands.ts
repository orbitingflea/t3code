import type { KeybindingCommand } from "@t3tools/contracts";

// The work area has no terminal drawer for its toggle to show.
const WORK_AREA_UNUSED_COMMANDS: ReadonlySet<KeybindingCommand> = new Set(["terminal.toggle"]);

export const isWorkAreaCommand = (command: KeybindingCommand): boolean =>
  !WORK_AREA_UNUSED_COMMANDS.has(command);

export const withoutUnusedCommands = <T extends { readonly command: KeybindingCommand }>(
  bindings: ReadonlyArray<T>,
): T[] => bindings.filter((binding) => isWorkAreaCommand(binding.command));
