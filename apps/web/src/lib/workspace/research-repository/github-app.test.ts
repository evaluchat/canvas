import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  request: vi.fn(),
  paginate: vi.fn(),
  auth: vi.fn(),
  listInstallationsForAuthenticatedUser: vi.fn(),
  listInstallationReposForAuthenticatedUser: vi.fn(),
  Octokit: vi.fn(function OctokitMock() {
    return {
      request: harness.request,
      paginate: harness.paginate,
      auth: harness.auth,
      rest: {
        apps: {
          listInstallationsForAuthenticatedUser:
            harness.listInstallationsForAuthenticatedUser,
          listInstallationReposForAuthenticatedUser:
            harness.listInstallationReposForAuthenticatedUser,
        },
      },
    };
  }),
  createAppAuth: vi.fn(),
}));

vi.mock("octokit", () => ({ Octokit: harness.Octokit }));
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: harness.createAppAuth,
}));

import {
  buildGithubAuthorizationUrl,
  createGithubRepositoryBranch,
  createPkceChallenge,
  exchangeGithubOAuthCode,
  generatePkcePair,
  getGithubInstallationRepository,
  getGithubRepositoryBranchHead,
  mintGithubInstallationToken,
  refreshGithubUserToken,
  refreshGithubUserTokenIfNeeded,
  resolveGithubResearchConnection,
} from "./github-app";

beforeEach(() => {
  vi.stubEnv("GITHUB_RESEARCH_APP_CLIENT_ID", "Iv1.client");
  vi.stubEnv("GITHUB_RESEARCH_APP_CLIENT_SECRET", "client-secret");
  vi.stubEnv(
    "GITHUB_RESEARCH_OAUTH_REDIRECT_URL",
    "https://evaluchat.test/api/workspace/github/callback"
  );
  vi.stubEnv("GITHUB_RESEARCH_APP_ID", "1234");
  vi.stubEnv("GITHUB_RESEARCH_APP_PRIVATE_KEY", "private\\nkey");
  harness.request.mockReset();
  harness.paginate.mockReset();
  harness.auth.mockReset();
  harness.Octokit.mockClear();
  harness.createAppAuth.mockClear();
});

describe("GitHub App OAuth helpers", () => {
  it("generates an S256 PKCE verifier/challenge pair", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(createPkceChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );

    const generated = generatePkcePair();
    expect(generated.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(generated.challenge).toBe(createPkceChallenge(generated.verifier));
  });

  it("builds the user authorization URL without an ignored scope and with PKCE", () => {
    const url = new URL(
      buildGithubAuthorizationUrl({ state: "state-1", challenge: "challenge" })
    );
    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize"
    );
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges a code with its PKCE verifier", async () => {
    harness.request.mockResolvedValue({
      data: {
        access_token: "ghu_access",
        refresh_token: "ghr_refresh",
        expires_in: 3600,
      },
    });

    await expect(
      exchangeGithubOAuthCode("oauth-code", "a".repeat(43))
    ).resolves.toMatchObject({
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
    });
    expect(harness.request).toHaveBeenCalledWith(
      "POST /login/oauth/access_token",
      expect.objectContaining({
        code: "oauth-code",
        code_verifier: "a".repeat(43),
      })
    );
  });

  it("uses the refresh token when refreshing", async () => {
    harness.request.mockResolvedValue({
      data: { access_token: "ghu_new", refresh_token: "ghr_new" },
    });

    await expect(refreshGithubUserToken("ghr_old")).resolves.toMatchObject({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
    });
    expect(harness.request).toHaveBeenCalledWith(
      "POST /login/oauth/access_token",
      expect.objectContaining({
        grant_type: "refresh_token",
        refresh_token: "ghr_old",
      })
    );
  });

  it("refreshes an expired exchanged token", async () => {
    harness.request.mockResolvedValue({ data: { access_token: "ghu_new" } });
    const result = await refreshGithubUserTokenIfNeeded(
      {
        accessToken: "ghu_old",
        refreshToken: "ghr_refresh",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
      Date.parse("2026-01-01T00:00:00.000Z")
    );
    expect(result.accessToken).toBe("ghu_new");
    expect(harness.request).toHaveBeenCalledWith(
      "POST /login/oauth/access_token",
      expect.objectContaining({ refresh_token: "ghr_refresh" })
    );
  });

  it("resolves installation and repository metadata with user auth", async () => {
    harness.request.mockResolvedValueOnce({
      data: { id: 7, login: "octo", avatar_url: "https://avatar.test/7" },
    });
    harness.paginate
      .mockResolvedValueOnce([{ id: 99, account: { login: "octo" } }])
      .mockResolvedValueOnce([{ id: 101, full_name: "octo/private" }]);

    await expect(
      resolveGithubResearchConnection("ghu_access", 99)
    ).resolves.toEqual({
      installationId: 99,
      repositoryIds: [101],
      displayMetadata: {
        githubUserId: 7,
        login: "octo",
        avatarUrl: "https://avatar.test/7",
        installationAccount: "octo",
        repositories: [{ id: 101, nameWithOwner: "octo/private" }],
      },
    });
    expect(harness.paginate).toHaveBeenNthCalledWith(
      1,
      harness.listInstallationsForAuthenticatedUser,
      expect.objectContaining({ per_page: 100 })
    );
    expect(harness.paginate).toHaveBeenNthCalledWith(
      2,
      harness.listInstallationReposForAuthenticatedUser,
      expect.objectContaining({ installation_id: 99, per_page: 100 })
    );
  });

  it("rejects a requested installation the user cannot access", async () => {
    harness.request.mockResolvedValue({ data: { id: 7, login: "octo" } });
    harness.paginate.mockResolvedValue([{ id: 100 }]);

    await expect(
      resolveGithubResearchConnection("ghu_access", 99)
    ).rejects.toThrow(
      "Requested GitHub installation is not available to this user"
    );
    expect(harness.paginate).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit choice when multiple installations are available", async () => {
    harness.request.mockResolvedValue({ data: { id: 7, login: "octo" } });
    harness.paginate.mockResolvedValue([{ id: 99 }, { id: 100 }]);

    await expect(resolveGithubResearchConnection("ghu_access")).rejects.toThrow(
      "Multiple GitHub installations are available; select one explicitly"
    );
    expect(harness.paginate).toHaveBeenCalledTimes(1);
  });

  it("mints installation tokens just in time through app auth", async () => {
    harness.auth.mockResolvedValue({
      token: "ghs_ephemeral",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });

    await expect(mintGithubInstallationToken(99, [101])).resolves.toEqual({
      token: "ghs_ephemeral",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    expect(harness.Octokit).toHaveBeenCalledWith(
      expect.objectContaining({
        authStrategy: harness.createAppAuth,
        auth: expect.objectContaining({ installationId: 99 }),
      })
    );
    expect(harness.auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 99,
      repositoryIds: [101],
    });
  });

  it("reads private repository metadata with installation auth", async () => {
    harness.request.mockResolvedValue({
      data: {
        id: 101,
        name: "private",
        full_name: "octocat/private",
        private: true,
        default_branch: "main",
        owner: { login: "octocat" },
      },
    });

    await expect(getGithubInstallationRepository(99, 101)).resolves.toEqual({
      id: 101,
      name: "private",
      nameWithOwner: "octocat/private",
      owner: "octocat",
      private: true,
      defaultBranch: "main",
    });
    expect(harness.request).toHaveBeenCalledWith(
      "GET /repositories/{repository_id}",
      expect.objectContaining({ repository_id: 101 })
    );
  });

  it("surfaces GitHub API errors from installation repository reads", async () => {
    harness.request.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    await expect(
      getGithubInstallationRepository(99, 101)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reads a branch head with installation auth", async () => {
    const sha = "a".repeat(40);
    harness.request.mockResolvedValue({ data: { commit: { sha } } });

    await expect(
      getGithubRepositoryBranchHead(
        99,
        { owner: "octocat", name: "private" },
        "evaluchat/workspace"
      )
    ).resolves.toBe(sha);
    expect(harness.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/branches/{branch}",
      expect.objectContaining({
        owner: "octocat",
        repo: "private",
        branch: "evaluchat/workspace",
      })
    );
  });

  it("creates a branch ref with installation auth", async () => {
    const sha = "a".repeat(40);
    harness.request.mockResolvedValue({ data: {} });

    await createGithubRepositoryBranch(
      99,
      { owner: "octocat", name: "private" },
      "evaluchat/workspace",
      sha
    );

    expect(harness.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/git/refs",
      expect.objectContaining({
        owner: "octocat",
        repo: "private",
        ref: "refs/heads/evaluchat/workspace",
        sha,
      })
    );
  });
});
