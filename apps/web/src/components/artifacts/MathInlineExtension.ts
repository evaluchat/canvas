import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import katex from "katex";
import { findMathSpans } from "./math-markdown";

/**
 * Tiptap extension that renders math with KaTeX:
 * - display: `$$...$$`
 * - inline: `\(...\)` and `$...$`
 *
 * Uses ProseMirror decorations so the underlying document text is unchanged
 * (editing / markdown export keep the raw delimiters).
 */
export const mathInlinePluginKey = new PluginKey("mathInline");

type TextPiece = {
  /** Index in the flattened block text */
  flatFrom: number;
  flatTo: number;
  /** Document positions covering this text node */
  docFrom: number;
  docTo: number;
};

function collectBlockText(
  node: PMNode,
  pos: number
): {
  text: string;
  pieces: TextPiece[];
} | null {
  // BlockNote paragraphs / headings hold inline content; skip nested blocks.
  if (!node.isTextblock) return null;

  let text = "";
  const pieces: TextPiece[] = [];
  let offset = 0;

  node.forEach((child, childOffset) => {
    const childPos = pos + 1 + childOffset;
    if (child.isText && child.text) {
      const flatFrom = text.length;
      text += child.text;
      pieces.push({
        flatFrom,
        flatTo: text.length,
        docFrom: childPos,
        docTo: childPos + child.nodeSize,
      });
    } else if (child.type.name === "hardBreak") {
      text += "\n";
    }
    offset = childOffset + child.nodeSize;
  });

  void offset;
  if (!text) return null;
  return { text, pieces };
}

/** Map a flat-text range onto one or more document ranges (split by hardBreaks). */
function mapFlatRangeToDoc(
  pieces: TextPiece[],
  from: number,
  to: number
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const piece of pieces) {
    const overlapFrom = Math.max(from, piece.flatFrom);
    const overlapTo = Math.min(to, piece.flatTo);
    if (overlapFrom >= overlapTo) continue;
    const docFrom = piece.docFrom + (overlapFrom - piece.flatFrom);
    const docTo = piece.docFrom + (overlapTo - piece.flatFrom);
    ranges.push({ from: docFrom, to: docTo });
  }
  return ranges;
}

const MathInlineExtension = Extension.create({
  name: "mathInline",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mathInlinePluginKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const doc = state.doc;

            doc.descendants((node, pos) => {
              const collected = collectBlockText(node, pos);
              if (!collected) return true;

              const { text, pieces } = collected;
              for (const span of findMathSpans(text)) {
                const ranges = mapFlatRangeToDoc(pieces, span.from, span.to);
                if (ranges.length === 0) continue;

                for (const range of ranges) {
                  decorations.push(
                    Decoration.inline(range.from, range.to, {
                      style:
                        "font-size: 0; line-height: 0; display: inline-block; width: 0; height: 0; overflow: hidden;",
                    })
                  );
                }

                const anchor = ranges[0].from;
                decorations.push(
                  Decoration.widget(anchor, () => {
                    const el = document.createElement(
                      span.display ? "div" : "span"
                    );
                    el.className = span.display
                      ? "math-display-rendered"
                      : "math-inline-rendered";
                    if (span.display) {
                      el.style.margin = "0.75rem 0";
                      el.style.textAlign = "center";
                      el.style.overflowX = "auto";
                    }
                    try {
                      katex.render(span.formula, el, {
                        throwOnError: false,
                        displayMode: span.display,
                      });
                    } catch {
                      el.textContent = span.display
                        ? `$$${span.formula}$$`
                        : `$${span.formula}$`;
                    }
                    return el;
                  })
                );
              }

              return false;
            });

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});

export default MathInlineExtension;
