# AGENTS.md — Evaluchat

Guidance for AI coding agents (and humans) working in this repository.

## What this is

Evaluchat is an open-source, AI-native Markdown document workspace — an
independent continuation of LangChain Open Canvas (MIT), and the public beta
application for the Evaluchat education research platform. See [README.md](README.md)
for the product story and setup, [CONTRIBUTING.md](CONTRIBUTING.md) for the
contribution workflow.

## Repo layout

| Path | Package | What it is |
|---|---|---|
| `apps/web` | `@opencanvas/web` | Next.js web app: UI + API routes |
| `apps/agents` | `@opencanvas/agents` | LangGraph agent graphs (generation, reflection, routing) |
| `apps/desktop` | `@opencanvas/desktop` | Electron desktop app (paused) |
| `packages/shared` | `@opencanvas/shared` | Shared types, constants, utilities |
| `packages/evals` | `@opencanvas/evals` | Evaluation harness |

## Quick start

```bash
yarn install
cp .env.example .env                       # root: model provider keys (agents)
cp apps/web/.env.example apps/web/.env     # web: Supabase keys + feature flags
```

Run (two terminals):

```bash
yarn workspace @opencanvas/agents dev      # LangGraph dev server, port 54367
yarn workspace @opencanvas/web dev         # Next.js dev server
```

## Checks

```bash
yarn format:check   # prettier
yarn lint           # eslint
yarn build          # turbo build
```

Unit tests: `cd apps/agents && npx vitest run` and `cd packages/shared && npx vitest run`.

## Conventions

- TypeScript strict; relative imports in `packages/shared` MUST use `.js` extensions.
- One logical change per commit; conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
- Don't reformat unrelated files — prettier debt in untouched files is documented, not fixed opportunistically.

## Product boundaries

- Education workflows, role routes, assignment APIs, apparatus runtime, prompts,
  routing, and instrumentation are open source in this repository.
- The public beta is hosted at `https://evaluchat.org`; `dev.evaluchat.org` is
  the pre-cutover environment. Credentials, production configuration, billing,
  and identifiable classroom data must never be committed.
- Research apparatus specifications and immutable profiles are authored through
  public GitHub PRs in the Research/Knowledge repositories. The app executes
  only reviewed built-in implementations mapped to known apparatus ids; it does
  not execute code from repositories.
- Self-hosting remains a design constraint and documentation target, but a
  turnkey self-host package and a Postgres migration are deferred beyond the
  beta. File-backed education data is acceptable when persistent storage and
  backup/restore are configured.
- Electron/Desktop work is paused. Preserve its documentation and code while
  avoiding new desktop scope during the beta release.

## Documentation routing (mandatory)

| Write here | Not here |
|------------|----------|
| README, CONTRIBUTING, `docs/contributing/` | `docs/architecture/`, `docs/research/`, `docs/*.html` |
| Code + tests + `.env.example` | Feature ADRs, threat models, orchestration plans |

Public product docs (including platform security designs) → [github.com/evaluchat/knowledge](https://github.com/evaluchat/knowledge)

Public research methodology governance → [github.com/evaluchat/research](https://github.com/evaluchat/research)

Private strategy and orchestration plans are not stored in this repository.

Allowed paths under `docs/`: `docs/contributing/` and `docs/electron-desktop/` only. CI enforces this allowlist.
