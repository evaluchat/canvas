import { buildAssignmentSystemPrompt } from "@/lib/teaching/assignment-prompt";
import type { StudentAssignment } from "@/lib/teaching/types";
import type { MethodParticipantWorkspaceItem, WorkspaceItem } from "./types";
import type { EvidenceSnapshot } from "./evidence";

export function supportsWorkspaceThreads(item: WorkspaceItem): boolean {
  return (
    item.kind === "markdown_template" ||
    item.kind === "form_template" ||
    item.kind === "method" ||
    item.kind === "method_participant" ||
    item.kind === "ledger" ||
    item.kind === "ledger_snapshot"
  );
}

export function methodParticipantAsAssignment(
  item: MethodParticipantWorkspaceItem
): StudentAssignment {
  return {
    id: item.id,
    courseLabel: item.assignment.course,
    teacherName: item.assignment.group,
    dueLabel: item.assignment.dueDate,
    title: item.assignment.title,
    prompt: item.assignment.prompt,
    agentInstructions: item.assignment.agentInstructions,
    wordTarget: item.assignment.wordTarget,
    completionPercent: item.submission?.status === "submitted" ? 100 : 0,
    status:
      item.submission?.status === "submitted" ? "submitted" : "in_progress",
    apparatusConfiguration: item.apparatusConfiguration,
  };
}

function assistantGuidance(item: WorkspaceItem): string {
  if (item.kind === "method_participant") {
    return buildAssignmentSystemPrompt(
      methodParticipantAsAssignment(item),
      item.apparatusConfiguration
    );
  }
  if (
    item.kind === "ledger" ||
    item.kind === "ledger_snapshot" ||
    item.kind === "research_repository"
  ) {
    return "";
  }
  return item.templateSnapshot.assistantGuidance;
}

export function enforceWorkspaceThreadPolicy(
  body: Record<string, any>,
  item: WorkspaceItem,
  userId: string,
  assistantId: string,
  evidenceSnapshot?: EvidenceSnapshot
): Record<string, any> {
  const activeEvidenceSnapshot = evidenceSnapshot ?? undefined;

  return {
    ...body,
    assistant_id: assistantId,
    metadata: {
      ...(body.metadata && typeof body.metadata === "object"
        ? body.metadata
        : {}),
      user_id: userId,
      workspace_item_id: item.id,
      ...(item.kind === "method_participant"
        ? { method_run_id: item.runId }
        : {}),
    },
    config: {
      ...(body.config && typeof body.config === "object" ? body.config : {}),
      configurable: {
        ...(body.config?.configurable &&
        typeof body.config.configurable === "object"
          ? (() => {
              const configurable = {
                ...(body.config.configurable as Record<string, unknown>),
              };
              delete configurable.apparatusConfiguration;
              return configurable;
            })()
          : {}),
        workspace_item_id: item.id,
        systemPrompt:
          activeEvidenceSnapshot?.guidance ?? assistantGuidance(item),
        ...(activeEvidenceSnapshot
          ? {
              evidence_layout: activeEvidenceSnapshot.layoutMarkdown,
              evidence_fields: activeEvidenceSnapshot.fields,
              evidence_frozen_values: activeEvidenceSnapshot.frozenValues,
              evidence_template_version: activeEvidenceSnapshot.templateVersion,
            }
          : {}),
        ...(item.kind === "method_participant"
          ? { apparatusConfiguration: item.apparatusConfiguration }
          : {}),
      },
    },
  };
}
