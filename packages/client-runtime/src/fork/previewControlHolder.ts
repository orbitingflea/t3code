/** Who holds control of a server preview tab, as a viewer that does not hold it sees it. */
export interface PreviewStreamControlHolder {
  readonly viewer: string;
  /** Epoch ms when that viewer began to connect. */
  readonly attachedAt: number | null;
  /** False while its connect has not finished: no stream to it has opened. */
  readonly connected: boolean;
}

const isHolder = (value: unknown): value is PreviewStreamControlHolder =>
  typeof value === "object" &&
  value !== null &&
  "viewer" in value &&
  typeof value.viewer === "string" &&
  "attachedAt" in value &&
  (value.attachedAt === null || typeof value.attachedAt === "number") &&
  "connected" in value &&
  typeof value.connected === "boolean";

/** The optional fields a fork server adds to a control message; an upstream server sends none. */
export const decodeControlHolder = (message: Record<string, unknown>) => ({
  ...(typeof message.viewer === "string" ? { viewer: message.viewer } : {}),
  ...(isHolder(message.holder) ? { holder: message.holder } : {}),
});
