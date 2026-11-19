import * as Schema from "effect/Schema";

/**
 * Sent only by a machine that sets `T3CODE_ZULIP_PANEL_URL`: the page the Zulip tab frames.
 * The URL stays a plain string here, so a bad value can never fail the server config's decoding.
 */
export const ZulipPanelCapability = Schema.Struct({ url: Schema.String });
export type ZulipPanelCapability = typeof ZulipPanelCapability.Type;

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127(\.\d+){3}$/.test(hostname);

/**
 * The URL in normal form, or undefined when the tab must stay off.
 *
 * Accepts an absolute `https:` URL with no user name or password, and `http:` only for
 * `localhost` and loopback addresses. `javascript:` and `data:` can never become a frame source.
 */
export function parseZulipPanelUrl(raw: string): string | undefined {
  const url = parseUrl(raw);
  if (url === undefined || url.username !== "" || url.password !== "") return undefined;
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  return allowed ? url.href : undefined;
}

/** The host name without its first label, when that parent has at least two labels. */
function parentDomain(hostname: string): string | undefined {
  const labels = hostname.split(".");
  if (labels.length < 3 || labels.includes("")) return undefined;
  // A parsed host whose last label is a number is an IPv4 address, which has no parent.
  if (/^\d+$/.test(labels.at(-1) ?? "")) return undefined;
  return labels.slice(1).join(".");
}

/**
 * Sibling hosts: the same name (then the ports differ), or two names with the same parent domain
 * (`t3.example.com` and `zulip.example.com` give `example.com`). This stands in for "same site"
 * without a public suffix list.
 */
function isSiblingHost(left: string, right: string): boolean {
  if (left === right) return true;
  const parent = parentDomain(left);
  return parent !== undefined && parent === parentDomain(right);
}

/**
 * The URL a page at `pageOrigin` may frame, or undefined: `parseZulipPanelUrl`, plus the page is
 * another origin (a same-origin frame with scripts could reach into T3 Code's own page) with the
 * same scheme on a sibling host. Zulip's login cookie is `SameSite=Lax`, sent to a frame only on
 * the page's own site, so from the desktop app or another domain the tab could never be logged in.
 */
export function zulipPanelFrameSource(rawUrl: string, pageOrigin: string): string | undefined {
  const source = parseZulipPanelUrl(rawUrl);
  const page = parseUrl(pageOrigin);
  if (source === undefined || page === undefined) return undefined;
  const frame = new URL(source);
  if (page.protocol !== frame.protocol || page.origin === frame.origin) return undefined;
  return isSiblingHost(page.hostname, frame.hostname) ? source : undefined;
}
