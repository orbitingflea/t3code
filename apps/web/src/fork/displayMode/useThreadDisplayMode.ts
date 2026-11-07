import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type ContextMenuItem,
  type ScopedThreadRef,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  DISPLAY_MODES,
  type DisplayMode,
  NORMAL_DISPLAY_MODE,
  resolveDisplayMode,
} from "@t3tools/shared/displayModes";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { TimelineEntry } from "../../session-logic";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { useAtomCommand } from "../../state/use-atom-command";
import { applyDisplayMode } from "./displayModeTimeline";

export type DisplayModeMenuId = "display-mode" | `display-mode:${string}`;

const noSettingsAtom = Atom.make<ServerSettings | null>(null);

/** Returns the thread's mode. A draft thread is Normal. */
export function useThreadDisplayMode(threadRef: ScopedThreadRef | null): DisplayMode {
  const settings = useAtomValue(
    threadRef === null
      ? noSettingsAtom
      : serverEnvironment.settingsValueAtom(threadRef.environmentId),
  );
  return threadRef === null
    ? NORMAL_DISPLAY_MODE
    : resolveDisplayMode(settings?.threadDisplayModes[threadRef.threadId]);
}

/**
 * Returns the rows that the thread's mode draws from `entries`. `repliesChosen` is true when the
 * mode itself picks which replies show, so the timeline must not hide any of them.
 */
export function useDisplayModeTimeline(
  threadRef: ScopedThreadRef | null,
  entries: ReadonlyArray<TimelineEntry>,
): { readonly entries: ReadonlyArray<TimelineEntry>; readonly repliesChosen: boolean } {
  const mode = useThreadDisplayMode(threadRef);
  return { entries: applyDisplayMode(mode, entries), repliesChosen: mode.visibleCores !== null };
}

/** Returns the Display mode submenu. Returns nothing when the server cannot store a mode. */
export function displayModeMenuItems(
  threadRef: ScopedThreadRef,
): ReadonlyArray<ContextMenuItem<DisplayModeMenuId>> {
  const environment = appAtomRegistry
    .get(environmentServerConfigsAtom)
    .get(threadRef.environmentId)?.environment;
  if (environment?.capabilities.threadDisplayModes !== true) return [];
  const current = resolveDisplayMode(
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(threadRef.environmentId))
      ?.threadDisplayModes[threadRef.threadId],
  );
  return [
    {
      id: "display-mode",
      label: "Display mode",
      icon: "message-square",
      disabled: !readEnvironmentScope(threadRef.environmentId, AuthSettingsWriteScope),
      children: DISPLAY_MODES.map((mode) => ({
        id: `display-mode:${mode.id}` as const,
        label: mode.label,
        checked: mode.id === current.id,
      })),
    },
  ];
}

/** Returns the settings patch that moves a thread to the mode that a `display-mode:<id>` item names. */
export function displayModePatch(threadRef: ScopedThreadRef, action: string) {
  const modeId = action.slice("display-mode:".length);
  return {
    threadDisplayModes: {
      [threadRef.threadId]: modeId === NORMAL_DISPLAY_MODE.id ? null : modeId,
    },
  };
}

/**
 * Returns a menu handler. For a `display-mode:<id>` item, the handler saves that mode and resolves to
 * true, even when the save fails. For any other item, it resolves to false.
 */
export function useDisplayModeMenuAction() {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return async (threadRef: ScopedThreadRef, action: string): Promise<boolean> => {
    if (!action.startsWith("display-mode:")) return false;
    const result = await updateSettings({
      environmentId: threadRef.environmentId,
      input: { patch: displayModePatch(threadRef, action) },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to change display mode",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    return true;
  };
}
