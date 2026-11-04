# LakeMat Factory — factory.lakemat.com

Internal app that tracks production: **roll received → cut → sewn (in-house or Summit) → inventory**.
Replaces Katana MRP for inventory. Sales decrements (website / dealer / Amazon) come later.

Stack: React + Vite (S3 + CloudFront) · Hono API (AWS Lambda) · Postgres + Drizzle (Neon in production, Docker locally) · Auth0.

```
Browser ──> CloudFront ──┬── /*      → S3 (React app)
                         └── /api/*  → Lambda (Hono) ──> Neon Postgres
```

## How it works
- **Rolls** (`/rolls`): register a roll (supplier roll # + auto code `R-0001`). Record cuts in as many sessions as you like; each size has a **fixed cut length** (Settings), and the app rejects a cut that needs more than what's left. Close out a roll with the measured leftover to see cutting drift.
- **To sew** (`/cut`): cut pieces by material + size. Mark sewn in-house (→ inventory) or send to Summit. Oldest pieces go first.
- **Summit** (`/summit`): "received 25 × 12x24" → the 25 oldest sent pieces move to inventory (FIFO).
- **Inventory** (`/inventory`): on hand per sewn material + size (LakeMat and MuckMat share the same sewn piece). Adjustments for opening balance / counts.
- Non-sewn materials (geogrid) go straight to inventory when cut.
- Every entry records who did it; cuts, sewing, shipments and receipts can be undone.
- **Catalog** (Settings → *Load LakeMat catalog*): adds TerraTex N06, TerraGrid RX1100, TerraTex HD NTPEP, TerraTex HPG-57, their cut sizes, and which pieces each product uses (`api/src/db/catalog.ts`). Only adds what's missing. Sizes arrive **switched off** at their finished length; enter the real cut length (with hem allowance) and turn each one on before cutting.

## Users and roles
| | Factory worker | Regular worker | Admin |
|---|:-:|:-:|:-:|
| Register rolls, record cuts, mark sewn, Summit send/receive, view everything | ✓ | ✓ | ✓ |
| Settings (materials, sizes, catalog), adjust inventory, close/reopen rolls, undo | | ✓ | ✓ |
| **Users** dashboard (change roles) | | | ✓ |

- Everyone who passes the sign-in rule gets a user record the first time they sign in, **always as a factory worker**. The admin promotes people on the **Users** page.
- The admin is always `eric@lakemat.com` (`ADMIN_EMAIL` in `shared/src/permissions.ts`). Nobody else can be made admin, and the admin's role can't be changed.
- Sign-in rule (checked by Auth0 **and** the API): verified `@lakemat.com` email, or a verified email in `ALLOWED_EMAILS`.

## Run locally
```bash
cp .env.example .env
docker compose up --build          # Postgres + API (:8787) + web (:5173)
```
Open http://localhost:5173. With the default `.env`, Auth0 is skipped and you're `eric@lakemat.com` (admin). Type another email into the **dev as** box in the header to act as someone else (new emails start as factory workers).

After changing dependencies, rebuild with fresh `node_modules` volumes: `docker compose up --build -V`.

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
4. **Deploy**: copy `deploy/example.env` to `deploy/<env>.env`, then `scripts/deploy.sh staging` (or `production`). It runs the tests, builds, updates the Lambda code, syncs the site to S3 and invalidates `index.html`.
