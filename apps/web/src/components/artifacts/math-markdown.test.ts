import { describe, expect, it } from "vitest";
import { findMathSpans, preprocessMarkdownForMath } from "./math-markdown";

describe("findMathSpans", () => {
  it("finds display math $$...$$ including multiline", () => {
    const text = "intro\n$$\nE = w_t T + w_c C\n$$\nend";
    const spans = findMathSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].display).toBe(true);
    expect(spans[0].formula).toBe("E = w_t T + w_c C");
  });

  it("finds LaTeX-delimiter inline math \\(...\\)", () => {
    const text = "where \\(T\\) and \\(\\tau\\) matter";
    const spans = findMathSpans(text);
    expect(spans.map((s) => s.formula)).toEqual(["T", "\\tau"]);
    expect(spans.every((s) => !s.display)).toBe(true);
  });

  it("finds single-dollar inline without consuming $$", () => {
    const text = "rate $x$ and $$\nE=1\n$$";
    const spans = findMathSpans(text);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ formula: "x", display: false });
    expect(spans[1]).toMatchObject({ formula: "E=1", display: true });
  });

  it("handles unlock cases display block from the CAMDLE paper", () => {
    const text = String.raw`$$
\text{unlock} =
\begin{cases}
1 & \text{if } E \geq \tau \\
0 & \text{if } E < \tau
\end{cases}
$$`;
    const spans = findMathSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].display).toBe(true);
    expect(spans[0].formula).toContain("\\begin{cases}");
  });
});

describe("preprocessMarkdownForMath", () => {
  it("rewrites \\(...\\) to $...$ for BlockNote import", () => {
    expect(preprocessMarkdownForMath("where \\(T\\) holds")).toBe(
      "where $T$ holds"
    );
  });

  it("collapses multiline display math onto a compact $$ block", () => {
    const input = String.raw`$$
E = w_t T + w_c C
$$`;
    const out = preprocessMarkdownForMath(input);
    expect(out).toBe("$$\nE = w_t T + w_c C\n$$");
    expect(findMathSpans(out)).toHaveLength(1);
  });
});
