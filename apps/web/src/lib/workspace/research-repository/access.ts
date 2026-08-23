import { getGithubInstallationRepository } from "./github-app";
import { getRepositoryBranchHead } from "./git-adapter";
import { githubErrorStatus } from "./github-error-status";

export { githubErrorStatus } from "./github-error-status";

export const REPOSITORY_UNAVAILABLE = "REPOSITORY_UNAVAILABLE";
export const REPOSITORY_READ_ONLY = "REPOSITORY_READ_ONLY";
export const REPOSITORY_CHANGED = "REPOSITORY_CHANGED";
export const REPOSITORY_DISCONNECTED = "REPOSITORY_DISCONNECTED";

export const REPOSITORY_UNAVAILABLE_MESSAGE =
  "Repository unavailable (deleted or access removed).";
export const REPOSITORY_READ_ONLY_MESSAGE =
  "Repository became public — writes disabled.";
export const REPOSITORY_DISCONNECTED_MESSAGE =
  "Research repository is disconnected";

export type RepositoryAccessCode =
  | typeof REPOSITORY_UNAVAILABLE
  | typeof REPOSITORY_READ_ONLY
  | typeof REPOSITORY_CHANGED
  | typeof REPOSITORY_DISCONNECTED;

export class RepositoryAccessError extends Error {
  constructor(
    public readonly code: RepositoryAccessCode,
    message: string,
    public readonly files: string[] = []
  ) {
    super(message);
    this.name = "RepositoryAccessError";
  }
}

export function repositoryAccessHttpStatus(code: RepositoryAccessCode): number {
  return code === REPOSITORY_READ_ONLY ? 403 : 409;
}

export function repositoryAccessBody(error: RepositoryAccessError): {
  error: RepositoryAccessCode;
  message: string;
  files?: string[];
} {
  return {
    error: error.code,
    message: error.message,
    ...(error.files.length > 0 ? { files: error.files } : {}),
  };
}

export async function loadInstallationRepository(
  installationId: number,
  repositoryId: number
) {
  try {
    return await getGithubInstallationRepository(installationId, repositoryId);
  } catch (error) {
    if (githubErrorStatus(error) === 404) {
      throw new RepositoryAccessError(
        REPOSITORY_UNAVAILABLE,
        REPOSITORY_UNAVAILABLE_MESSAGE
      );
    }
    throw error;
  }
}

export function assertRepositoryPrivate(repository: { private?: boolean }) {
  if (repository.private !== true) {
    throw new RepositoryAccessError(
      REPOSITORY_READ_ONLY,
      REPOSITORY_READ_ONLY_MESSAGE
    );
  }
}

function changedMessage(files: string[]): string {
  if (files.length === 0) {
    return "Repository changed. Reconcile before writing.";
  }
  return `Repository changed. These files would be overwritten: ${files.join(", ")}`;
}

export async function assertRepositoryWriteAccess(input: {
  installationId: number;
  repositoryId: number;
  branch: string;
  expectedHeadSha: string;
  files?: string[];
}) {
  const files = input.files ?? [];
  const repository = await loadInstallationRepository(
    input.installationId,
    input.repositoryId
  );
  assertRepositoryPrivate(repository);

  let currentHead: string;
  try {
    currentHead = await getRepositoryBranchHead(
      input.installationId,
      repository,
      input.branch
    );
  } catch (error) {
    if (githubErrorStatus(error) === 404) {
      throw new RepositoryAccessError(
        REPOSITORY_CHANGED,
        changedMessage(files),
        files
      );
    }
    throw error;
  }

  if (currentHead !== input.expectedHeadSha) {
    throw new RepositoryAccessError(
      REPOSITORY_CHANGED,
      changedMessage(files),
      files
    );
  }

  return { repository, currentHead };
}
