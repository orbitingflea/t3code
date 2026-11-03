import type { CDPSession } from "playwright-core";

const TEXT_LIMIT = 1024 * 1024;
const EVENT = "t3-preview-page-copy";
// Long enough for a copy button that awaits a fetch first; a new press or key ends it sooner.
const PAGE_COPY_WINDOW_MS = 2_000;

// Within a trusted press window the server forwards any text the page reports (wrapped writes,
// copy events, or this event dispatched by page script), whether or not the browser would allow
// the write. It sends only when the controlling viewer releases a left press, and only into
// that viewer's clipboard.
const MAIN_SCRIPT = `(() => {
  const proto = globalThis.Clipboard?.prototype;
  if (!proto) return;
  const send = (text) => dispatchEvent(new CustomEvent(${JSON.stringify(EVENT)}, { detail: String(text) }));
  const { writeText, write } = proto;
  proto.writeText = function (text) {
    const written = writeText.apply(this, arguments);
    if (arguments.length > 0) written.then(() => send(text), () => {});
    return written;
  };
  proto.write = function (items) {
    const written = write.apply(this, arguments);
    try {
      const item = [...items].find((candidate) => candidate.types.includes("text/plain"));
      if (item)
        Promise.all([item.getType("text/plain").then((blob) => blob.text()), written])
          .then(([text]) => send(text), () => {});
    } catch {}
    return written;
  };
})();`;

const WORLD_SCRIPT = `(() => {
  let armedUntil = 0;
  let copied = "";
  let waiter = null;
  const settle = (text) => {
    const resolve = waiter;
    waiter = null;
    resolve?.(text);
  };
  const flush = () => {
    if (!waiter || !copied) return;
    const text = copied;
    copied = "";
    settle(text);
  };
  addEventListener("pointerdown", (event) => {
    if (!event.isTrusted) return;
    armedUntil = performance.now() + ${PAGE_COPY_WINDOW_MS};
    copied = "";
    settle("");
  }, true);
  // Copy and cut keys have their own path; any key ends the click's window.
  addEventListener("keydown", (event) => {
    if (!event.isTrusted) return;
    armedUntil = 0;
    copied = "";
    settle("");
  }, true);
  const record = (text) => {
    if (performance.now() > armedUntil) return;
    text = String(text ?? "").slice(0, ${TEXT_LIMIT});
    if (!text) return;
    copied = text;
    setTimeout(flush);
  };
  addEventListener(${JSON.stringify(EVENT)}, (event) => record(event.detail));
  const selection = () => {
    let field = document.activeElement;
    while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null)
      return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart);
    return String(document.getSelection() ?? "");
  };
  for (const type of ["copy", "cut"]) {
    addEventListener(type, (event) => {
      if (event.isTrusted) record(selection());
    }, true);
    addEventListener(type, (event) => {
      if (event.isTrusted && event.defaultPrevented) record(event.clipboardData?.getData("text/plain"));
    });
  }
  globalThis.takePageCopy = () => {
    if (copied) {
      const text = copied;
      copied = "";
      return text;
    }
    const left = armedUntil - performance.now();
    if (left <= 0) return "";
    settle("");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (waiter === done) settle("");
      }, left);
      const done = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
      waiter = done;
    });
  };
})();`;

/** Installs page-copy recording; call after `Page.enable` on the same session. */
export const recordPageCopies = async (cdp: CDPSession, worldName: string) => {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: MAIN_SCRIPT,
    runImmediately: true,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: WORLD_SCRIPT,
    worldName,
    runImmediately: true,
  });
};

const takeSessionCopy = async (cdp: CDPSession, worldName: string) => {
  const tree = await cdp.send("Page.getFrameTree").catch(() => null);
  if (!tree) return [];
  const frameIds = (node: typeof tree.frameTree): Array<string> => [
    node.frame.id,
    ...(node.childFrames ?? []).flatMap(frameIds),
  ];
  return Promise.all(
    frameIds(tree.frameTree).map((frameId) =>
      cdp
        .send("Page.createIsolatedWorld", { frameId, worldName })
        .then(({ executionContextId }) =>
          cdp.send("Runtime.evaluate", {
            contextId: executionContextId,
            expression: "globalThis.takePageCopy?.()",
            awaitPromise: true,
            returnByValue: true,
          }),
        )
        .then(
          ({ result }) => (typeof result.value === "string" ? result.value : ""),
          () => "",
        ),
    ),
  );
};

/**
 * Text the page reported copying after the latest trusted press (see the note at the top),
 * waiting out the press's window for a report that has not come yet.
 */
export const takePageCopy = async (sessions: Iterable<CDPSession>, worldName: string) => {
  const copies = await Promise.all([...sessions].map((cdp) => takeSessionCopy(cdp, worldName)));
  return copies.flat().find((text) => text.length > 0);
};

/** After the viewer releases a left press, sends what the page reported copying if they still control the tab. */
export const forwardPressCopy = async (
  tab: {
    readonly cdp: CDPSession;
    readonly frameSessions: ReadonlyMap<unknown, CDPSession>;
    readonly control: { readonly controller: string | null };
    readonly desktop: unknown;
  },
  viewer: {
    readonly id: string;
    readonly push: (output: { _tag: "clipboard"; text: string }) => void;
  },
  button: string,
  worldName: string,
) => {
  if (button !== "left" || tab.desktop) return;
  const text = await takePageCopy([tab.cdp, ...tab.frameSessions.values()], worldName);
  if (text && tab.control.controller === viewer.id) viewer.push({ _tag: "clipboard", text });
};
