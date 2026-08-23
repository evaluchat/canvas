# Evaluchat

[![CI](https://github.com/evaluchat/evaluchat/actions/workflows/ci.yml/badge.svg)](https://github.com/evaluchat/evaluchat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Open-source AI writing and education research workspace.** Evaluchat combines
an authoring workspace with reviewed, reproducible research apparatuses so
educators, administrators, and researchers can run classroom writing workflows
and inspect the evidence they produce.

Evaluchat is an independent, open-source continuation of
[LangChain Open Canvas](https://github.com/langchain-ai/open-canvas) (MIT). We're
grateful for the original project — see [Acknowledgments](#acknowledgments).

Try the public beta at [evaluchat.org](https://evaluchat.org), or run it yourself
(local or self-hosted — see [Setup locally](#setup-locally)).

## Features

- **Live markdown editing & rendering** — see the rendered document while you edit, no toggling
- **Rich formatting toolbar** — bold, italic, lists, quotes, code blocks and more
- **LaTeX equations & Mermaid diagrams** — rendered inline, in markdown and code artifacts
- **Optional AI assistance** — the assistant proposes edits when enabled; you approve or reject them inline
- **Artifact versioning** — every artifact carries a version history; travel back in time
- **Built-in memory** — a reflection agent remembers style rules and facts about you across sessions
- **Custom & pre-built quick actions** — one-click prompts for common writing and coding tasks
- **Code, Markdown, or both** — switch between code and markdown artifacts in the same session
- **Printer-friendly export / PDF** — clean output styling for print and PDF
- **Essays apparatus** — assignment context, immutable treatment profiles,
  constrained dialogue, teacher review, and student submission
- **Open research runtime** — apparatus specifications, configuration snapshots,
  telemetry contracts, and reproducibility fixtures are public
- **Organisation workspaces** — org admins invite teachers and students; route
  authorization and organisation isolation are enforced server-side

## Repo layout

| Path              | What it is                                                                      |
| ----------------- | ------------------------------------------------------------------------------- |
| `apps/web`        | Next.js web app (UI + API routes) — `@opencanvas/web`                           |
| `apps/agents`     | LangGraph agent graphs (generation, reflection, routing) — `@opencanvas/agents` |
| `packages/shared` | Shared types and utilities — `@opencanvas/shared`                               |
| `research-starter/` | Layout-1.0 Private Research Starter (SYNTHETIC default)                       |

## Setup locally

Prerequisites: **Node 22** and **Yarn 1.22** (corepack: `corepack enable`).

```bash
git clone https://github.com/evaluchat/evaluchat.git
cd evaluchat
yarn install
```

### 1. Environment

- **Root `.env`** — used by the agents (LangGraph). Copy `.env.example` → `.env` and add
  at least one model provider key (OpenAI, Anthropic, Google, Fireworks, or Groq).
- **`apps/web/.env`** — used by the web app. Copy `apps/web/.env.example` →
  `apps/web/.env`, set `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  (create a free Supabase project — it provides auth and persistence), and optionally
  `GROQ_API_KEY` (audio transcription) and `FIRECRAWL_API_KEY` (URL scraping).

### 2. Run

Terminal 1 — agents (LangGraph dev server on port 54367):

```bash
yarn workspace @opencanvas/agents dev
```

Terminal 2 — web app (Next.js dev server):

```bash
yarn workspace @opencanvas/web dev
```

Open http://localhost:3000.

### 3. Apparatus catalog

The checked-in catalog is generated from the public Research OKF and validated
strictly during the web build. With the Research repository checked out beside
this one, regenerate it with:

```bash
RESEARCH_OKF_ROOT=../okf/research yarn generate:apparatus
```

## Checks

```bash
yarn format:check   # prettier
yarn lint           # eslint
yarn build          # turbo build (all workspaces)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — setup, conventions, and the PR checklist.
External contributions are welcome; this is a small project, so please open an issue
before large changes. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Related surfaces

Evaluchat is one of Evaluchat's open surfaces. The same document workspace
also powers:

- **Evaluchat Essays** — the built-in education apparatus and assignment workflow
- **Evaluchat Research** — public GitHub-first research on AI in education and assessment

## Beta scope

Direct signup creates an isolated organisation-admin workspace at `/teacher`.
Invited teachers manage classes, assignments, and student invitations; invited
students see only assigned work. Research materials stay public in the beta.
v0.8 adds a **dark** GitHub-backed private research workspace (flag off).
[`research-starter/`](research-starter/) is the SYNTHETIC default for that
flow — no real participants; do not load identifiable classroom data into it.
The canonical Essays profile preserves the current four-message drafting
escape hatch, with valid gate-off, no-AI, and no-tracking profiles available
for comparison.

Desktop/Electron work is paused. Self-hosting guidance is retained, but a
turnkey self-host install and database migration are not launch deliverables.

## Acknowledgments

Evaluchat is derived from and inspired by
[LangChain Open Canvas](https://github.com/langchain-ai/open-canvas), licensed under
the MIT License. The original copyright notice and license text are preserved in
[LICENSE-LANGCHAIN](LICENSE-LANGCHAIN). We extend our appreciation to the LangChain
team and open-source contributors for the initial structural concept of canvas-based
AI interaction.

## License

MIT — see [LICENSE](LICENSE). Upstream attribution: [LICENSE-LANGCHAIN](LICENSE-LANGCHAIN).
