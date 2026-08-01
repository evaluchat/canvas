import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";

import { MermaidBlock } from "./MermaidBlock";

export const canvasSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    mermaid: MermaidBlock,
  },
});
