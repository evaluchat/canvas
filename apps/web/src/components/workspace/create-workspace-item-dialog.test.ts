import { describe, expect, it } from "vitest";
import {
  buildResearchRepositoryCreateBody,
  buildWorkspaceItemCreateBody,
  workspaceItemCreationKinds,
} from "./create-workspace-item-dialog";

describe("CreateWorkspaceItemDialog request bodies", () => {
  it("creates a plain method item request body", () => {
    expect(
      buildWorkspaceItemCreateBody({ id: "method-1", kind: "method" })
    ).toEqual({ kind: "method", methodId: "method-1" });
  });

  it("creates an Evidence Ledger item request body", () => {
    expect(
      buildWorkspaceItemCreateBody({ id: "ledger-demo-method", kind: "ledger" })
    ).toEqual({ kind: "ledger", methodId: "ledger-demo-method" });
  });

  it("creates a research repository request body", () => {
    expect(buildResearchRepositoryCreateBody({ id: 101 }, 99)).toEqual({
      kind: "research_repository",
      installationId: 99,
      repositoryId: 101,
    });
  });

  it("omits the private repository entry while the server flag is off", () => {
    expect(workspaceItemCreationKinds(false)).not.toContain(
      "research_repository"
    );
    expect(workspaceItemCreationKinds(true)).toContain("research_repository");
  });
});
