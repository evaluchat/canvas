import type {
  ApparatusConfiguration,
  LedgerConfig,
  LedgerDimension,
  LedgerMissingSemantics,
  LedgerPublicationRef,
  LedgerSnapshotData,
} from "@opencanvas/shared";
import type { ResearchRepositoryWorkspaceItem } from "@opencanvas/shared/research-repository";

export const DEFAULT_WORKSPACE_TEMPLATE_ID = "evaluchat-getting-started";
export const FINDING_STARTER_TEMPLATE_ID = "finding-starter";
export const DEFAULT_METHOD_PROFILE_ID = "canonical-constrained-dialogue";

export type FormFieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "roster";

export type FormFieldDefinition = {
  id: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  readOnly?: boolean;
  source?: string;
  maxLength?: number;
  displayChars?: number;
  displayLines?: number;
  options?: string[];
  min?: number;
  max?: number;
  minDate?: string;
  maxDate?: string;
  ledgerDimension?: LedgerDimension;
  missingSemantics?: LedgerMissingSemantics;
};

export type FormValue = string | number | string[];

export type MarkdownTemplateSnapshot = {
  kind: "markdown";
  title: string;
  description: string;
  initialMarkdown: string;
  assistantGuidance: string;
  contentHash: string;
};

export type FormTemplateSnapshot = {
  kind: "form";
  templateId: string;
  templateVersion: string;
  catalogRevision: string;
  contentHash: string;
  title: string;
  description: string;
  assistantGuidance: string;
  layoutMarkdown: string;
  fields: Record<string, FormFieldDefinition>;
};

export type SubmittedForm = {
  status: "submitted";
  values: Record<string, FormValue>;
  resolvedMarkdown: string;
  submittedAt: string;
};

export type EvidenceThreadStatus =
  | "draft"
  | "submitting"
  | "submitted"
  | "filed";

export type EvidenceThreadReference = {
  threadId: string;
  status: EvidenceThreadStatus;
  templateVersion: string;
  submissionKey?: string;
  values?: Record<string, string>;
  submittedAt?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
};

export type EvidenceTemplateSnapshot = {
  kind: "evidence";
  templateId: "evidence-template";
  templateVersion: string;
  defaultStage?: string;
  sourcePath: string;
  guidance: string;
  layoutMarkdown: string;
  fields: Record<string, FormFieldDefinition>;
  frozenValues: Record<string, string | number | null>;
};

type WorkspaceItemBase = {
  id: string;
  ownerId: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
  source: {
    catalogRevision: string;
    templateId: string;
    templateVersion: string;
    sourcePath: string;
  };
};

export type MarkdownWorkspaceItem = WorkspaceItemBase & {
  kind: "markdown_template";
  threadId?: string;
  templateSnapshot: MarkdownTemplateSnapshot;
};

export type FormWorkspaceItem = WorkspaceItemBase & {
  kind: "form_template";
  threadId?: string;
  templateSnapshot: FormTemplateSnapshot;
  submission?: SubmittedForm;
};

export type MethodSource = {
  id: string;
  version: string;
  title?: string;
  description?: string;
  url?: string;
};

export type MethodProfileOption = {
  id: string;
  label: string;
};

export type MethodRunAssignment = {
  title: string;
  course: string;
  dueDate: string;
  wordTarget: number;
  prompt: string;
  agentInstructions: string;
  group: string;
};

export type MethodRunParticipant = {
  email: string;
  userId?: string;
  itemId?: string;
  invitationStatus: "sent" | "accepted";
  submissionStatus: "not_started" | "in_progress" | "submitted";
  submittedAt?: string;
  threadId?: string;
};

export type MethodRun = {
  id: string;
  status: "in_progress";
  launchedAt: string;
  methodId: string;
  methodVersion: string;
  profileId: string;
  apparatusConfiguration: ApparatusConfiguration;
  assignment: MethodRunAssignment;
  participants: MethodRunParticipant[];
};

export type MethodWorkspaceItem = WorkspaceItemBase & {
  kind: "method";
  threadId?: string;
  templateSnapshot: FormTemplateSnapshot;
  methodSource: MethodSource;
  profileId: string;
  profiles: MethodProfileOption[];
  submission?: SubmittedForm;
  run?: MethodRun;
  evidenceThreads?: EvidenceThreadReference[];
};

export type MethodParticipantWorkspaceItem = WorkspaceItemBase & {
  kind: "method_participant";
  threadId?: string;
  runId: string;
  operatorItemId: string;
  operatorId: string;
  methodSource: MethodSource;
  profileId: string;
  apparatusConfiguration: ApparatusConfiguration;
  assignment: MethodRunAssignment;
  submission?: {
    status: "submitted";
    submittedAt: string;
  };
};

export type LedgerSource = {
  methodId: string;
  methodVersion: string;
  templateId: string;
  templateVersion: string;
  sourceCommit: string;
  methodTitle?: string;
  baselineAcceptedEvidenceCount?: number;
};

export type LedgerWorkspaceItem = Omit<WorkspaceItemBase, "source"> & {
  kind: "ledger";
  ledgerConfig: LedgerConfig;
  snapshotIds: string[];
  source: LedgerSource;
};

export type LedgerSnapshotWorkspaceItem = Omit<WorkspaceItemBase, "source"> & {
  kind: "ledger_snapshot";
  parentLedgerItemId: string;
  snapshot: LedgerSnapshotData;
  /** Present after a draft research PR has been created. */
  publication?: LedgerPublicationRef;
  config: LedgerConfig;
  source: LedgerSource;
};

export type FormBackedWorkspaceItem = FormWorkspaceItem | MethodWorkspaceItem;

export type UnusableResearchRepositoryWorkspaceItem = {
  id: string;
  kind: "research_repository";
  unusable: true;
  ownerId?: string;
  status?: string;
  updatedAt: string;
  createdAt: string;
  binding?: { repositoryId?: number };
};

export type WorkspaceItem =
  | MarkdownWorkspaceItem
  | FormWorkspaceItem
  | MethodWorkspaceItem
  | MethodParticipantWorkspaceItem
  | LedgerWorkspaceItem
  | LedgerSnapshotWorkspaceItem
  | ResearchRepositoryWorkspaceItem
  | UnusableResearchRepositoryWorkspaceItem;

export function isUsableResearchRepository(
  item: WorkspaceItem
): item is ResearchRepositoryWorkspaceItem {
  return (
    item.kind === "research_repository" &&
    !("unusable" in item && item.unusable === true)
  );
}

export type UsableWorkspaceItem = Exclude<
  WorkspaceItem,
  UnusableResearchRepositoryWorkspaceItem
>;

export type WorkspaceManifest = {
  initialized: boolean;
  defaultItemId?: string;
  items: Record<string, WorkspaceItem>;
};

export type PendingMethodInvite = {
  email: string;
  runId: string;
  operatorId: string;
  operatorItemId: string;
  methodId: string;
  methodVersion: string;
  methodSource?: MethodSource;
  profileId: string;
  apparatusConfiguration: ApparatusConfiguration;
  assignment: MethodRunAssignment;
  createdAt: string;
};
