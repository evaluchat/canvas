export type MathSpan = {
  from: number;
  to: number;
  formula: string;
  display: boolean;
};

/**
 * Find KaTeX-renderable spans in a text fragment.
 * Order: display `$$...$$`, then `\(...\)`, then single-`$` inline (not `$$`).
 */
export function findMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  const occupied: Array<{ from: number; to: number }> = [];

  const overlaps = (from: number, to: number) =>
    occupied.some((r) => from < r.to && to > r.from);

  const take = (re: RegExp, display: boolean, formulaGroup = 1): void => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const from = match.index;
      const to = from + match[0].length;
      const formula = match[formulaGroup]?.trim() ?? "";
      if (!formula || overlaps(from, to)) continue;
      spans.push({ from, to, formula, display });
      occupied.push({ from, to });
    }
  };

  take(/\$\$([\s\S]+?)\$\$/g, true);
  take(/\\\(([\s\S]+?)\\\)/g, false);
  // Single-dollar inline; do not consume $$ delimiters.
  take(/(?<!\$)\$(?!\$)([\s\S]+?)(?<!\$)\$(?!\$)/g, false);

  return spans.sort((a, b) => a.from - b.from);
}

/**
 * Collapse display-math blocks onto fewer lines and rewrite `\(...\)` to `$...$`
 * so BlockNote keeps formulas in fewer text nodes and the decoration plugin
 * can find them after markdown import.
 */
export function preprocessMarkdownForMath(markdown: string): string {
  return markdown
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => {
      const compact = body
        .trim()
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .replace(/\s{2,}/g, " ");
      return `$$\n${compact}\n$$`;
    })
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body}$`);
}
