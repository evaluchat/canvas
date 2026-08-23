import { Client } from "@langchain/langgraph-sdk";
import { LANGGRAPH_API_URL } from "@/constants";
import {
  isGithubResearchRepositoryAiEnabled,
  isGithubResearchWorkspacesEnabled,
} from "@/lib/research-workspaces-enabled.server";

export const RESEARCH_REPOSITORY_ASSISTANT_ID = "research_repository";
export const MAX_CURRENT_ARTIFACT_BYTES = 32 * 1024;
// Repository artifact paths are resolved server-side, so 1 KiB is ample.
export const MAX_CURRENT_ARTIFACT_PATH_BYTES = 1024;
export const MAX_CONVERSATION_MESSAGES = 24;
export const MAX_CONVERSATION_BYTES = 64 * 1024;

export type ResearchRepositoryAssistantMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ResearchRepositoryAssistantInput = {
  conversation: readonly ResearchRepositoryAssistantMessage[];
  currentArtifact?: {
    path: string;
    text: string;
  };
};

export class ResearchRepositoryAssistantDisabledError extends Error {
  constructor() {
    super("Research repository assistant is disabled");
    this.name = "ResearchRepositoryAssistantDisabledError";
  }
}

export class ResearchRepositoryAssistantPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchRepositoryAssistantPayloadError";
  }
}

function client(): Client {
  return new Client({
    apiUrl: LANGGRAPH_API_URL,
    apiKey: process.env.LANGCHAIN_API_KEY,
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateInput(input: ResearchRepositoryAssistantInput): void {
  for (const message of input.conversation) {
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") {
      throw new ResearchRepositoryAssistantPayloadError(
        'Conversation message role must be "user" or "assistant"'
      );
    }
  }

  if (input.conversation.length > MAX_CONVERSATION_MESSAGES) {
    throw new ResearchRepositoryAssistantPayloadError(
      `Conversation exceeds ${MAX_CONVERSATION_MESSAGES} messages`
    );
  }

  const conversationBytes = input.conversation.reduce(
    (total, message) => total + byteLength(message.content),
    0
  );
  if (conversationBytes > MAX_CONVERSATION_BYTES) {
    throw new ResearchRepositoryAssistantPayloadError(
      `Conversation exceeds ${MAX_CONVERSATION_BYTES} bytes`
    );
  }

  if (
    input.currentArtifact &&
    byteLength(input.currentArtifact.text) > MAX_CURRENT_ARTIFACT_BYTES
  ) {
    throw new ResearchRepositoryAssistantPayloadError(
      `Current artifact exceeds ${MAX_CURRENT_ARTIFACT_BYTES} bytes`
    );
  }

  if (
    input.currentArtifact &&
    byteLength(input.currentArtifact.path) > MAX_CURRENT_ARTIFACT_PATH_BYTES
  ) {
    throw new ResearchRepositoryAssistantPayloadError(
      `Current artifact path exceeds ${MAX_CURRENT_ARTIFACT_PATH_BYTES} bytes`
    );
  }
}

/**
 * Starts a stateless run. Callers must resend the recent conversation on every
 * invocation; passing null as the thread id prevents checkpoint persistence.
 */
export function streamResearchRepositoryAssistant(
  input: ResearchRepositoryAssistantInput
) {
  if (
    !isGithubResearchWorkspacesEnabled() ||
    !isGithubResearchRepositoryAiEnabled()
  ) {
    throw new ResearchRepositoryAssistantDisabledError();
  }

  validateInput(input);

  // Rebuild the payload explicitly so callers cannot smuggle repository bodies
  // through additional message or artifact properties.
  const graphInput = {
    messages: input.conversation.map(({ role, content }) => ({
      role,
      content,
    })),
    ...(input.currentArtifact
      ? {
          currentArtifact: {
            path: input.currentArtifact.path,
            text: input.currentArtifact.text,
          },
        }
      : {}),
  };

  return client().runs.stream(null, RESEARCH_REPOSITORY_ASSISTANT_ID, {
    input: graphInput,
    streamMode: "messages-tuple",
  });
}
