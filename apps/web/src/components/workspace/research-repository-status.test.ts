import { describe, expect, it } from "vitest";
import type { RepositoryStatus } from "@opencanvas/shared/research-repository";
import {
  shortRepositoryCommit,
  shouldShowRepositoryConnect,
} from "./research-repository-status";

const status = (
  state: RepositoryStatus["state"],
  reason?: RepositoryStatus["reason"]
) =>
  ({
    workspaceId: "wi_repository",
    repositoryId: 101,
    state,
    reason,
    checkedAt: "2026-08-22T10:00:00.000Z",
  }) as RepositoryStatus;

describe("ResearchRepositoryStatus", () => {
  it("shortens the displayed head SHA", () => {
    expect(shortRepositoryCommit("a".repeat(40))).toBe("aaaaaaa");
  });

  it.each([
    status("disconnected", "disconnected"),
    status("blocked", "permission_lost"),
    status("read_only", "authorization_required"),
  ])("offers GitHub reconnection for missing access", (repositoryStatus) => {
    expect(shouldShowRepositoryConnect(repositoryStatus)).toBe(true);
  });

  it("does not offer reconnection for a healthy repository", () => {
    expect(shouldShowRepositoryConnect(status("ready"))).toBe(false);
  });
});
