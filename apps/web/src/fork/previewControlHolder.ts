import {
  type PreviewStreamControl,
  previewStreamControlLabel,
} from "@t3tools/client-runtime/preview/server-browser-stream";

/** Names the viewer that holds control, so a person can tell a stale connection of their own window from another window. */
export const previewControlLabel = (control: PreviewStreamControl | null): string => {
  const label = previewStreamControlLabel(control);
  const holder = control?.controller === "another-viewer" ? control.holder : undefined;
  if (!holder) return label;
  const since =
    holder.attachedAt === null ? "" : `, since ${new Date(holder.attachedAt).toLocaleTimeString()}`;
  const state = holder.connected ? "" : ", still connecting";
  const self = control?.viewer === undefined ? "" : `; this viewer is ${control.viewer}`;
  return `${label} (viewer ${holder.viewer}${since}${state}${self})`;
};
