import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import katex from "katex";

/** Match $...$ (inline math, single $, non-greedy) */
const MATH_INLINE_RE = /\$(.+?)\$/g;

/**
 * Tiptap extension that renders inline math ($...$) using KaTeX.
 *
 * Uses ProseMirror decorations: an inline decoration hides the raw $...$ text
 * visually, while a widget decoration at the same position displays the
 * rendered KaTeX output. The underlying document text is never modified, so
 * editing and markdown export continue to work unchanged.
 */
export const mathInlinePluginKey = new PluginKey("mathInline");

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
              if (!node.isText || !node.text) return true;

              const text = node.text;
              let match: RegExpExecArray | null;
              MATH_INLINE_RE.lastIndex = 0;

              while ((match = MATH_INLINE_RE.exec(text)) !== null) {
                const formula = match[1];
                if (!formula || formula.trim().length === 0) continue;

                const from = pos + match.index;
                const to = pos + match.index + match[0].length;

                // Inline decoration: hide the raw $...$ text
                decorations.push(
                  Decoration.inline(from, to, {
                    style:
                      "font-size: 0; line-height: 0; display: inline-block; width: 0; height: 0; overflow: hidden;",
                  })
                );

                // Widget: display the rendered KaTeX output
                decorations.push(
                  Decoration.widget(from, () => {
                    const span = document.createElement("span");
                    span.className = "math-inline-rendered";
                    try {
                      katex.render(formula, span, {
                        throwOnError: false,
                      });
                    } catch {
                      span.textContent = `$${formula}$`;
                    }
                    return span;
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
