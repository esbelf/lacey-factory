# LakeMat Factory — factory.lakemat.com

Internal app that tracks production: **roll received → cut → sewn (in-house or Summit) → inventory**.
Replaces Katana MRP for inventory. Also tracks steel poles (bought by emailed invoice, costed FIFO with freight) and
product sales, which take out each product's steel and fabric. Sales come from Amazon and Shopify orders, or are
entered by hand; every channel calls the same `recordSale`.

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
- Sizes that aren't sewn (geogrid, and SandMat sizes on N06) go straight to inventory when cut. Each cut size has its own "Gets sewn" setting in Settings; a material's setting is only the default for its new sizes.
- Every entry records who did it; cuts, sewing, shipments and receipts can be undone.
- **Supplier invoices** (`/inbox`): when an email from a known supplier arrives at eric@lakemat.com, each PDF/photo attachment is saved to S3 and read by Claude. If every line maps to a supplier product (Settings → **Suppliers**, e.g. Hanes `38151` = TerraTex N06 12.5′×360′), the rolls are registered automatically — one per ticket number, dated by ship date, else document date, else the email's day. Anything unclear (unknown product, unreadable, size mismatch) waits in the Inbox with the lines pre-filled for a regular worker or the admin to fix and register. The same invoice number is never registered twice. The admin connects the mailbox with the **Connect Email** button in the header.
- **Boxes**: every product ships in one shipping box (Settings → Products → *Ships in*). Boxes are stocked like steel, at FIFO cost (Inventory → Shipping boxes, *Adjust steel & boxes*), and a sale takes one box per product, recording its box cost next to its steel cost.
- **Cost of goods sold**: each sale records steel, box, fabric and sewing cost. A roll's price (whole roll, freight included) comes from its invoice or is entered on the roll page; a piece costs its cut length × the roll's price per foot, and sales use the oldest pieces first (FIFO). Sewing is charged per product at its in-house or Summit rate (Settings → Products), by who sewed the pieces it used. Sales show *some costs not set* until the roll price or sewing rate is filled in. The catalog loads the 12 standard boxes with their sizes, plus each product's own SKU and packed weight.
- **Orders** (`/orders`): Amazon orders from the US and Canada, polled every 15 minutes. A paid order (Amazon status Unshipped or later) records a sale for each line, which takes the product's steel and fabric out of inventory; `Pending` orders wait; a cancel undoes the sale. Each Amazon SKU is linked to a product under Settings → **Amazon SKUs** (with "per unit" for multi-packs). Orders with an unknown SKU, or a product without a recipe, show under **Needs attention** and are recorded once fixed. Every field Amazon sends is kept and shown on the order page; amounts stay in the order's currency (CAD for Canada).
- **Shopify orders** (also `/orders`): the US store (`lakemat-2.myshopify.com`, which also sells to Canada) sends each order by webhook as it's paid, updated or canceled. Only paid orders are saved; a refund or cancel undoes the sale. Each order keeps the customer, shipping and billing addresses, items, discounts, the shipping the customer paid, and every tax line (Michigan sales tax, GST/HST/PST). **Pull orders** reads everything since a date, for the first import or after an outage. Shopify SKUs are linked the same way as Amazon's. The real shipping cost will come from ShipStation later.
- **Customers** (`/customers`): everyone who ordered from Shopify, with their orders, first and last order date, and total spent. A repeat buyer is one customer: orders match by Shopify customer id, then by email (any capitals, guest checkouts included).
- **Catalog** (Settings → *Load LakeMat catalog*): adds TerraTex N06, TerraGrid RX1100, TerraTex HD NTPEP, TerraTex HPG-57, their cut sizes, which pieces each product uses, and Hanes Geo Components as a roll supplier (`api/src/db/catalog.ts`; add Hanes's sender addresses under Suppliers). Only adds what's missing. Sizes arrive **switched off** at their finished length; enter the real cut length (with hem allowance) and turn each one on before cutting.

## Users and roles
| | Factory worker | Regular worker | Admin |
|---|:-:|:-:|:-:|
| Register rolls, record cuts, mark sewn, Summit send/receive, view everything | ✓ | ✓ | ✓ |
| Settings (materials, sizes, catalog, suppliers), adjust inventory, close/reopen rolls, undo | | ✓ | ✓ |
| **Inbox**: review supplier invoices and register their rolls | | ✓ | ✓ |
| **Orders** and **Customers**: Amazon and Shopify orders, customers, link SKUs to products, Sync now / Pull orders | | ✓ | ✓ |
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

Try Shopify orders without Shopify: set `SHOPIFY_MODE=fake` and any `SHOPIFY_CLIENT_SECRET` in `.env`, restart, link `LM-XL` (channel Shopify) under Settings, then:
```bash
docker compose exec api npm run simulate:shopify -- repeat   # Pat orders twice: one customer, two orders
docker compose exec api npm run simulate:shopify -- on       # Ontario order with 13% HST; also: mi, oh, bc, guest, pending, unknown-sku
docker compose exec api npm run simulate:shopify -- refund   # the last order is refunded (also: pay, cancel)
```
Each command writes the order and sends the signed webhook Shopify would send, so it shows up on the Orders page without clicking anything.

Going live with Shopify:
1. In the Shopify Dev Dashboard app for the US store, add the scopes `read_orders`, `read_customers` and `read_all_orders`. Request **protected customer data** access for name, email, phone and address; without it those fields come back empty.
2. Set `shopify_mode = "live"` and `shopify_client_id` in the terraform repo's `production.tfvars` (it sets `SHOPIFY_WEBHOOK_URL` itself), and `SHOPIFY_CLIENT_SECRET` in the app secret.
3. Restart the worker: it subscribes the webhooks (and puts back any Shopify dropped).
4. Click **Pull orders** with a start date to import past orders.

Containers reinstall dependencies on start when `package-lock.json` changed (`scripts/dev-entrypoint.sh`), so a plain `docker compose up --build` picks up new packages.

Checks (run on the host after `npm install`): `npm test` (API tests on in-process Postgres) · `npm run typecheck` · `npm run lint`.

## Schema changes
Edit `api/src/db/schema.ts` → `npm run db:generate -w api` → commit the new file in `api/drizzle/`. Docker compose applies migrations when the API starts; staging and production get them from the deploy (below).

## Production setup (one time)
1. **Neon**: one project per environment (`lacey-factory-staging`, `lacey-factory-production`), created by Terraform in `../terraform-lacey-factory` (`neon.tf`), which also writes the pooled connection string into the app secret as `DATABASE_URL`. The deploy runs the migrations.
2. **Auth0**: one tenant per environment (staging and production), configured by Terraform in `../terraform-lacey-factory` (`auth0.tf`): the API `https://factory.lakemat.com/api`, the SPA, Google and `crew` (email + password, no sign-ups) connections, and the post-login action `auth0/post-login-action.js` there, which allows only `@lakemat.com` or `ALLOWED_EMAILS` and puts email/name into the access token for the API. Creating each tenant and its "Terraform" M2M app is a one-time step in its README. Crew accounts are created by hand (Users → Create user, connection `crew`). Local dev signs in against the staging tenant.
3. **AWS**: everything (CloudFront, the API Lambda, the worker on ECS Fargate, buckets, DNS, certificate, the Secrets Manager secret and the GitHub deploy role) is Terraform in `../terraform-lacey-factory`; follow its README. Settings that aren't secret are in its `environments/<env>.tfvars`; secrets (`DATABASE_URL`, API keys) go in the `lacey-factory-<env>/app` secret, which the Lambda loads on cold start and ECS passes to the worker. The Lambda only answers requests that came through CloudFront (`x-origin-verify` header). **Never** set `DEV_AUTH_EMAIL` there (the handler refuses to start with it).
4. **Supplier emails**
   - **Google Cloud** (lakemat.com Workspace): enable the Gmail and Pub/Sub APIs. OAuth consent screen audience **Internal** (refresh tokens don't expire weekly), scope `gmail.readonly`. Create a *Web application* OAuth client with redirect URIs `https://factory.lakemat.com/api/email/callback` and `http://localhost:8787/api/email/callback` (local live mode). Create a Pub/Sub topic, give `gmail-api-push@system.gserviceaccount.com` *Pub/Sub Publisher* on it, and a **push** subscription to `https://factory.lakemat.com/api/webhooks/gmail` with OIDC authentication (audience = that URL).
   - **Temporal Cloud**: a namespace and API key per environment.
   - Then sign in to production as eric@lakemat.com and click **Connect Email**. The worker renews the Gmail watch daily (`renew-gmail-watch` schedule). Only production connects: there is one Gmail watch, so staging runs Gmail in fake mode.
5. **Deploy** (GitHub Actions, `.github/workflows/`): `ci.yml` typechecks, lints and tests every PR and push. `deploy.yml` deploys every push to `main` to **staging**; deploy **production** with *Actions → Deploy → Run workflow → production*. Both run `scripts/deploy.sh <env>`: build, migrations (`DATABASE_URL` from the secret), Lambda code, worker image (ECR, then an ECS redeploy), S3 sync and an `index.html` invalidation. Its settings are GitHub Environment variables set by `make github-vars ENV=<env>` in the terraform repo (including `VITE_AUTH0_*`). Migrations run before the new code is live, so they must not break the code that's still running (add first, drop in a later deploy). To deploy from a laptop instead, fill `deploy/<env>.env` from `deploy/example.env`.
