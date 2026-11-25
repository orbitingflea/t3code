import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";

import { userTabMove } from "./tabMoveScope";

type RefActions<S> = {
  readonly [
    K in keyof S as S[K] extends (ref: ScopedThreadRef, ...args: never) => unknown ? K : never
  ]: S[K];
};

// Each action runs as one user tab move in the work area of the thread it takes first.
const asUserTabMoves = <S extends object>(state: S): RefActions<S> =>
  Object.fromEntries(
    Object.entries(state).flatMap(([key, action]) =>
      typeof action === "function"
        ? [
            [
              key,
              (ref: ScopedThreadRef, ...args: unknown[]) =>
                userTabMove(ref, () => action(ref, ...args)),
            ],
          ]
        : [],
    ),
  ) as RefActions<S>;

/**
 * Returns right-panel store actions that take a `ScopedThreadRef` first.
 * Each action runs as one user tab move in that thread's work area.
 */
export const userTabActions = () => asUserTabMoves(useRightPanelStore.getState());

/**
 * Returns terminal UI store actions that take a `ScopedThreadRef` first.
 * Each action runs as one user tab move in that thread's work area.
 */
export const userTerminalActions = () => asUserTabMoves(useTerminalUiStateStore.getState());
