# Local development

Prerequisites: **Node 22** and **Yarn 1.22** (`corepack enable`).

```bash
git clone https://github.com/evaluchat/evaluchat.git
cd evaluchat
yarn install
```

## Environment

- **Root `.env`** — model provider keys for LangGraph agents. Copy `.env.example` → `.env`.
- **`apps/web/.env`** — Supabase keys and feature flags. Copy `apps/web/.env.example` → `apps/web/.env`.

See [README.md](../../README.md) for full setup details.

## Run

Terminal 1 — agents (LangGraph dev server, port 54367):

```bash
yarn workspace @opencanvas/agents dev
```

Terminal 2 — web app (Next.js):

```bash
yarn workspace @opencanvas/web dev
```

Open http://localhost:3000.

## Checks

```bash
yarn format:check
yarn lint
yarn build
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the PR checklist and commit conventions.
