import { useAtomValue } from "@effect/atom-react";
import { zulipPanelFrameSource } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryServerConfigAtom } from "../../state/server";
import { isTopWindow } from "../whiteboard/role";

/**
 * "unknown" until the primary server config arrives. `url` is the page this window may frame;
 * "off" when the machine set none, or this page cannot frame it (see `zulipPanelFrameSource`).
 */
export type ZulipPanelRole = "unknown" | "off" | { readonly url: string };

const zulipPanelRoleAtom = Atom.make((get): ZulipPanelRole => {
  const config = get(primaryServerConfigAtom);
  if (config === null) return "unknown";
  const raw = config.environment.capabilities.zulipPanel?.url;
  if (raw === undefined || !isTopWindow()) return "off";
  const url = zulipPanelFrameSource(raw, window.location.origin);
  return url === undefined ? "off" : { url };
}).pipe(Atom.withLabel("fork-zulip-panel-role"));

export const useZulipPanelRole = (): ZulipPanelRole => useAtomValue(zulipPanelRoleAtom);

export const isZulipPanelOffered = (role: ZulipPanelRole): role is { readonly url: string } =>
  typeof role === "object";

export const readZulipPanelOffered = (): boolean =>
  isZulipPanelOffered(appAtomRegistry.get(zulipPanelRoleAtom));
