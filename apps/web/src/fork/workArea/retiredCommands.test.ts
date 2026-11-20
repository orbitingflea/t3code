import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { buildKeybindingCommandOptions } from "~/components/settings/KeybindingsSettings.logic";
import { resolveChatShortcutCommand } from "~/keybindings";
import { commandForProjectScript } from "~/projectScripts";
import { createShortcutKeybindingsAtom } from "~/state/server";

function primaryKeybindings() {
  const registry = AtomRegistry.make();
  const keybindings = createShortcutKeybindingsAtom({
    primaryEnvironmentIdAtom: Atom.make(null),
    primaryConfigAtom: Atom.make(null),
    environmentsAtom: Atom.make(new Map()),
  });
  return registry.get(keybindings);
}

const CTRL_J = { key: "j", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };

describe("terminal.toggle in the work area", () => {
  it("is not in the web client's keybindings or the Keybindings settings' command picker", () => {
    const keybindings = primaryKeybindings();
    expect(keybindings.map((binding) => binding.command)).not.toContain("terminal.toggle");
    expect(buildKeybindingCommandOptions(keybindings)).not.toContain("terminal.toggle");
  });

  it("leaves its chord to a project script bound to it", () => {
    const script = commandForProjectScript("dev")!;
    const active = compileResolvedKeybindingsConfig([{ key: "mod+j", command: script }]);
    expect(
      resolveChatShortcutCommand(CTRL_J, primaryKeybindings(), active, { platform: "Linux" }),
    ).toBe(script);
  });
});
