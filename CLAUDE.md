# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LakeMat Factory (factory.lakemat.com) is an internal app that tracks production: **roll received → cut → sewn (in-house or at Summit, an outside sewer) → inventory**. It replaces Katana MRP for inventory. See `README.md` for the product flow, roles table, and production setup.

Stack: React + Vite SPA (S3 + CloudFront) → Hono API (AWS Lambda behind the same CloudFront at `/api/*`) → Postgres via Drizzle (Neon in prod, Docker locally, PGlite in tests). Auth0 handles login. A Temporal worker (ECS Fargate + Temporal Cloud in prod) turns supplier invoice emails into registered rolls.

## Commands

```bash
docker compose up --build            # everything locally: db, temporal (UI :8233), localstack S3 :4566 (LOCALSTACK_PORT), api :8787, worker, web :5173 (needs LOCALSTACK_AUTH_TOKEN)
docker compose exec api npm run simulate -- hanes   # fake supplier email (GMAIL_MODE=fake)
docker compose exec api npm run simulate:amazon -- us   # fake Amazon order + sync (AMAZON_MODE=fake); ca, pending, cancel, unknown-sku…
docker compose exec api npm run simulate:shopify -- mi  # fake Shopify order + signed webhook (SHOPIFY_MODE=fake); repeat, guest, on, bc, pending, pay, refund…
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
# Deploys run in GitHub Actions: push to main → staging; Actions → Deploy → production.
scripts/deploy.sh staging|production # what CI runs: build, migrate, Lambda, worker image → ECS, S3 + invalidate
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
- Public routes (no app login) are listed in `PUBLIC_PATHS` in `app.ts`: health, the Google OAuth callback (authenticated by a one-time `oauth_states` row), the Pub/Sub push webhook (Google OIDC token) and the Shopify webhook (HMAC of the raw body with `SHOPIFY_CLIENT_SECRET`).
- **Services** take `(db, actor email, input)` and run in one transaction with `.for("update")` row locks, so concurrent floor users can't double-cut or double-sew.
- **Inventory is derived**, not stored: the count of non-voided `in_stock` pieces plus the sum of `inventory_adjustments`.
- Money uses `numeric(14,4)` and `shared/src/money.ts` (`sumMoney`/`mulMoney`, ten-thousandths of a dollar), the same way feet use `feet.ts`.
- Undo is a soft void (`voidedAt`/`voidedBy`), so queries must filter `voidedAt IS NULL`.
- `pieces` has one row per physical piece. Status flows `cut` → `at_summit` → `in_stock`, and pieces are picked **FIFO** by `cutOn`.
- Sewing is decided per cut size (`cut_sizes.requires_sewing`), not per material: N06 LakeMat sizes are sewn, N06 SandMat sizes aren't. Unsewn sizes are cut straight to `in_stock` with `sewn_by = not_sewn`. `materials.requires_sewing` is only the default for a material's new sizes.
- Feet arithmetic must use `sumFeet`/`subtractFeet` from `shared/src/feet.ts`, which work in hundredths. Default dates use `todayInMichigan()`.
- `src/db/index.ts` uses node-postgres for both the compose DB and Neon. All code is typed against the generic `DB`/`Tx` in `src/db/types.ts`, so PGlite works in tests.
- The catalog seed (`src/db/catalog.ts` with `src/domain/catalog.ts`) is idempotent and never overwrites cut lengths.

**Auth and roles.**
- The SPA logs in with `@auth0/auth0-react` (refresh tokens, localStorage cache) and sends the access token as a Bearer header.
- The API verifies it with `jose` against Auth0's JWKS. Email, email_verified, and name come from custom claims under `https://factory.lakemat.com/`, which the Auth0 post-login action adds (`../terraform-lacey-factory/auth0/post-login-action.js`).
- The sign-in rule lives in two places that must agree: `api/src/lib/access.ts` (verified `@lakemat.com` email or one in `ALLOWED_EMAILS`) and the Auth0 action. Terraform passes one `allowed_emails` value to both.
- Roles are `admin | regular | factory` in the `users` table. New users are auto-created as `factory` on their first request. `ADMIN_EMAIL` (eric@lakemat.com) is always admin, only `factory`/`regular` can be assigned, and the admin's own role can't be changed.
- The permission table is in `shared/src/permissions.ts`. The API enforces it with `need()`. The web app calls `useCan()` only to hide UI. When you add a write route, choose its permission there.

**Supplier emails → rolls** (`api/src/email/`, `api/src/temporal/`, `api/src/domain/invoices.ts`).
- The admin connects eric@lakemat.com via Google OAuth (`gmail.readonly`); the refresh token is stored AES-GCM encrypted (`EMAIL_TOKEN_KEY`). `GMAIL_MODE=fake` replaces Gmail with JSON emails in `api/tmp/fake-inbox` (written by `scripts/simulate.ts`) and makes Connect instant.
- Gmail watch → Pub/Sub → `handleNotification` → `notifyMailbox` (signal-with-start). Workflows (ported from `../lacey-invoices-claude`): `mailboxWorkflow` holds the Gmail history cursor and starts one `processEmailWorkflow` per message (id `email-<account>-<messageId>`, REJECT_DUPLICATE); `renewWatchWorkflow` runs on the daily `renew-gmail-watch` schedule created by the worker.
- `processEmailWorkflow`: match supplier by sender (`suppliers.email_patterns`) → `archiveDocument` (S3, content-addressed key, `supplier_documents` row unique on message+sha) → `extractDocument` (Claude reads PDF/image into `DocumentExtraction`, `src/temporal/extract.ts`) → `handleDocument` dispatches on `suppliers.kind` via `src/temporal/handlers/index.ts`. Add a supplier type there (plus the enum value) without touching the workflow.
- The rolls handler: `planRolls` (pure) maps lines to `supplier_products` by code, then description; any unknown/ambiguous/size-mismatched line or unclear count → `needs_review`. `registerRolls` is one transaction, idempotent, marks a repeated invoice number `duplicate`, and links rolls via `rolls.source_document_id`. Humans register needs-review documents from the Inbox through the same function.
- The steel handler (`src/domain/steel.ts`): `planSteel` (pure) maps product lines to `supplier_steel_products`, requires per-piece UOM, qty × rate ≈ amount (a cent per pole) and lines adding up to `invoice_total`; freight lines become `supplier_documents.shipping_cost`. `receiveSteel` writes one `steel_lots` row per line with freight spread by dollar value (`allocateFreight`) into `landed_unit_cost`. Shares the duplicate/idempotency logic with rolls via `lockDocument`/`markRegistered` in `invoices.ts`.
- Workflow code (`src/temporal/workflows/`) runs in Temporal's sandbox: import only `names.ts`, types and `@temporalio/workflow` there. All I/O goes in `activities.ts`, built by `createActivities({ db, mail, reader, store })` so tests inject fakes.

**Steel, boxes and sales** (`api/src/domain/steel.ts`, `api/src/domain/sales.ts`).
- `steel_items` holds every part stocked by the piece at FIFO cost, by `kind`: `steel` poles and shipping `box`es (with `length_in`/`width_in`/`height_in`). Both share `steel_lots`, `steel_usage`, `adjustSteel` and `product_steel`; a product's box is its one `product_steel` row whose item is a box (`setProductBox` replaces it, `setProductSteel` refuses boxes). `refreshSaleCost` splits usage into `sales.steel_cost` and `sales.box_cost`. A product with only a box counts as having no recipe, so it can't be sold until its fabric/steel is set.
- Fabric and sewing COGS (`src/domain/cogs.ts`): `rolls.cost` is the whole roll with its freight share (from the invoice line via `rollCosts`, or set on the roll page). A sold piece costs `cut_length_ft × cost ÷ roll length_ft` (unused width counts as that piece's scrap); pieces go out oldest first, so it's FIFO. Pieces a sale was short of are estimated from the newest priced roll of that material. `refreshFabricCost` sets `sales.fabric_cost`/`fabric_cost_missing`; `setRollCost` re-costs sales from that roll and any still missing a price. Sewing uses the product's `sew_cost_in_house`/`sew_cost_summit` (per product) weighted by how the sale's pieces were sewn, fixed at sale time in `sales.sewing_cost`/`sewing_cost_missing`. COGS = steel + box + fabric + sewing.
- The catalog (`CATALOG_BOXES`, `CATALOG_SHIPPING`, `CATALOG_PRODUCTS_WITHOUT_RECIPE` in `src/db/catalog.ts`) adds the 12 boxes and gives each product its own SKU (`products.sku`, not the Amazon SKU), box and packed weight (`ship_weight_lb`), only where still empty.
- Steel on hand = sum of `steel_lots.qty_remaining` minus unfilled shortage rows. Lots are FIFO cost layers (invoice lines, opening balances, count corrections); `steel_usage` records every pole taken, by lot.
- `recordSale` is the single entry point for every sales channel (only `manual` exists today; integrations pass `source` + `externalRef`, which is unique, so a re-sent order returns the first sale). It takes `product_steel` poles oldest lot first and `product_components` pieces oldest `cutOn` first (status `sold`, `pieces.sale_id`), falling back to a negative `sale` adjustment when pieces run out. It never refuses for lack of stock: missing steel becomes a usage row with no lot (sale `short`), filled in by `settleShortages` when the next lot arrives, which also corrects the sale's `steel_cost`.
- `voidSale` returns poles to their lots, pieces to `in_stock`, and deletes its adjustments. Undoing a cut, sewing batch or Summit receipt is refused while any of its pieces are `sold`.

**Amazon orders** (`api/src/amazon/`, `api/src/domain/orders.ts`, `temporal/workflows/amazon-sync.ts`).
- `amazonSyncWorkflow` runs on the `amazon-order-sync` schedule (every `AMAZON_SYNC_EVERY`, created/updated/removed by the worker per `AMAZON_MODE`) or from "Sync now" (workflow id `amazon-sync-now`). Steps: `amazonSyncBegin` (cursor − 5 min overlap, never later than now − 2 min, as SP-API requires) → `amazonSyncPage` per NextToken page (fetches items only for orders whose `LastUpdateDate` changed; `saveOrder` + `applyOrder`) → `amazonSyncEnd` (retries waiting lines, moves `channel_sync.cursor`). Failures land in `channel_sync.last_error` for the Orders page.
- `OrderSource` is `LiveOrderSource` (`sp-api.ts`: LWA refresh-token exchange + Orders v0, sandbox or live NA host; the sandbox only answers `CreatedAfter=TEST_CASE_200`) or `FakeOrderSource` (SP-API-shaped JSON files in `AMAZON_FAKE_DIR`, written by `scripts/simulate-amazon.ts` from `amazon/fake-orders.ts`). `SpApiError.retryable` (429/5xx) decides Temporal retries.
- `orders` / `order_items` are channel-neutral (`source`), keep the channel's JSON in `raw`, and an older copy never overwrites a newer one. `applyOrder` is idempotent: paid statuses (Unshipped/PartiallyShipped/Shipped/InvoiceUnconfirmed) → `recordSale` with `externalRef = amazon:<orderId>:<orderItemId>` and qty × `channel_skus.qty_per_unit`; Pending → `waiting`; Canceled/Unfulfillable → `voidSale`. Unknown SKU → `needs_mapping`, recipe-less product (`recordSale`'s UserError) → `needs_recipe`; `mapSku` and recipe changes call `retryProblems`. Channel sales can't be undone from Inventory.

**Shopify orders and customers** (`api/src/shopify/`, `api/src/domain/customers.ts`, `temporal/workflows/shopify-*.ts`).
- Webhooks are the main path. `POST /api/webhooks/shopify` verifies the HMAC and shop domain, records `channel_sync.last_event_at`, and calls `notifyShopifyOrder`, which starts `shopifyOrderWorkflow` with id `shopify-order-<orderId>-<webhookId>` (REJECT_DUPLICATE, so redeliveries are dropped). The workflow fetches the order's current state over GraphQL (`ShopifyAdmin.getOrder`, client-credentials token) and calls `ingestOrder`, so the webhook body itself is only used for the order id.
- `ingestOrder` saves an order we haven't seen only once it's paid (`wantedState("shopify", …)`: PAID, PARTIALLY_PAID, PARTIALLY_REFUNDED). A saved order is always updated, so REFUNDED, VOIDED or `cancelledAt` void its sales through `applyOrder`, same as Amazon.
- "Pull orders" (`shopifyPullWorkflow`, id `shopify-pull-now`, no schedule) pages `orders(query: "updated_at:>…")` from a date, or the last pull's cursor minus 5 minutes. The worker's `ensureShopifyWebhooks` subscribes `SHOPIFY_WEBHOOK_URL` to the order topics on start (live mode).
- `normalizeShopifyOrder` uses `shopMoney` (the store's currency) for the money columns: `subtotal`, `discount_total`, `shipping_charged` (paid by the customer; the real cost comes from ShipStation later), `tax_total`, and `tax_lines` (one per tax, e.g. Michigan 6%, HST 13%). Addresses are jsonb (`shipping_address`, `billing_address`); `ship_city/state/country` stay filled for filtering.
- `saveOrder` links each order to a `customers` row through `matchCustomer` (in the same transaction): `customer_links` (channel customer id) first, then lowercased email, else a new customer. Emails are unique among customers. Order counts, first/last order and spend are derived from `orders`, not stored. Amazon orders have no customer.

**Local dev auth bypass.**
- `DEV_AUTH_EMAIL` (API, only when `NODE_ENV=development`) together with `VITE_DEV_AUTH=true` (web) skips Auth0.
- An `x-dev-email` header, set by the "dev as" box in the nav, switches the user so you can test roles.
- `lambda.ts` refuses to start if `DEV_AUTH_EMAIL` is set. On cold start it loads secrets from Secrets Manager (`APP_SECRETS_ARN`, `lambda-env.ts`), and it answers 403 to requests without CloudFront's `x-origin-verify` header (`ORIGIN_VERIFY_SECRET`).

**Web data flow.**
- `web/src/api.ts` builds a typed Hono RPC client from `AppType`. That's why `web/tsconfig.json` includes `node` types: it type-checks API sources.
- Reads use `useApi("<name>")` or `useRoll(id)`.
- Writes go through `ActionForm`/`useSubmit` (`web/src/components/action-form.tsx`). It posts `Object.fromEntries(FormData)` as JSON to `post(path)`/`patch(path)`, shows `{ ok | error }`, and invalidates all queries on success. API schemas therefore coerce string form values (numbers, checkboxes as `"on"`).
- `web/src/app.tsx` holds the routes. `Layout` loads `/api/me` before rendering any page, and a 403 there shows the "No access" page.

## Related
- Neon (one project per environment; `DATABASE_URL` is written into the app secret) is in `../terraform-lacey-factory/neon.tf`.
- Auth0 (one tenant per environment: API, SPA, connections, post-login action) is in `../terraform-lacey-factory/auth0.tf`.
- AWS infra (CloudFront, S3, Lambda, the ECS worker, ECR, Secrets Manager, Route 53, the GitHub deploy role) is in `../terraform-lacey-factory`, one workspace each for staging and production. Non-secret Lambda/worker env vars are set there (`local.app_env`), so a new env var the app needs in production must be added there too (or to the secret's keys).
- The parent `../CLAUDE.md` covers the separate ecommerce storefront and Strapi CMS.
