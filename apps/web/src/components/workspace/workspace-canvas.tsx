"use client";

import { useEffect, useRef, useState } from "react";
import { HumanMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "uuid";
import { Canvas } from "@/components/canvas";
import { useAssistantContext } from "@/contexts/AssistantContext";
import { useGraphContext } from "@/contexts/GraphContext";
import { useThreadContext } from "@/contexts/ThreadProvider";
import { useUserContext } from "@/contexts/UserContext";
import { useWorkspaceItem } from "@/contexts/WorkspaceItemContext";
import { convertToOpenAIFormat } from "@/lib/convert_messages";
import { OC_HIDE_FROM_UI_KEY } from "@opencanvas/shared/constants";
import {
  FINDING_STARTER_TEMPLATE_ID,
  isUsableResearchRepository,
  type MarkdownWorkspaceItem,
} from "@/lib/workspace/types";
import { workspaceItemTitle } from "@/lib/workspace/display";
import { WorkspaceItemBanner } from "./workspace-item-banner";
import { WorkspaceItemDeleteDialog } from "./workspace-item-delete-dialog";
import { FindingLedgerPickerDialog } from "./finding-ledger-picker";
import { FormWorkspaceCanvas } from "./form-workspace-canvas";
import { MethodParticipantCanvas } from "./method-participant-canvas";
import { MethodRunCanvas } from "./method-run-canvas";
import { EvidenceCanvas } from "./evidence-canvas";
import { LedgerCanvas } from "./ledger-canvas";
import { LedgerSnapshotCanvas } from "./ledger-snapshot-canvas";
import { RepositoryPanel } from "@/components/research-repository/repository-panel";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  getArtifactContent,
  isArtifactMarkdownContent,
} from "@opencanvas/shared/utils/artifacts";
import {
  insertLedgerReference,
  type MergedLedger,
} from "@/lib/workspace/ledger-reference";

function MarkdownWorkspaceCanvas({ item }: { item: MarkdownWorkspaceItem }) {
  const { user } = useUserContext();
  const { threadId, setThreadId } = useThreadContext();
  const { graphData } = useGraphContext();
  const { selectedAssistant } = useAssistantContext();
  const router = useRouter();
  const { toast } = useToast();
  const bootstrappedItem = useRef<string | null>(null);
  const kickedOffItem = useRef<string | null>(null);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [isAbandoning, setIsAbandoning] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isFinding = item.source.templateId === FINDING_STARTER_TEMPLATE_ID;

  function currentMarkdown(): string {
    if (!graphData.artifact) return item.templateSnapshot.initialMarkdown;
    const content = getArtifactContent(graphData.artifact);
    return isArtifactMarkdownContent(content)
      ? content.fullMarkdown
      : item.templateSnapshot.initialMarkdown;
  }

  function applyMarkdown(next: string) {
    if (!graphData.artifact) {
      graphData.setArtifact({
        currentIndex: 1,
        contents: [
          {
            index: 1,
            type: "text",
            title: item.templateSnapshot.title,
            fullMarkdown: next,
          },
        ],
      });
    } else {
      const current = getArtifactContent(graphData.artifact);
      graphData.setArtifact({
        ...graphData.artifact,
        contents: graphData.artifact.contents.map((content) =>
          content.index === current.index && content.type === "text"
            ? { ...content, fullMarkdown: next }
            : content
        ),
      });
    }
    graphData.setUpdateRenderedArtifactRequired(true);
  }

  function citeLedger(ledger: MergedLedger) {
    applyMarkdown(insertLedgerReference(currentMarkdown(), ledger));
  }

  async function submitFinding() {
    setIsSubmitting(true);
    try {
      const response = await fetch(
        `/api/workspace/items/${encodeURIComponent(item.id)}/finding/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ markdown: currentMarkdown() }),
        }
      );
      const body = (await response.json()) as {
        error?: string;
        issues?: { message: string }[];
      };
      if (!response.ok) {
        toast({
          title: "Finding is not ready to submit",
          description:
            body.issues?.map((issue) => issue.message).join(" ") ||
            body.error ||
            "Validation failed.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Finding checks passed",
        description:
          "Linked ledgers and research questions resolved. Create the research PR when you are ready.",
      });
    } catch (error) {
      console.error("Failed to validate finding", error);
      toast({
        title: "Could not validate finding",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function abandonItem() {
    setIsAbandoning(true);
    try {
      const response = await fetch(
        `/api/workspace/items/${encodeURIComponent(item.id)}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!response.ok) throw new Error("Could not abandon workspace item");
      setAbandonOpen(false);
      router.push("/workspace");
    } catch (error) {
      console.error("Failed to abandon workspace item", error);
      toast({
        title: "Could not abandon item",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsAbandoning(false);
    }
  }

  useEffect(() => {
    if (bootstrappedItem.current === item.id) return;
    bootstrappedItem.current = item.id;

    if (item.threadId) {
      void setThreadId(item.threadId);
      graphData.setChatStarted(true);
      return;
    }

    graphData.clearState();
    void setThreadId(null);
    graphData.setArtifact({
      currentIndex: 1,
      contents: [
        {
          index: 1,
          type: "text",
          title: item.templateSnapshot.title,
          fullMarkdown: item.templateSnapshot.initialMarkdown,
        },
      ],
    });
    graphData.setUpdateRenderedArtifactRequired(true);
    graphData.setChatStarted(true);
    // Bootstrap is intentionally keyed by the immutable item id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  useEffect(() => {
    if (
      !user ||
      !selectedAssistant ||
      !graphData.chatStarted ||
      !graphData.artifact ||
      graphData.messages.length > 0 ||
      graphData.isStreaming ||
      threadId ||
      kickedOffItem.current === item.id
    ) {
      return;
    }

    kickedOffItem.current = item.id;
    const kickoff = new HumanMessage({
      id: uuidv4(),
      content: "Open this workspace item and welcome the user.",
      additional_kwargs: { [OC_HIDE_FROM_UI_KEY]: true },
    });
    graphData.setMessages([kickoff]);
    void graphData
      .streamMessage({
        messages: [convertToOpenAIFormat(kickoff)],
        next: "replyToGeneralInput",
      })
      .catch((error) => {
        kickedOffItem.current = null;
        console.error("Workspace kickoff failed", error);
      });
    // Kickoff is intentionally keyed by state transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    item.id,
    user?.id,
    selectedAssistant,
    graphData.chatStarted,
    graphData.artifact,
    graphData.messages.length,
    graphData.isStreaming,
    threadId,
  ]);

  return (
    <>
      <Canvas
        editorBanner={
          <WorkspaceItemBanner
            item={item}
            onAbandon={() => setAbandonOpen(true)}
            onSubmit={isFinding ? () => void submitFinding() : undefined}
            submitDisabled={isSubmitting}
            submitLabel="Submit finding"
            extraActions={
              isFinding ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPickerOpen(true)}
                  className="border-white/35 bg-transparent text-white hover:bg-white/12 hover:text-white"
                  data-testid="cite-published-ledger"
                >
                  Cite published ledger
                </Button>
              ) : undefined
            }
          />
        }
      />
      {isFinding && (
        <FindingLedgerPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onSelect={citeLedger}
        />
      )}
      <WorkspaceItemDeleteDialog
        open={abandonOpen}
        onOpenChange={setAbandonOpen}
        onConfirm={() => void abandonItem()}
        itemTitle={workspaceItemTitle(item)}
        isDeleting={isAbandoning}
        confirmLabel="Abandon"
      />
    </>
  );
}

export function WorkspaceCanvas() {
  const { item, loading } = useWorkspaceItem();
  const searchParams = useSearchParams();

  if (loading || !item) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Loading workspace item…
      </div>
    );
  }

  const evidenceThreadId = searchParams.get("evidence");
  if (item.kind === "research_repository") {
    if (!isUsableResearchRepository(item)) {
      return (
        <main className="min-h-screen bg-slate-50 p-8">
          <p className="text-sm text-amber-800">
            Repository binding is unusable
          </p>
        </main>
      );
    }
    return (
      <main className="min-h-screen bg-slate-50 p-8">
        <div className="mx-auto max-w-6xl">
          <RepositoryPanel item={item} />
        </div>
      </main>
    );
  }
  if (item.kind === "ledger") {
    return <LedgerCanvas item={item} />;
  }

  if (item.kind === "ledger_snapshot") {
    return <LedgerSnapshotCanvas item={item} />;
  }

  if (item.kind === "method" && evidenceThreadId) {
    return <EvidenceCanvas item={item} threadId={evidenceThreadId} />;
  }

  if (item.kind === "form_template" || (item.kind === "method" && !item.run)) {
    return <FormWorkspaceCanvas item={item} />;
  }

  if (item.kind === "method") {
    return <MethodRunCanvas item={item} />;
  }

  if (item.kind === "method_participant") {
    return <MethodParticipantCanvas item={item} />;
  }

  return <MarkdownWorkspaceCanvas item={item} />;
}
