// Renders Mermaid source to a standalone SVG in the board's light or dark theme, loading Mermaid on first use.
export type MermaidRender =
  | { ok: true; svg: string; w: number; h: number }
  | { ok: false; error: string };

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const FONT_FAMILY = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

const renders = new Map<string, Promise<MermaidRender>>();
// Mermaid's configuration is global, so each render runs alone after the one before it.
let queue: Promise<unknown> = Promise.resolve();
let host: HTMLElement | undefined;
let count = 0;

export function renderMermaid(source: string, dark: boolean): Promise<MermaidRender> {
  const key = `${dark ? "dark" : "light"}\n${source}`;
  let result = renders.get(key);
  if (!result) {
    result = queue.then(() => draw(source, dark));
    queue = result;
    renders.set(key, result);
  }
  return result;
}

// Mermaid measures label text in the live page, so it draws into a hidden element that still has
// layout; its lang picks the same fallback fonts the picture is later drawn with.
function measuringHost() {
  if (!host) {
    host = document.createElement("div");
    host.lang = navigator.language || "en";
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      visibility: "hidden",
      pointerEvents: "none",
    });
    document.body.append(host);
  }
  return host;
}

async function draw(source: string, dark: boolean): Promise<MermaidRender> {
  try {
    const { default: mermaid } = await import("mermaid");
    await document.fonts.ready;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      htmlLabels: false,
      fontFamily: FONT_FAMILY,
      // A source's %%{init}%% line or front matter cannot change the keys listed here.
      secure: [
        ...(mermaid.mermaidAPI.defaultConfig.secure ?? []),
        "theme",
        "themeVariables",
        "themeCSS",
        "darkMode",
        "htmlLabels",
        "fontFamily",
        "fontSize",
      ],
    });
    const target = measuringHost();
    const { svg } = await mermaid.render(`wb-mermaid-${++count}`, source, target);
    return standalone(svg, target.lang);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.trim() || "Mermaid could not draw this source" };
  }
}

// Mermaid returns HTML markup sized to its container; an <img> needs well-formed XML with its own size.
function standalone(markup: string, lang: string): MermaidRender {
  const root = new DOMParser().parseFromString(markup, "text/html").querySelector("svg");
  const box = root?.viewBox.baseVal;
  if (!root || !box || !(box.width > 0 && box.height > 0))
    return { ok: false, error: "Mermaid drew an empty picture" };
  root.setAttribute("width", String(box.width));
  root.setAttribute("height", String(box.height));
  root.style.removeProperty("max-width");
  root.setAttribute("lang", lang);
  root.setAttributeNS(XML_NS, "xml:lang", lang);
  return {
    ok: true,
    svg: new XMLSerializer().serializeToString(root),
    w: box.width,
    h: box.height,
  };
}
