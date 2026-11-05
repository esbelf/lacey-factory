# LakeMat Factory — factory.lakemat.com

Internal app that tracks production: **roll received → cut → sewn (in-house or Summit) → inventory**.
Replaces Katana MRP for inventory. Also tracks steel poles (bought by emailed invoice, costed FIFO with freight) and
product sales, which take out each product's steel and fabric. Sales are entered by hand for now; Shopify, Amazon and
other channels will call the same `recordSale` later.

Stack: React + Vite (S3 + CloudFront) · Hono API (AWS Lambda) · Temporal worker (ECS Fargate + Temporal Cloud) · Postgres + Drizzle (Neon in production, Docker locally) · Auth0.

```
Browser ──> CloudFront ──┬── /*      → S3 (React app)
                         └── /api/*  → Lambda (Hono) ──> Neon Postgres
Gmail (eric@) ─watch─> Pub/Sub ─push─> /api/webhooks/gmail ─signal─> Temporal Cloud ─> ECS worker
                                                                     (Gmail · S3 documents · Claude · Neon)
```

## How it works
- **Rolls** (`/rolls`): register a roll (supplier roll # + auto code `R-0001`). Record cuts in as many sessions as you like; each size has a **fixed cut length** (Settings), and the app rejects a cut that needs more than what's left. Close out a roll with the measured leftover to see cutting drift.
- **To sew** (`/cut`): cut pieces by material + size. Mark sewn in-house (→ inventory) or send to Summit. Oldest pieces go first.
- **Summit** (`/summit`): "received 25 × 12x24" → the 25 oldest sent pieces move to inventory (FIFO).
- **Inventory** (`/inventory`): on hand per sewn material + size (LakeMat and MuckMat share the same sewn piece). Adjustments for opening balance / counts.
- Non-sewn materials (geogrid) go straight to inventory when cut.
- Every entry records who did it; cuts, sewing, shipments and receipts can be undone.
- **Supplier invoices** (`/inbox`): when an email from a known supplier arrives at eric@lakemat.com, each PDF/photo attachment is saved to S3 and read by Claude. If every line maps to a supplier product (Settings → **Suppliers**, e.g. Hanes `38151` = TerraTex N06 12.5′×360′), the rolls are registered automatically — one per ticket number, dated by ship date, else document date, else the email's day. Anything unclear (unknown product, unreadable, size mismatch) waits in the Inbox with the lines pre-filled for a regular worker or the admin to fix and register. The same invoice number is never registered twice. The admin connects the mailbox with the **Connect Email** button in the header.
- **Orders** (`/orders`): Amazon orders from the US and Canada, polled every 15 minutes. A paid order (Amazon status Unshipped or later) records a sale for each line, which takes the product's steel and fabric out of inventory; `Pending` orders wait; a cancel undoes the sale. Each Amazon SKU is linked to a product under Settings → **Amazon SKUs** (with "per unit" for multi-packs). Orders with an unknown SKU, or a product without a recipe, show under **Needs attention** and are recorded once fixed. Every field Amazon sends is kept and shown on the order page; amounts stay in the order's currency (CAD for Canada).
- **Catalog** (Settings → *Load LakeMat catalog*): adds TerraTex N06, TerraGrid RX1100, TerraTex HD NTPEP, TerraTex HPG-57, their cut sizes, which pieces each product uses, and Hanes Geo Components as a roll supplier (`api/src/db/catalog.ts`; add Hanes's sender addresses under Suppliers). Only adds what's missing. Sizes arrive **switched off** at their finished length; enter the real cut length (with hem allowance) and turn each one on before cutting.

## Users and roles
| | Factory worker | Regular worker | Admin |
|---|:-:|:-:|:-:|
| Register rolls, record cuts, mark sewn, Summit send/receive, view everything | ✓ | ✓ | ✓ |
| Settings (materials, sizes, catalog, suppliers), adjust inventory, close/reopen rolls, undo | | ✓ | ✓ |
| **Inbox**: review supplier invoices and register their rolls | | ✓ | ✓ |
| **Orders**: Amazon orders, link SKUs to products, Sync now | | ✓ | ✓ |
| **Users** dashboard (change roles), **Connect Email** | | | ✓ |

- Everyone who passes the sign-in rule gets a user record the first time they sign in, **always as a factory worker**. The admin promotes people on the **Users** page.
- The admin is always `eric@lakemat.com` (`ADMIN_EMAIL` in `shared/src/permissions.ts`). Nobody else can be made admin, and the admin's role can't be changed.
- Sign-in rule (checked by Auth0 **and** the API): verified `@lakemat.com` email, or a verified email in `ALLOWED_EMAILS`.

## Run locally
```bash
cp .env.example .env               # put your LOCALSTACK_AUTH_TOKEN in it (free account at localstack.cloud)
docker compose up --build          # Postgres, Temporal (UI :8233), LocalStack S3 (:4566), API (:8787), worker, web (:5173)
```
Stored documents are in LocalStack: `aws --endpoint-url http://localhost:4566 s3 ls s3://lacey-factory-documents-local/ --recursive` (any credentials, e.g. `AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test`).
Open http://localhost:5173. With the default `.env`, Auth0 is skipped and you're `eric@lakemat.com` (admin). Type another email into the **dev as** box in the header to act as someone else (new emails start as factory workers).

Try the supplier-invoice flow without Google: open the app, click **Connect Email** (instant in fake mode), set Hanes's *Sends from* to `@hanesgeo.com` under Settings → Suppliers after loading the catalog, then:
```bash
docker compose exec api npm run simulate -- hanes            # Hanes packing list photo
docker compose exec api npm run simulate -- --file /app/api/fixtures/<file> --from billing@hanesgeo.com
```
With `ANTHROPIC_API_KEY` set in `.env`, the 4 rolls are registered automatically; without it the document lands in the Inbox for review. Workflows are visible in the Temporal UI at http://localhost:8233.

Try Amazon orders without Amazon: set `AMAZON_MODE=fake` in `.env`, restart, load the catalog, link `LM-XL` to a product under Settings → Amazon SKUs, then:
```bash
docker compose exec api npm run simulate:amazon -- us        # paid US order; also: ca, multi, bundle, pending, unknown-sku
docker compose exec api npm run simulate:amazon -- cancel    # the last order is canceled (also: pay, ship)
```
Each command starts a sync; watch it in the Temporal UI and on the Orders page. With real keys, `AMAZON_MODE=sandbox` syncs Amazon's sample order and `live` reads real orders (read-only).

Containers reinstall dependencies on start when `package-lock.json` changed (`scripts/dev-entrypoint.sh`), so a plain `docker compose up --build` picks up new packages.

Checks (run on the host after `npm install`): `npm test` (API tests on in-process Postgres) · `npm run typecheck` · `npm run lint`.

## Schema changes
Edit `api/src/db/schema.ts` → `npm run db:generate -w api` → commit the new file in `api/drizzle/`. Docker compose applies migrations when the API starts; for production run `DATABASE_URL=<neon url> npm run db:migrate -w api`.

## Production setup (one time)
1. **Neon**: create a project and copy the pooled connection string. Run the migrations against it (above).
2. **Auth0**
   - **APIs** → create *Lacey Factory API*, identifier `https://factory.lakemat.com/api` (RS256).
   - **Applications** → create a *Single Page Application* "Lacey Factory".
     - Allowed Callback URLs, Logout URLs and Web Origins: `https://factory.lakemat.com, https://staging.factory.lakemat.com, http://localhost:5173`
     - Refresh Token Rotation: on. Grant the app access to the API above.
     - Connections: **Google** (lakemat.com Workspace) + **Username-Password** with *Disable Sign Ups* on (create crew accounts by hand).
   - **Actions → Post Login**: paste `auth0/post-login-action.js`; secrets `FACTORY_CLIENT_ID` (the SPA's client ID) and `ALLOWED_EMAILS`. Add it to the Login flow. It also puts email/name into the access token for the API.
3. **AWS** (Terraform in `../terraform-lacey-factory`, account 493424762573):
   - S3 bucket (private) for `web/dist`, served through CloudFront with Origin Access Control. A viewer-request CloudFront Function rewrites non-file paths to `/index.html` for client-side routing (don't use custom error responses — they would also rewrite API errors).
   - Lambda (Node 22, handler `lambda.handler`) with a Function URL as a second CloudFront origin for `/api/*` (caching disabled, forward `Authorization`). Env vars: `DATABASE_URL`, `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `ALLOWED_EMAILS`, `NODE_ENV=production`. **Never** set `DEV_AUTH_EMAIL` (the handler refuses to start with it).
   - Route 53 alias `factory.lakemat.com` (and `staging.factory.lakemat.com`) → the distribution, with an ACM certificate in us-east-1.
4. **Supplier emails**
   - **Google Cloud** (lakemat.com Workspace): enable the Gmail and Pub/Sub APIs. OAuth consent screen audience **Internal** (refresh tokens don't expire weekly), scope `gmail.readonly`. Create a *Web application* OAuth client with redirect URI `https://factory.lakemat.com/api/email/callback` (and `http://localhost:8787/api/email/callback` for local live mode). Create a Pub/Sub topic, give `gmail-api-push@system.gserviceaccount.com` *Pub/Sub Publisher* on it, and a **push** subscription to `https://factory.lakemat.com/api/webhooks/gmail` with OIDC authentication (audience = that URL).
   - **Temporal Cloud**: create a namespace and an API key.
   - **AWS**: a private S3 bucket for documents; an ECS Fargate service running `Dockerfile.worker` (0.25 vCPU / 512 MB is plenty) with S3 read/write on the bucket.
   - **Env** — Lambda: add `GMAIL_MODE=live`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `APP_BASE_URL=https://factory.lakemat.com`, `GMAIL_PUBSUB_TOPIC`, `PUBSUB_MODE=push`, `PUBSUB_PUSH_AUDIENCE`, `EMAIL_TOKEN_KEY`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, `DOCUMENTS_BUCKET` (and S3 read on the bucket for "View document" links). Worker: the same minus the Pub/Sub push ones, plus `DATABASE_URL` and `ANTHROPIC_API_KEY`. Keep secrets in Secrets Manager.
   - Then sign in as eric@lakemat.com and click **Connect Email**. The worker renews the Gmail watch daily (`renew-gmail-watch` schedule).
5. **Deploy**: copy `deploy/example.env` to `deploy/<env>.env`, then `scripts/deploy.sh staging` (or `production`). It runs the tests, builds, updates the Lambda code, syncs the site to S3 and invalidates `index.html`.
