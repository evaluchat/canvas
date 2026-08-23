# Private Research Starter

> **SYNTHETIC: true.** This tree is a layout-1.0 example. The study has no real
> participants. Every researcher-adjacent file repeats that banner.

In-repo artefact for v0.8 GitHub-backed private research workspaces. The
public beta keeps that surface dark (`GITHUB_RESEARCH_WORKSPACES_ENABLED` is
off). Maintainer publishes `evaluchat/private-research-starter` from this tree
later. This directory does not depend on that GitHub repo existing.

## What it is

A minimal research-repository **layout 1.0** tree:

- Method: critic-versus-generator (synthetic packets only)
- One evidence file, one finding, one seed ledger snapshot + seal
- Workspace manifest at `.evaluchat/workspace.yml`

Copy this directory into a **private** GitHub repository. Bind it through the
workspace repository API:

`POST /api/workspace/items` with
`{ "kind": "research_repository", "installationId": 123, "repositoryId": 456 }`.

The managed branch is `evaluchat/workspace`. The repository must stay private.

## Privacy

Default content is synthetic. Do not replace it with identifiable classroom
data, student work, or raw participant material. Seal declarations still
require a human privacy review before any later publish path.
