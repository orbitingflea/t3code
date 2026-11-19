import { describe, expect, it } from "@effect/vitest";

import { parseZulipPanelUrl, zulipPanelFrameSource } from "./zulipPanel.ts";

describe("parseZulipPanelUrl", () => {
  it.each<[raw: string, url: string | undefined]>([
    ["https://zulip.example.com/", "https://zulip.example.com/"],
    ["https://zulip.example.com", "https://zulip.example.com/"],
    ["http://localhost:6310/", "http://localhost:6310/"],
    ["http://127.0.0.1:6310/", "http://127.0.0.1:6310/"],
    ["http://[::1]:6310/", "http://[::1]:6310/"],
    ["http://zulip.example.com/", undefined],
    ["https://user:pw@zulip.example.com/", undefined],
    ["javascript:alert(1)", undefined],
    ["data:text/html,x", undefined],
    ["", undefined],
    ["zulip.example.com", undefined],
  ])("%j gives %j", (raw, url) => {
    expect(parseZulipPanelUrl(raw)).toBe(url);
  });
});

describe("zulipPanelFrameSource", () => {
  const ZULIP = "https://zulip.example.com/";

  it.each<[why: string, rawUrl: string, pageOrigin: string, source: string | undefined]>([
    ["sibling names under a two-label parent", ZULIP, "https://t3.example.com", ZULIP],
    [
      "sibling names under a longer parent",
      "https://zulip.team.example.com/",
      "https://t3.team.example.com",
      "https://zulip.team.example.com/",
    ],
    [
      "one name on two ports",
      "http://localhost:6310/",
      "http://localhost:3773",
      "http://localhost:6310/",
    ],
    ["the page's own origin", "https://t3.example.com/", "https://t3.example.com", undefined],
    ["another parent domain", ZULIP, "https://t3.example.org", undefined],
    ["a longer look-alike name", ZULIP, "https://t3.example.com.evil.example", undefined],
    ["names under a one-label parent", "https://b.com/", "https://a.com", undefined],
    [
      "names that end with the root dot",
      "https://zulip.example.com./",
      "https://t3.example.com.",
      undefined,
    ],
    ["two addresses", "http://127.0.0.2:6310/", "http://127.0.0.1:3773", undefined],
    ["an https URL from an http page", ZULIP, "http://t3.example.com", undefined],
    ["the desktop app's page", ZULIP, "t3code://app", undefined],
    ["a URL the parser rejects", "http://zulip.example.com/", "http://t3.example.com", undefined],
  ])("%s: %j framed from %j gives %j", (_why, rawUrl, pageOrigin, source) => {
    expect(zulipPanelFrameSource(rawUrl, pageOrigin)).toBe(source);
  });
});
