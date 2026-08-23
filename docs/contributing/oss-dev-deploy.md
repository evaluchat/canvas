# Public OSS dev deployment

The public development environment is `https://dev.evaluchat.org`, served
from AlphaVPS `/opt/evaluchat-oss`. The repository contains the repeatable
application deploy command:

```bash
cd /home/cronjev/canvas-public
EVALUCHAT_TEMPLATE_SOURCE_ROOT=/home/cronjev/knowledge-dev/templates \
  yarn deploy:oss-dev
```

The command builds locally, generates the immutable public template catalog,
archives the current application on the VPS, uploads the package, atomically
switches the catalog, restarts agents before web, and checks:

- the agents `/ok` and assistant-search contracts;
- both systemd units and the deployed build/catalog checksums;
- public `/workspace` remains `307` while `/api/workspace/items` remains
  unauthenticated `401`.

Useful follow-up commands:

```bash
yarn deploy:oss-dev -- verify
yarn deploy:oss-dev -- rollback
yarn deploy:oss-dev -- catalog-rollback sha256:<catalog-revision>
```

The catalog revision is the `catalogRevision` field of `template-catalog.json` (also recorded as `catalog_revision` in `/opt/evaluchat-oss/.deploy-meta` and as a directory name under `/opt/evaluchat-catalog/releases/`).

Use `--skip-build` only when `apps/web/.next` is already the intended local
build. Use `--skip-catalog` only when the current VPS catalog is intentionally
being retained. The deploy env defaults to
`~/open-canvas/teaching-prototype/.env`; set `EVALUCHAT_DEPLOY_ENV_FILE` to
use another file. It must contain the AlphaVPS SSH settings and the remote
environment must already contain `EVALUCHAT_WORKSPACE_ASSISTANT_ID`.

The script does not perform Supabase auth migration, role-claim changes,
teaching-data changes, or production deployment. Those are separate reviewed
operations. The previous app archive is kept in
`/opt/evaluchat-oss/.rollbacks/`; catalog releases remain under
`/opt/evaluchat-catalog/releases/`.
