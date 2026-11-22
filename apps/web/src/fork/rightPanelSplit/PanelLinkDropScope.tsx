import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useStableCallback } from "~/hooks/useStableCallback";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { type Rect, samePlan } from "./dropTarget.logic";
import {
  dropEffectFor,
  type LinkDropPlan,
  type LinkPlacement,
  type PaneGeometry,
  placementChange,
  planLinkDrop,
} from "./linkDrop.logic";
import {
  claimPanelLinkDrop,
  type OpenedSurface,
  type PanelLink,
  PanelLinkOwnerContext,
  useOwnedPanelLinkDrag,
} from "./panelLinkDrag";
import { DropGhostView } from "./RightPanelDragScope";
import type { PaneSide, SplitChange } from "./splitLayout.logic";

function clipped(rect: Rect, to: Rect): Rect | null {
  const left = Math.max(rect.left, to.left);
  const right = Math.min(rect.right, to.right);
  return right <= left ? null : { left, right, top: rect.top, bottom: rect.bottom };
}

function measurePanes(scope: HTMLElement): PaneGeometry[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-right-panel-pane]")].flatMap((pane) => {
    const strip = pane.querySelector("[data-right-panel-tabbar]");
    const content = pane.querySelector("[data-right-panel-surface-content]");
    const list = pane.querySelector("[data-right-panel-tab-list]");
    if (strip === null || content === null || list === null) return [];
    const viewport = list.getBoundingClientRect();
    const tabs = [...list.querySelectorAll<HTMLElement>("[data-right-panel-tab-id]")].flatMap(
      (tab) => {
        const rect = clipped(tab.getBoundingClientRect(), viewport);
        return rect === null ? [] : [{ id: tab.dataset.rightPanelTabId!, rect }];
      },
    );
    return [
      {
        side: (pane.dataset.rightPanelPane as PaneSide | undefined) ?? "left",
        strip: strip.getBoundingClientRect(),
        content: content.getBoundingClientRect(),
        tabs,
      },
    ];
  });
}

/** A text field takes a dropped link as text. */
function inTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea") !== null)
  );
}

/**
 * The HTML drop target of one ChatView panel, for links dragged from chat or the Files tree.
 * Wrap the panes in it, inside the split row; it adds no box of its own.
 */
export function PanelLinkDropScope(props: {
  readonly threadRef: ScopedThreadRef;
  readonly splitAllowed: boolean;
  readonly splitRendered: boolean;
  readonly splitGrowth: number;
  /** The split view's change, which also widens the panel on a new split. */
  readonly applyChange: (change: SplitChange) => void;
  readonly children: ReactNode;
}) {
  const { threadRef, splitAllowed, splitRendered, splitGrowth } = props;
  const owned = useOwnedPanelLinkDrag(threadRef);
  const cancelPending = useRef<(() => void) | null>(null);
  const applyChange = useStableCallback(props.applyChange);
  const [plan, setPlan] = useState<LinkDropPlan | null>(null);
  const shown = useRef<LinkDropPlan | null>(null);
  const entered = useRef<EventTarget | null>(null);
  const readThread = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

  const show = (next: LinkDropPlan | null) => {
    if (samePlan(shown.current, next)) return;
    shown.current = next;
    setPlan(next);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an open still loading must not move a tab after the panel is gone
  useEffect(() => () => cancelPending.current?.(), []);

  const place = (link: PanelLink, placement: LinkPlacement) => {
    cancelPending.current?.();
    const before = readThread();
    const settle = (opened: OpenedSurface) => {
      if (opened === null) return;
      const after = readThread();
      if (!after.surfaces.some((surface) => surface.id === opened)) return;
      const change = placementChange(before, after, opened, placement);
      if (change !== null) applyChange(change);
    };
    const result = link.open();
    if (!(result instanceof Promise)) {
      settle(result);
      return;
    }
    // Anything the user does before a slow open lands wins over the drop's placement.
    const cancel = () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      if (cancelPending.current === cancel) cancelPending.current = null;
    };
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    cancelPending.current = cancel;
    void result.then(
      (opened) => {
        if (cancelPending.current !== cancel) return;
        cancel();
        settle(opened);
      },
      () => cancel(),
    );
  };

  /** Accepts the drag here and gives its plan, unless a child or a text field takes it. */
  const accept = (event: ReactDragEvent<HTMLElement>): LinkDropPlan | null => {
    // A child claims a drag by stopping it, as the composer does; the Files tree only prevents
    // default for its own rows and then drops them as a no-op, so `defaultPrevented` is no claim.
    if (!owned || inTextField(event.target)) return null;
    const effect = dropEffectFor(event.dataTransfer.effectAllowed);
    if (effect === null) return null;
    const next = planLinkDrop({
      arrangement: readThread(),
      splitRendered,
      splitAllowed,
      splitGrowth,
      panes: measurePanes(event.currentTarget),
      pointer: { x: event.clientX, y: event.clientY },
    });
    if (next === null) return null;
    event.preventDefault();
    event.dataTransfer.dropEffect = effect;
    return next;
  };

  return (
    <PanelLinkOwnerContext value={threadRef}>
      <div
        className="contents"
        onDragEnter={(event) => {
          entered.current = event.target;
          show(accept(event));
        }}
        onDragOver={(event) => show(accept(event))}
        onDragLeave={(event) => {
          // An enter this scope did not see went outside it, or to a child that claimed the drag.
          if (event.relatedTarget !== entered.current) show(null);
        }}
        onDrop={(event) => {
          const accepted = shown.current;
          show(null);
          if (accepted === null) return;
          // An anchor's URL would otherwise navigate the page.
          event.preventDefault();
          event.stopPropagation();
          const link = claimPanelLinkDrop(threadRef, event.dataTransfer);
          if (link !== null) place(link, accepted.placement);
        }}
      >
        {props.children}
      </div>
      {owned && plan ? createPortal(<DropGhostView ghost={plan.ghost} />, document.body) : null}
    </PanelLinkOwnerContext>
  );
}
