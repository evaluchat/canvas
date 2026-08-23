# Contributing to Evaluchat

Thanks for your interest! Evaluchat is a small, independent open-source
project — a continuation of LangChain Open Canvas. Contributions are welcome.

## Ground rules

- **Open an issue first** for anything non-trivial (new feature, larger refactor,
  behaviour change) so we can agree on the direction before you invest the work.
- Small bug fixes and docs improvements are fine as direct PRs.
- This is a TypeScript monorepo with strict linting and formatting — the CI runs
  `format:check` and `lint` on every PR, so make sure they pass locally.
- Do not open a public issue for an undisclosed vulnerability — see
  [SECURITY.md](SECURITY.md).

## Issues and the project board

This project runs on a simple contract for what lives where:

- **Issues are the public record.** They hold two things only:
  - **Bug reports** — problems against the published code on `main`. Please
    include steps to reproduce, expected vs. actual behaviour, and your
    environment.
  - **Feature requests** — labelled `enhancement`; together they are the
    project's public roadmap, so please search before opening and add a 👍 to
    existing requests instead of duplicating them.
- **Internal project notes and tech debt are not issues.** They live on the
  [Evaluchat Board](https://github.com/users/evaluchat/projects/1) as draft
  items in Backlog.
- **The board is the state machine.** Columns: Backlog (accepted, not started)
  → Ready → In progress → In review → Done. Board status and issue state are
  independent: an issue stays open until the work ships, and issues are always
  closed with a reason (shipped, or not planned).
- When a PR delivers an open issue, reference it in the PR body (`Closes #22`)
  so it auto-closes on merge and the board tracks the link.

Not sure whether something belongs as an issue? Open it anyway — the
maintainers would rather re-home an item than miss a real report.

## Setup

```bash
git clone https://github.com/evaluchat/evaluchat.git
cd canvas
yarn install
```

Environment: copy `.env.example` → `.env` (root — model provider keys, loaded by
the LangGraph agents) and `apps/web/.env.example` → `apps/web/.env` (the web app:
Supabase keys for auth/persistence, model feature flags, optional transcription /
URL-scraping keys). See the README for details.

## Development

```bash
# agents (LangGraph dev server, port 54367)
yarn workspace @opencanvas/agents dev

# web app (Next.js dev server)
yarn workspace @opencanvas/web dev
```

## Checks (run before pushing)

```bash
yarn format:check   # prettier — all workspaces
yarn lint           # eslint
yarn build          # turbo build — full compile gate
```

If `format:check` complains, run `yarn format` (prettier auto-fix) on your changed
files only. Don't reformat unrelated files — it pollutes the PR.

## Commit conventions

- One logical change per commit; conventional-commit style prefixes (`feat:`, `fix:`,
  `docs:`, `refactor:`, `test:`) are used in this repo.
- Keep the diff focused. A reviewer (possibly the maintainer a year from now) should
  understand the change without a novel.

## PR checklist

- [ ] `yarn format:check` passes
- [ ] `yarn lint` passes
- [ ] `yarn build` passes
- [ ] New/changed behaviour is covered by a test where practical
- [ ] Description explains what and why, plus how it was tested

## Documentation routing

This repo holds **contributor dev docs only** (`docs/contributing/`, `docs/electron-desktop/`).

- **Product behavior, feature design, and platform security** → [evaluchat/knowledge](https://github.com/evaluchat/knowledge) (knowledge.evaluchat.org)
- **Research methodology governance** (review protocol, contribution ladder, evidence roles) → [evaluchat/research](https://github.com/evaluchat/research) (research.evaluchat.org)

Do not add ADRs, feature specs, marketing HTML, or orchestration plans under `docs/` in this repository.

## License

By contributing you agree that your contributions are licensed under the MIT License
(see [LICENSE](LICENSE)).
