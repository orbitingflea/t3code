import {
  type PreviewStreamControl,
  previewStreamControlLabel,
} from "@t3tools/client-runtime/preview/server-browser-stream";

/** Names the viewer that holds control, short enough to stay on one line of the control bar. */
export const previewControlLabel = (control: PreviewStreamControl | null): string => {
  const holder = control?.controller === "another-viewer" ? control.holder : undefined;
  if (!holder) return previewStreamControlLabel(control);
  return `Viewer ${holder.viewer} has control${holder.connected ? "" : " (still connecting)"}`;
};
