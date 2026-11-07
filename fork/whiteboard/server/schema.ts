// Defines the record schema every board room uses: tldraw's default records plus the mermaid shape.
import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema";
import { mermaidShapeSchema } from "../web/mermaidschema";

export const boardSchema = createTLSchema({
  shapes: { ...defaultShapeSchemas, mermaid: mermaidShapeSchema },
});
