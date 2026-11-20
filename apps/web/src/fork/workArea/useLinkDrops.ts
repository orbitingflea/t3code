import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import type { DropPlan } from "./dropPlan.logic";
import { dropEffectFor } from "./linkDrop.logic";
import { claimPanelLinkDrop, type PanelLink, useOwnedPanelLinkDrag } from "./panelLinkDrag";
import type { Placement } from "./workAreaPlacement.logic";

type Point = { readonly x: number; readonly y: number };

const inTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("input, textarea") !== null);

// Plans by geometry: the primary Chat's column lies outside the work area's DOM. Bubble listeners
// on the document, so a child that stops the drag, as a composer does, keeps it.
export function useLinkDrops(input: {
  readonly owner: ScopedThreadRef;
  readonly planAt: (point: Point, link: PanelLink) => DropPlan | null;
  readonly show: (plan: DropPlan | null) => void;
  readonly open: (link: PanelLink, at: Placement, live: () => boolean) => unknown;
}): void {
  const owned = useOwnedPanelLinkDrag(input.owner);
  const ownerKey = scopedThreadKey(input.owner);
  const planAt = useStableCallback(input.planAt);
  const show = useStableCallback(input.show);
  const claim = useStableCallback((transfer: DataTransfer | null) =>
    claimPanelLinkDrop(input.owner, transfer),
  );
  // Each open still loading, by the key of the owner whose record its drop writes.
  const pending = useRef(new Map<() => void, string>());

  // Anything the user does before a slow open lands wins over the drop's place.
  const openDropped = useStableCallback((link: PanelLink, at: Placement) => {
    let live = true;
    const settle = () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      pending.current.delete(cancel);
    };
    const cancel = () => {
      live = false;
      settle();
    };
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    pending.current.set(cancel, ownerKey);
    const result = input.open(link, at, () => live);
    if (result instanceof Promise) void result.then(settle, settle);
    else settle();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an open still loading must not move a tab after the work area is gone or shows another thread
  useEffect(() => {
    const opens = pending.current;
    return () => {
      for (const [cancel, owner] of opens) if (owner === ownerKey) cancel();
    };
  }, [ownerKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a link drag runs in the browser's drag events, outside React
  useEffect(() => {
    if (!owned) return;
    const accept = (event: DragEvent): DropPlan | null => {
      const transfer = event.dataTransfer;
      if (transfer === null || inTextField(event.target)) return null;
      const effect = dropEffectFor(transfer.effectAllowed);
      const plan = effect === null ? null : planAt({ x: event.clientX, y: event.clientY }, owned);
      if (plan === null || effect === null) return null;
      event.preventDefault();
      transfer.dropEffect = effect;
      return plan;
    };
    const onOver = (event: DragEvent) => show(accept(event));
    const onLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) show(null);
    };
    const onEnd = () => show(null);
    const onDrop = (event: DragEvent) => {
      show(null);
      const plan = accept(event);
      if (plan === null) return;
      const link = claim(event.dataTransfer);
      if (link !== null) openDropped(link, plan.at);
    };
    const listeners = [
      ["dragenter", onOver],
      ["dragover", onOver],
      ["dragleave", onLeave],
      ["dragend", onEnd],
      ["drop", onDrop],
    ] as const;
    for (const [type, listener] of listeners) document.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of listeners) document.removeEventListener(type, listener);
      show(null);
    };
  }, [owned, planAt, show, claim, openDropped]);
}
