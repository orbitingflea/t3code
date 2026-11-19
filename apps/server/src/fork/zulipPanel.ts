import { parseZulipPanelUrl } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

// The warning names the variable only, never its value.
export const zulipPanelCapabilities = Effect.fn("zulipPanel.capabilities")(function* () {
  const raw = (yield* HostProcess.Environment).T3CODE_ZULIP_PANEL_URL;
  if (raw === undefined) return {};
  const url = parseZulipPanelUrl(raw);
  if (url === undefined) {
    yield* Effect.logWarning(
      "T3CODE_ZULIP_PANEL_URL is not an https URL (or http on loopback); the Zulip tab is off",
    );
    return {};
  }
  return { zulipPanel: { url } };
});
