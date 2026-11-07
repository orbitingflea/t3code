// Exposes window.wbMermaid on mermaid.html, the page wb uses to render a diagram and read its size.
import { renderMermaid, type MermaidRender } from "./mermaid";

declare global {
  interface Window {
    wbMermaid?: (source: string) => Promise<MermaidRender>;
  }
}

window.wbMermaid = (source) => renderMermaid(source, false);
