import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import * as PreviewPageCopy from "./previewPageCopy.ts";

const WORLD = "t3-test-copy";
const ORIGIN = "https://copy.test";

describe("preview page copy", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    await context.grantPermissions(["clipboard-write"], { origin: ORIGIN });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send("Page.enable");
    await PreviewPageCopy.recordPageCopies(cdp, WORLD);
  });
  afterEach(async () => {
    await context.close();
  });

  const open = async (body: string) => {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><body>${body}<button id="other">other</button></body>`,
      }),
    );
    await page.goto(`${ORIGIN}/`);
  };
  const take = () => PreviewPageCopy.takePageCopy([cdp], WORLD);
  const press = async (selector: string) => {
    await page.click(selector);
    return take();
  };

  it.each([
    {
      name: "clipboard.writeText",
      script: `navigator.clipboard.writeText("npm i one")`,
      text: "npm i one",
    },
    {
      name: "clipboard.write with text/plain",
      script: `navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob(["two"], { type: "text/plain" }) })])`,
      text: "two",
    },
    {
      name: "execCommand copy of a selected textarea",
      script: `const area = document.createElement("textarea"); area.value = "three"; document.body.append(area); area.select(); document.execCommand("copy"); area.remove()`,
      text: "three",
    },
    {
      name: "a copy handler that sets its own data",
      script: `document.addEventListener("copy", (event) => { event.clipboardData.setData("text/plain", "four"); event.preventDefault(); }, { once: true }); document.execCommand("copy")`,
      text: "four",
    },
    {
      name: "a write that follows an await",
      script: `setTimeout(() => navigator.clipboard.writeText("five"), 300)`,
      text: "five",
    },
  ])("a copy button using $name reaches the viewer", async ({ script, text }) => {
    await open(`<button id="copy" onclick='${script}'>copy</button>`);
    expect(await press("#copy")).toBe(text);
    expect(await take()).toBeUndefined();
  });

  it("a copy button inside a frame reaches the viewer", async () => {
    await open(
      `<iframe srcdoc="<button id=copy onclick='navigator.clipboard.writeText(&quot;framed&quot;)'>copy</button>"></iframe>`,
    );
    await page.frameLocator("iframe").locator("#copy").click();
    expect(await take()).toBe("framed");
  });

  it("ignores writes no viewer press asked for", async () => {
    await open(`<button id="copy" onclick='navigator.clipboard.writeText("asked")'>copy</button>`);
    await page.evaluate(`navigator.clipboard.writeText("on load")`);
    expect(await take()).toBeUndefined();

    await page.evaluate(`
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      dispatchEvent(new CustomEvent("t3-preview-page-copy", { detail: "forged" }));
      navigator.clipboard.writeText("synthetic press");
    `);
    expect(await take()).toBeUndefined();

    await page.click("#copy");
    await page.click("#other");
    expect(await take()).toBeUndefined();

    await page.click("#copy");
    await page.keyboard.press("a");
    expect(await take()).toBeUndefined();
  });

  it("ignores writes the browser rejects", async () => {
    await open(`<button id="copy" onclick='navigator.clipboard.writeText().catch(() => {})'>copy</button>
      <button id="denied" onclick='navigator.clipboard.writeText("denied").catch(() => {})'>denied</button>`);
    expect(await press("#copy")).toBeUndefined();
    await context.clearPermissions();
    expect(await press("#denied")).toBeUndefined();
  });

  it("a press that copies nothing returns once its window ends", async () => {
    await open("");
    expect(await press("#other")).toBeUndefined();
  });
});

describe("forwardPressCopy", () => {
  const session = (copy: string) =>
    ({
      send: async (method: string) =>
        method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "main" } } }
          : method === "Page.createIsolatedWorld"
            ? { executionContextId: 1 }
            : { result: { value: copy } },
    }) as unknown as CDPSession;

  it.each([
    {
      name: "the controller's left press",
      button: "left",
      controller: "viewer",
      desktop: null,
      sent: true,
    },
    { name: "a right press", button: "right", controller: "viewer", desktop: null, sent: false },
    {
      name: "a viewer who lost control",
      button: "left",
      controller: "other",
      desktop: null,
      sent: false,
    },
    { name: "a desktop tab", button: "left", controller: "viewer", desktop: {}, sent: false },
  ])("sends for $name: $sent", async ({ button, controller, desktop, sent }) => {
    const pushed: Array<unknown> = [];
    const tab = {
      cdp: session(""),
      frameSessions: new Map([["frame", session("from button")]]),
      control: { controller },
      desktop,
    };
    await PreviewPageCopy.forwardPressCopy(
      tab,
      { id: "viewer", push: (output) => pushed.push(output) },
      button,
      WORLD,
    );
    expect(pushed).toEqual(sent ? [{ _tag: "clipboard", text: "from button" }] : []);
  });
});
