// Defines the mermaid shape's record, its props validators and migrations, for both the sync server and the board.
import {
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  type RecordPropsType,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

// The stored source is the diagram; w and h are the box the picture is drawn into.
export const mermaidShapeProps = {
  source: T.string,
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
};
export type MermaidShapeProps = RecordPropsType<typeof mermaidShapeProps>;

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    mermaid: MermaidShapeProps;
  }
}

const versions = createShapePropsMigrationIds("mermaid", { Introduce: 1 });

// The sync server turns away a client that lacks a migration with no down step. So this first
// migration makes tabs opened before the mermaid shape existed fail at connect (CLIENT_TOO_OLD)
// instead of connecting and then failing on the first mermaid record.
export const mermaidShapeMigrations = createShapePropsMigrationSequence({
  sequence: [{ id: versions.Introduce, up: () => {} }],
});

export const mermaidShapeSchema = { props: mermaidShapeProps, migrations: mermaidShapeMigrations };
