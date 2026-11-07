// Exposes MermaidShapeUtil, a board shape that stores Mermaid source and shows it as a picture.
import { useEffect, useState } from "react";
import {
  BaseBoxShapeUtil,
  SVGContainer,
  useEditor,
  useValue,
  type SvgExportContext,
  type TLShape,
} from "tldraw";
import { mermaidShapeMigrations, mermaidShapeProps } from "./mermaidschema";
import { renderMermaid, type MermaidRender } from "./mermaid";

type MermaidShape = TLShape<"mermaid">;

const ERROR_COLORS = {
  light: { fill: "#fff1f0", stroke: "#d4483b", text: "#8f2219" },
  dark: { fill: "#3a1f1d", stroke: "#e5675b", text: "#f6c4be" },
};

// Draws the rendered picture, or a framed note with Mermaid's error, into the shape's box. An SVG
// <image> keeps the diagram inert: no script or link inside it runs.
function MermaidPicture({
  w,
  h,
  dark,
  result,
}: {
  w: number;
  h: number;
  dark: boolean;
  result: MermaidRender;
}) {
  if (result.ok)
    return (
      <image
        href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`}
        width={w}
        height={h}
        preserveAspectRatio="xMidYMid meet"
      />
    );
  const colors = ERROR_COLORS[dark ? "dark" : "light"];
  // A parse error's middle lines point at a column in monospace; its first and last lines say what is wrong.
  const lines = result.error.split("\n");
  return (
    <svg width={w} height={h} overflow="hidden">
      <rect
        x={1}
        y={1}
        width={Math.max(w - 2, 0)}
        height={Math.max(h - 2, 0)}
        rx={8}
        fill={colors.fill}
        stroke={colors.stroke}
        strokeWidth={2}
      />
      <text x={12} y={26} fill={colors.text} fontFamily="sans-serif" fontSize={14}>
        <tspan fontWeight="bold">Mermaid diagram error</tspan>
        <tspan x={12} dy={22}>
          {lines[0]}
        </tspan>
        {lines.length > 1 && (
          <tspan x={12} dy={22}>
            {lines.at(-1)}
          </tspan>
        )}
      </text>
    </svg>
  );
}

function MermaidOnBoard({ shape }: { shape: MermaidShape }) {
  const editor = useEditor();
  const dark = useValue("dark mode", () => editor.user.getIsDarkMode(), [editor]);
  const [shown, setShown] = useState<{ dark: boolean; result: MermaidRender }>();
  useEffect(() => {
    let live = true;
    void renderMermaid(shape.props.source, dark).then(
      (result) => live && setShown({ dark, result }),
    );
    return () => {
      live = false;
    };
  }, [shape.props.source, dark]);
  return (
    <SVGContainer>
      {shown && (
        <MermaidPicture
          w={shape.props.w}
          h={shape.props.h}
          dark={shown.dark}
          result={shown.result}
        />
      )}
    </SVGContainer>
  );
}

export class MermaidShapeUtil extends BaseBoxShapeUtil<MermaidShape> {
  static override type = "mermaid" as const;
  static override props = mermaidShapeProps;
  static override migrations = mermaidShapeMigrations;

  getDefaultProps(): MermaidShape["props"] {
    return { source: "flowchart LR\n  A --> B", w: 200, h: 100 };
  }

  override canEdit() {
    return false;
  }

  override isAspectRatioLocked() {
    return true;
  }

  component(shape: MermaidShape) {
    return <MermaidOnBoard shape={shape} />;
  }

  getIndicatorPath(shape: MermaidShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }

  override async toSvg(shape: MermaidShape, ctx: SvgExportContext) {
    const result = await renderMermaid(shape.props.source, ctx.isDarkMode);
    return (
      <MermaidPicture w={shape.props.w} h={shape.props.h} dark={ctx.isDarkMode} result={result} />
    );
  }
}
