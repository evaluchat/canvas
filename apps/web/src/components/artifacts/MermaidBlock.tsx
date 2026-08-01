"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { Pencil } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const MERMAID_THEME = {
  bg: "hsl(var(--background))",
  fg: "hsl(var(--foreground))",
  accent: "hsl(var(--primary))",
  muted: "hsl(var(--muted-foreground))",
  border: "hsl(var(--border))",
  transparent: true,
} as const;

const mermaidPropSchema = {
  data: {
    default: "" as const,
  },
  language: {
    default: "mermaid" as const,
  },
} as const;

type MermaidRendererModule = typeof import("beautiful-mermaid");

let mermaidModulePromise: Promise<MermaidRendererModule> | null = null;

function loadMermaidRenderer() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("beautiful-mermaid");
  }
  return mermaidModulePromise;
}

function getMermaidCodeLanguage(element: HTMLElement): string | null {
  const dataLanguage = element.getAttribute("data-language");
  if (dataLanguage) {
    return dataLanguage;
  }

  const className = element.className || "";
  const match = className.match(/language-([\w-]+)/);
  return match ? match[1] : null;
}

function findMermaidCodeElement(element: HTMLElement): HTMLElement | null {
  if (element.tagName === "CODE") {
    if (getMermaidCodeLanguage(element) === "mermaid") {
      return element;
    }
  }

  if (element.tagName === "PRE") {
    const code = element.querySelector("code");
    if (code && getMermaidCodeLanguage(code) === "mermaid") {
      return code;
    }
  }

  return null;
}

function parseMermaidElement(element: HTMLElement) {
  const codeElement = findMermaidCodeElement(element);
  if (!codeElement) {
    return undefined;
  }

  return {
    data: codeElement.textContent ?? "",
    language: "mermaid" as const,
  };
}

function MermaidSvg({ code, className }: { code: string; className?: string }) {
  const [renderer, setRenderer] = useState<MermaidRendererModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadMermaidRenderer()
      .then((module) => {
        if (!cancelled) {
          setRenderer(module);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load Mermaid"
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const rendered = useMemo(() => {
    if (!renderer || !code.trim()) {
      return { svg: null as string | null, error: null as string | null };
    }

    try {
      return {
        svg: renderer.renderMermaidSVG(code, MERMAID_THEME),
        error: null,
      };
    } catch (error: unknown) {
      return {
        svg: null,
        error:
          error instanceof Error ? error.message : "Invalid Mermaid diagram",
      };
    }
  }, [renderer, code]);

  if (loadError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        {loadError}
      </div>
    );
  }

  if (!renderer) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        Loading diagram...
      </div>
    );
  }

  if (rendered.error) {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {rendered.error}
        </div>
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-xs">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (!rendered.svg) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        Empty Mermaid diagram
      </div>
    );
  }

  return (
    <div
      className={className}
      contentEditable={false}
      dangerouslySetInnerHTML={{ __html: rendered.svg }}
    />
  );
}

function MermaidBlockRender(props: any) {
  const [isEditingSource, setIsEditingSource] = useState(false);
  const [draft, setDraft] = useState(props.block.props.data);

  useEffect(() => {
    if (!isEditingSource) {
      setDraft(props.block.props.data);
    }
  }, [props.block.props.data, isEditingSource]);

  const handleSave = () => {
    props.editor.updateBlock(props.block, {
      props: {
        data: draft,
        language: "mermaid",
      },
    });
    setIsEditingSource(false);
  };

  return (
    <div
      className="my-2 w-full rounded-md border border-border bg-background p-3"
      contentEditable={false}
      data-testid="mermaid-block"
    >
      {isEditingSource && props.editor.isEditable ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[160px] font-mono text-sm"
            data-testid="mermaid-source-editor"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave}>
              Done
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(props.block.props.data);
                setIsEditingSource(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <MermaidSvg
            code={props.block.props.data}
            className="w-full overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full"
          />
          {props.editor.isEditable ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsEditingSource(true)}
                data-testid="mermaid-edit-button"
              >
                <Pencil className="mr-1 h-3.5 w-3.5" />
                Edit diagram
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MermaidToExternalHTML({ block }: any) {
  return (
    <pre>
      <code className="language-mermaid">{block.props.data}</code>
    </pre>
  );
}

export const MermaidBlock = createReactBlockSpec(
  {
    type: "mermaid",
    propSchema: mermaidPropSchema,
    content: "none",
  },
  {
    render: MermaidBlockRender,
    toExternalHTML: MermaidToExternalHTML,
    parse: parseMermaidElement,
  }
);
