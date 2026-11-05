# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LakeMat Factory (factory.lakemat.com) is an internal app that tracks production: **roll received → cut → sewn (in-house or at Summit, an outside sewer) → inventory**. It replaces Katana MRP for inventory. See `README.md` for the product flow, roles table, and production setup.

Stack: React + Vite SPA (S3 + CloudFront) → Hono API (AWS Lambda behind the same CloudFront at `/api/*`) → Postgres via Drizzle (Neon in prod, Docker locally, PGlite in tests). Auth0 handles login. A Temporal worker (ECS Fargate + Temporal Cloud in prod) turns supplier invoice emails into registered rolls.

## Commands

```bash
docker compose up --build            # everything locally: db, temporal (UI :8233), localstack S3 :4566, api :8787, worker, web :5173 (needs LOCALSTACK_AUTH_TOKEN)
docker compose exec api npm run simulate -- hanes   # fake supplier email (GMAIL_MODE=fake)
npm run read-document -w api -- <file.pdf> "Supplier"   # what Claude reads from a document (one API call, needs ANTHROPIC_API_KEY)

npm test                             # API tests (vitest, real Postgres via in-process PGlite)
npm test -w api -- tests/flow.test.ts        # one file
npm test -w api -- -t "registers a roll"     # one test by name
                                     # tests/workflow.test.ts starts a local Temporal test server (downloads the CLI once)
npm run typecheck                    # all workspaces
npm run lint                         # eslint, whole repo
npm run build                        # api/dist/lambda.mjs + web/dist

npm run db:generate -w api           # after editing api/src/db/schema.ts; commit api/drizzle/*
npm run db:migrate -w api            # needs DATABASE_URL (compose runs this on api start)
scripts/deploy.sh staging|production # test, build, update Lambda, sync S3, invalidate
```

`PUBSUB_MODE=pull` (live Gmail locally) reads the Pub/Sub service-account key from `~/.config/lacey-factory/pubsub-sa.json`, mounted into the api container at `/run/google` (override with `GOOGLE_CREDENTIALS_DIR`/`GOOGLE_CREDENTIALS_FILE`; lakemat.com blocks key creation, so point them at `~/.config/gcloud/application_default_credentials.json` from `gcloud auth application-default login`).

Dev containers keep `node_modules` in anonymous volumes; `scripts/dev-entrypoint.sh` reinstalls on start when `package-lock.json` changed, so no `-V` is needed after adding packages.

There is one `.env` at the repo root (copy `.env.example`). Docker compose, the API scripts, and Vite (`envDir: ".."`) all read it.

## Layout

npm workspaces:
- **`api/`**: Hono app. `src/app.ts` defines every route. `src/server.ts` is the Node entry (compose), and `src/lambda.ts` is the Lambda entry, bundled by `build.mjs` with esbuild. `src/deps.ts` wires real dependencies for both. `src/worker.ts` is the Temporal worker entry (same package, separate process; `Dockerfile.worker` in prod).
- **`web/`**: Vite + React 19, react-router, and TanStack Query.
- **`shared/`**: imported as TS source (`@lacey-factory/shared/feet`, `@lacey-factory/shared/permissions`) by both api and web.

## Architecture

**API request path.** In `api/src/app.ts`, the auth middleware runs `authenticate()` from `src/auth.ts`, then `ensureUser()` from `src/domain/users.ts`, then sets `c.var.user` and `c.var.db`. The `need("<permission>")` middleware guards each write route. The handler parses the JSON body with `input(c, zodSchema)` and calls `src/domain/services.ts` for writes or `src/domain/queries.ts` for reads. Throw `UserError` (`src/domain/errors.ts`) for messages the user should see; `onError` maps it to a 400 `{ error }`. Write routes return `{ ok: "<message>" }` plus an `id` when something was created.

- `createApp(deps)` takes its dependencies (`getDb`, `authenticate`, `notifyMailbox`, `verifyPushToken`, `documentUrl`) as arguments. Tests pass PGlite and fakes, then call `app.request()`.
- Public routes (no app login) are listed in `PUBLIC_PATHS` in `app.ts`: health, the Google OAuth callback (authenticated by a one-time `oauth_states` row) and the Pub/Sub push webhook (Google OIDC token).
- **Services** take `(db, actor email, input)` and run in one transaction with `.for("update")` row locks, so concurrent floor users can't double-cut or double-sew.
- **Inventory is derived**, not stored: the count of non-voided `in_stock` pieces plus the sum of `inventory_adjustments`.
- Money uses `numeric(14,4)` and `shared/src/money.ts` (`sumMoney`/`mulMoney`, ten-thousandths of a dollar), the same way feet use `feet.ts`.
- Undo is a soft void (`voidedAt`/`voidedBy`), so queries must filter `voidedAt IS NULL`.
- `pieces` has one row per physical piece. Status flows `cut` → `at_summit` → `in_stock`, and pieces are picked **FIFO** by `cutOn`.
- Feet arithmetic must use `sumFeet`/`subtractFeet` from `shared/src/feet.ts`, which work in hundredths. Default dates use `todayInMichigan()`.
- `src/db/index.ts` uses node-postgres for both the compose DB and Neon. All code is typed against the generic `DB`/`Tx` in `src/db/types.ts`, so PGlite works in tests.
- The catalog seed (`src/db/catalog.ts` with `src/domain/catalog.ts`) is idempotent and never overwrites cut lengths.

**Auth and roles.**
- The SPA logs in with `@auth0/auth0-react` (refresh tokens, localStorage cache) and sends the access token as a Bearer header.
- The API verifies it with `jose` against Auth0's JWKS. Email, email_verified, and name come from custom claims under `https://factory.lakemat.com/`, which `auth0/post-login-action.js` adds.
- The sign-in rule lives in two places that must agree: `api/src/lib/access.ts` (verified `@lakemat.com` email or one in `ALLOWED_EMAILS`) and the Auth0 action.
- Roles are `admin | regular | factory` in the `users` table. New users are auto-created as `factory` on their first request. `ADMIN_EMAIL` (eric@lakemat.com) is always admin, only `factory`/`regular` can be assigned, and the admin's own role can't be changed.
- The permission table is in `shared/src/permissions.ts`. The API enforces it with `need()`. The web app calls `useCan()` only to hide UI. When you add a write route, choose its permission there.

**Supplier emails → rolls** (`api/src/email/`, `api/src/temporal/`, `api/src/domain/invoices.ts`).
- The admin connects eric@lakemat.com via Google OAuth (`gmail.readonly`); the refresh token is stored AES-GCM encrypted (`EMAIL_TOKEN_KEY`). `GMAIL_MODE=fake` replaces Gmail with JSON emails in `api/tmp/fake-inbox` (written by `scripts/simulate.ts`) and makes Connect instant.
- Gmail watch → Pub/Sub → `handleNotification` → `notifyMailbox` (signal-with-start). Workflows (ported from `../lacey-invoices-claude`): `mailboxWorkflow` holds the Gmail history cursor and starts one `processEmailWorkflow` per message (id `email-<account>-<messageId>`, REJECT_DUPLICATE); `renewWatchWorkflow` runs on the daily `renew-gmail-watch` schedule created by the worker.
- `processEmailWorkflow`: match supplier by sender (`suppliers.email_patterns`) → `archiveDocument` (S3, content-addressed key, `supplier_documents` row unique on message+sha) → `extractDocument` (Claude reads PDF/image into `DocumentExtraction`, `src/temporal/extract.ts`) → `handleDocument` dispatches on `suppliers.kind` via `src/temporal/handlers/index.ts`. Add a supplier type there (plus the enum value) without touching the workflow.
- The rolls handler: `planRolls` (pure) maps lines to `supplier_products` by code, then description; any unknown/ambiguous/size-mismatched line or unclear count → `needs_review`. `registerRolls` is one transaction, idempotent, marks a repeated invoice number `duplicate`, and links rolls via `rolls.source_document_id`. Humans register needs-review documents from the Inbox through the same function.
- The steel handler (`src/domain/steel.ts`): `planSteel` (pure) maps product lines to `supplier_steel_products`, requires per-piece UOM, qty × rate ≈ amount (a cent per pole) and lines adding up to `invoice_total`; freight lines become `supplier_documents.shipping_cost`. `receiveSteel` writes one `steel_lots` row per line with freight spread by dollar value (`allocateFreight`) into `landed_unit_cost`. Shares the duplicate/idempotency logic with rolls via `lockDocument`/`markRegistered` in `invoices.ts`.
- Workflow code (`src/temporal/workflows/`) runs in Temporal's sandbox: import only `names.ts`, types and `@temporalio/workflow` there. All I/O goes in `activities.ts`, built by `createActivities({ db, mail, reader, store })` so tests inject fakes.

**Steel and sales** (`api/src/domain/steel.ts`, `api/src/domain/sales.ts`).
- Steel on hand = sum of `steel_lots.qty_remaining` minus unfilled shortage rows. Lots are FIFO cost layers (invoice lines, opening balances, count corrections); `steel_usage` records every pole taken, by lot.
- `recordSale` is the single entry point for every sales channel (only `manual` exists today; integrations pass `source` + `externalRef`, which is unique, so a re-sent order returns the first sale). It takes `product_steel` poles oldest lot first and `product_components` pieces oldest `cutOn` first (status `sold`, `pieces.sale_id`), falling back to a negative `sale` adjustment when pieces run out. It never refuses for lack of stock: missing steel becomes a usage row with no lot (sale `short`), filled in by `settleShortages` when the next lot arrives, which also corrects the sale's `steel_cost`.
- `voidSale` returns poles to their lots, pieces to `in_stock`, and deletes its adjustments. Undoing a cut, sewing batch or Summit receipt is refused while any of its pieces are `sold`.

**Local dev auth bypass.**
- `DEV_AUTH_EMAIL` (API, only when `NODE_ENV=development`) together with `VITE_DEV_AUTH=true` (web) skips Auth0.
- An `x-dev-email` header, set by the "dev as" box in the nav, switches the user so you can test roles.
- `lambda.ts` refuses to start if `DEV_AUTH_EMAIL` is set.

**Web data flow.**
- `web/src/api.ts` builds a typed Hono RPC client from `AppType`. That's why `web/tsconfig.json` includes `node` types: it type-checks API sources.
- Reads use `useApi("<name>")` or `useRoll(id)`.
- Writes go through `ActionForm`/`useSubmit` (`web/src/components/action-form.tsx`). It posts `Object.fromEntries(FormData)` as JSON to `post(path)`/`patch(path)`, shows `{ ok | error }`, and invalidates all queries on success. API schemas therefore coerce string form values (numbers, checkboxes as `"on"`).
- `web/src/app.tsx` holds the routes. `Layout` loads `/api/me` before rendering any page, and a 403 there shows the "No access" page.

## Related
- AWS infra (S3, CloudFront, Lambda, Route 53) belongs in `../terraform-lacey-factory`. That repo still points DNS at Vercel and needs updating for this architecture.
- The parent `../CLAUDE.md` covers the separate ecommerce storefront and Strapi CMS.
