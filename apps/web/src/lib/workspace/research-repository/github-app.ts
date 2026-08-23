import { createHash, randomBytes } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";

const GITHUB_OAUTH_BASE_URL = "https://github.com";
const GITHUB_API_VERSION = "2022-11-28";

type OAuthTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

type GithubUserResponse = {
  id?: unknown;
  login?: unknown;
  avatar_url?: unknown;
};

type GithubInstallation = {
  id?: unknown;
  account?: {
    id?: unknown;
    login?: unknown;
    avatar_url?: unknown;
  } | null;
};

type GithubRepository = {
  id?: unknown;
  full_name?: unknown;
};

type GithubRepositoryResponse = {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  private?: unknown;
  default_branch?: unknown;
  owner?: { login?: unknown } | null;
};

type GithubBranchResponse = {
  commit?: { sha?: unknown } | null;
};

export type GithubResearchOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
};

export type GithubResearchConnection = {
  installationId?: number;
  repositoryIds: number[];
  displayMetadata: {
    githubUserId: number;
    login: string;
    avatarUrl?: string;
    installationAccount?: string;
    repositories: Array<{ id: number; nameWithOwner?: string }>;
  };
};

export type GithubInstallationRepository = {
  id: number;
  name: string;
  nameWithOwner: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

function applyGithubRequestTimeout(octokit: Octokit): Octokit {
  octokit.hook.before("request", (options) => {
    const signal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    options.signal = signal;
    options.request = { ...options.request, signal };
  });
  return octokit;
}

function oauthOctokit(): Octokit {
  return applyGithubRequestTimeout(
    new Octokit({
      baseUrl: GITHUB_OAUTH_BASE_URL,
    })
  );
}

function expiresAt(seconds: unknown, now: number): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return new Date(now + seconds * 1_000).toISOString();
}

function tokensFromResponse(
  data: OAuthTokenResponse,
  now = Date.now()
): GithubResearchOAuthTokens {
  if (typeof data.access_token !== "string" || !data.access_token) {
    const detail =
      typeof data.error_description === "string"
        ? data.error_description
        : typeof data.error === "string"
          ? data.error
          : "GitHub did not return an access token";
    throw new Error(detail);
  }
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : undefined,
    expiresAt: expiresAt(data.expires_in, now),
    refreshTokenExpiresAt: expiresAt(data.refresh_token_expires_in, now),
  };
}

export function githubResearchAppClientId(): string {
  return requiredEnvironment("GITHUB_RESEARCH_APP_CLIENT_ID");
}

export function githubResearchOAuthRedirectUrl(): string {
  return requiredEnvironment("GITHUB_RESEARCH_OAUTH_REDIRECT_URL");
}

export function createPkceChallenge(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw new Error("Invalid PKCE verifier");
  }
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createPkceChallenge(verifier) };
}

export function generateGithubOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildGithubAuthorizationUrl(options: {
  state: string;
  challenge: string;
  clientId?: string;
  redirectUrl?: string;
}): string {
  const url = new URL("/login/oauth/authorize", GITHUB_OAUTH_BASE_URL);
  url.searchParams.set(
    "client_id",
    options.clientId ?? githubResearchAppClientId()
  );
  url.searchParams.set(
    "redirect_uri",
    options.redirectUrl ?? githubResearchOAuthRedirectUrl()
  );
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGithubOAuthCode(
  code: string,
  verifier: string
): Promise<GithubResearchOAuthTokens> {
  const response = await oauthOctokit().request(
    "POST /login/oauth/access_token",
    {
      client_id: githubResearchAppClientId(),
      client_secret: requiredEnvironment("GITHUB_RESEARCH_APP_CLIENT_SECRET"),
      code,
      code_verifier: verifier,
      redirect_uri: githubResearchOAuthRedirectUrl(),
      headers: { accept: "application/json" },
    }
  );
  return tokensFromResponse(response.data as OAuthTokenResponse);
}

export async function refreshGithubUserToken(
  refreshToken: string
): Promise<GithubResearchOAuthTokens> {
  const response = await oauthOctokit().request(
    "POST /login/oauth/access_token",
    {
      client_id: githubResearchAppClientId(),
      client_secret: requiredEnvironment("GITHUB_RESEARCH_APP_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      headers: { accept: "application/json" },
    }
  );
  return tokensFromResponse(response.data as OAuthTokenResponse);
}

export async function refreshGithubUserTokenIfNeeded(
  tokens: GithubResearchOAuthTokens,
  now = Date.now()
): Promise<GithubResearchOAuthTokens> {
  if (
    !tokens.expiresAt ||
    new Date(tokens.expiresAt).getTime() > now + 30_000
  ) {
    return tokens;
  }
  if (!tokens.refreshToken) {
    throw new Error("Expired GitHub user token has no refresh token");
  }
  return refreshGithubUserToken(tokens.refreshToken);
}

export function createGithubUserOctokit(accessToken: string): Octokit {
  return applyGithubRequestTimeout(new Octokit({ auth: accessToken }));
}

export async function resolveGithubResearchConnection(
  accessToken: string,
  requestedInstallationId?: number
): Promise<GithubResearchConnection> {
  const octokit = createGithubUserOctokit(accessToken);
  const [userResponse, installations] = await Promise.all([
    octokit.request("GET /user", {
      headers: { "x-github-api-version": GITHUB_API_VERSION },
    }),
    octokit.paginate(octokit.rest.apps.listInstallationsForAuthenticatedUser, {
      per_page: 100,
      headers: { "x-github-api-version": GITHUB_API_VERSION },
    }),
  ]);
  const user = userResponse.data as GithubUserResponse;
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    throw new Error("GitHub returned invalid user metadata");
  }

  const availableInstallations = (installations as GithubInstallation[]).filter(
    (entry): entry is GithubInstallation & { id: number } =>
      typeof entry.id === "number" &&
      Number.isSafeInteger(entry.id) &&
      entry.id > 0
  );
  let installation: (GithubInstallation & { id: number }) | undefined;
  if (requestedInstallationId !== undefined) {
    installation = availableInstallations.find(
      (entry) => entry.id === requestedInstallationId
    );
    if (!installation) {
      throw new Error(
        "Requested GitHub installation is not available to this user"
      );
    }
  } else if (availableInstallations.length > 1) {
    throw new Error(
      "Multiple GitHub installations are available; select one explicitly"
    );
  } else {
    [installation] = availableInstallations;
  }
  const installationId = installation?.id;

  let repositories: GithubRepository[] = [];
  if (installationId !== undefined) {
    repositories = await octokit.paginate(
      octokit.rest.apps.listInstallationReposForAuthenticatedUser,
      {
        installation_id: installationId,
        per_page: 100,
        headers: { "x-github-api-version": GITHUB_API_VERSION },
      }
    );
  }
  const displayRepositories = repositories
    .filter(
      (repository): repository is GithubRepository & { id: number } =>
        typeof repository.id === "number"
    )
    .map((repository) => ({
      id: repository.id,
      nameWithOwner:
        typeof repository.full_name === "string"
          ? repository.full_name
          : undefined,
    }));

  return {
    installationId,
    repositoryIds: displayRepositories.map((repository) => repository.id),
    displayMetadata: {
      githubUserId: user.id,
      login: user.login,
      avatarUrl:
        typeof user.avatar_url === "string" ? user.avatar_url : undefined,
      installationAccount:
        typeof installation?.account?.login === "string"
          ? installation.account.login
          : undefined,
      repositories: displayRepositories,
    },
  };
}

function githubAppAuthOptions(installationId?: number) {
  return {
    appId: requiredEnvironment("GITHUB_RESEARCH_APP_ID"),
    privateKey: requiredEnvironment("GITHUB_RESEARCH_APP_PRIVATE_KEY").replace(
      /\\n/g,
      "\n"
    ),
    installationId,
  };
}

export function createGithubInstallationOctokit(
  installationId: number
): Octokit {
  return applyGithubRequestTimeout(
    new Octokit({
      authStrategy: createAppAuth,
      auth: githubAppAuthOptions(installationId),
    })
  );
}

/** Read repository metadata with installation-scoped App credentials. */
export async function getGithubInstallationRepository(
  installationId: number,
  repositoryId: number
): Promise<GithubInstallationRepository> {
  const octokit = createGithubInstallationOctokit(installationId);
  const response = await octokit.request("GET /repositories/{repository_id}", {
    repository_id: repositoryId,
    headers: { "x-github-api-version": GITHUB_API_VERSION },
  });
  const repository = response.data as GithubRepositoryResponse;
  if (
    repository.id !== repositoryId ||
    typeof repository.name !== "string" ||
    !repository.name ||
    typeof repository.full_name !== "string" ||
    !repository.full_name ||
    typeof repository.private !== "boolean" ||
    typeof repository.default_branch !== "string" ||
    !repository.default_branch ||
    typeof repository.owner?.login !== "string" ||
    !repository.owner.login
  ) {
    throw new Error("GitHub returned invalid repository metadata");
  }
  return {
    id: repositoryId,
    name: repository.name,
    nameWithOwner: repository.full_name,
    owner: repository.owner.login,
    private: repository.private,
    defaultBranch: repository.default_branch,
  };
}

/** Resolve the current head of one branch without retaining an App token. */
export async function getGithubRepositoryBranchHead(
  installationId: number,
  repository: Pick<GithubInstallationRepository, "owner" | "name">,
  branch: string
): Promise<string> {
  const octokit = createGithubInstallationOctokit(installationId);
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/branches/{branch}",
    {
      owner: repository.owner,
      repo: repository.name,
      branch,
      headers: { "x-github-api-version": GITHUB_API_VERSION },
    }
  );
  const sha = (response.data as GithubBranchResponse).commit?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("GitHub returned an invalid branch head");
  }
  return sha;
}

/** Create a repository branch with installation-scoped App credentials. */
export async function createGithubRepositoryBranch(
  installationId: number,
  repository: Pick<GithubInstallationRepository, "owner" | "name">,
  branch: string,
  sha: string
): Promise<void> {
  const octokit = createGithubInstallationOctokit(installationId);
  await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
    owner: repository.owner,
    repo: repository.name,
    ref: `refs/heads/${branch}`,
    sha,
    headers: { "x-github-api-version": GITHUB_API_VERSION },
  });
}

/** Mint an installation token on demand. Callers must never persist it. */
export async function mintGithubInstallationToken(
  installationId: number,
  repositoryIds?: number[]
): Promise<{ token: string; expiresAt: string }> {
  const octokit = createGithubInstallationOctokit(installationId);
  const authentication = (await octokit.auth({
    type: "installation",
    installationId,
    repositoryIds,
  })) as { token?: unknown; expiresAt?: unknown };
  if (
    typeof authentication.token !== "string" ||
    typeof authentication.expiresAt !== "string"
  ) {
    throw new Error("GitHub did not return an installation token");
  }
  return {
    token: authentication.token,
    expiresAt: authentication.expiresAt,
  };
}
