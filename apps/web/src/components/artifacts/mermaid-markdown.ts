const MERMAID_FENCE_RE = /```mermaid\r?\n([\s\S]*?)```/g;

function inlineContentToPlainText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((node: { type?: string; text?: string }) => {
      if (node?.type === "text") {
        return node.text ?? "";
      }
      return "";
    })
    .join("");
}

export function preprocessMarkdownForMermaidImport(markdown: string): {
  markdown: string;
  mermaidByPlaceholder: Map<string, string>;
} {
  const mermaidByPlaceholder = new Map<string, string>();
  let index = 0;

  const processed = markdown.replace(
    MERMAID_FENCE_RE,
    (_match, source: string) => {
      const placeholder = `MERMAID_PLACEHOLDER_${index++}`;
      mermaidByPlaceholder.set(placeholder, source.replace(/\n$/, ""));
      return `\n\n${placeholder}\n\n`;
    }
  );

  return { markdown: processed, mermaidByPlaceholder };
}

function convertBlockToMermaid(
  block: Record<string, unknown>,
  mermaidByPlaceholder: Map<string, string>
): Record<string, unknown> {
  if (block.type === "mermaid") {
    const children = Array.isArray(block.children)
      ? block.children.map((child) =>
          convertBlockToMermaid(
            child as Record<string, unknown>,
            mermaidByPlaceholder
          )
        )
      : [];
    return { ...block, children };
  }

  const text = inlineContentToPlainText(block.content).trim();
  if (mermaidByPlaceholder.has(text)) {
    return {
      type: "mermaid",
      props: {
        data: mermaidByPlaceholder.get(text),
        language: "mermaid",
      },
      children: Array.isArray(block.children)
        ? block.children.map((child) =>
            convertBlockToMermaid(
              child as Record<string, unknown>,
              mermaidByPlaceholder
            )
          )
        : [],
    };
  }

  if (Array.isArray(block.children) && block.children.length > 0) {
    return {
      ...block,
      children: block.children.map((child) =>
        convertBlockToMermaid(
          child as Record<string, unknown>,
          mermaidByPlaceholder
        )
      ),
    };
  }

  return block;
}

export function convertParsedBlocksToMermaid(
  blocks: Record<string, unknown>[],
  mermaidByPlaceholder: Map<string, string>
): Record<string, unknown>[] {
  if (mermaidByPlaceholder.size === 0) {
    return blocks;
  }
  return blocks.map((block) =>
    convertBlockToMermaid(block, mermaidByPlaceholder)
  );
}

export async function parseMarkdownToCanvasBlocks(
  editor: any,
  markdown: string
): Promise<Record<string, unknown>[]> {
  const { markdown: preprocessed, mermaidByPlaceholder } =
    preprocessMarkdownForMermaidImport(markdown);
  const blocks = await editor.tryParseMarkdownToBlocks(preprocessed);
  return convertParsedBlocksToMermaid(
    blocks as Record<string, unknown>[],
    mermaidByPlaceholder
  );
}

async function blockToMarkdown(
  editor: any,
  block: Record<string, unknown>
): Promise<string> {
  if (block.type === "mermaid") {
    const props = block.props as { data?: string } | undefined;
    const data = props?.data ?? "";
    return `\`\`\`mermaid\n${data}\n\`\`\``;
  }

  return editor.blocksToMarkdownLossy([block as never]);
}

export async function exportCanvasBlocksToMarkdown(
  editor: any,
  blocks: Record<string, unknown>[]
): Promise<string> {
  const parts = await Promise.all(
    blocks.map((block) => blockToMarkdown(editor, block))
  );
  return parts.join("\n\n");
}
