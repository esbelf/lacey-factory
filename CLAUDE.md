# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LakeMat Factory (factory.lakemat.com) is an internal app that tracks production: **roll received → cut → sewn (in-house or at Summit, an outside sewer) → inventory**. It replaces Katana MRP for inventory. See `README.md` for the product flow, roles table, and production setup.

Stack: React + Vite SPA (S3 + CloudFront) → Hono API (AWS Lambda behind the same CloudFront at `/api/*`) → Postgres via Drizzle (Neon in prod, Docker locally, PGlite in tests). Auth0 handles login.

## Commands

```bash
docker compose up --build            # everything locally: db + api :8787 + web :5173
docker compose up --build -V         # same, after dependency changes (fresh node_modules volumes)

npm test                             # API tests (vitest, real Postgres via in-process PGlite)
npm test -w api -- tests/flow.test.ts        # one file
npm test -w api -- -t "registers a roll"     # one test by name
npm run typecheck                    # all workspaces
npm run lint                         # eslint, whole repo
npm run build                        # api/dist/lambda.mjs + web/dist

npm run db:generate -w api           # after editing api/src/db/schema.ts; commit api/drizzle/*
npm run db:migrate -w api            # needs DATABASE_URL (compose runs this on api start)
scripts/deploy.sh staging|production # test, build, update Lambda, sync S3, invalidate
```

There is one `.env` at the repo root (copy `.env.example`). Docker compose, the API scripts, and Vite (`envDir: ".."`) all read it.

## Layout

npm workspaces:
- **`api/`**: Hono app. `src/app.ts` defines every route. `src/server.ts` is the Node entry (compose), and `src/lambda.ts` is the Lambda entry, bundled by `build.mjs` with esbuild.
- **`web/`**: Vite + React 19, react-router, and TanStack Query.
- **`shared/`**: imported as TS source (`@lacey-factory/shared/feet`, `@lacey-factory/shared/permissions`) by both api and web.

## Architecture

**API request path.** In `api/src/app.ts`, the auth middleware runs `authenticate()` from `src/auth.ts`, then `ensureUser()` from `src/domain/users.ts`, then sets `c.var.user` and `c.var.db`. The `need("<permission>")` middleware guards each write route. The handler parses the JSON body with `input(c, zodSchema)` and calls `src/domain/services.ts` for writes or `src/domain/queries.ts` for reads. Throw `UserError` (`src/domain/errors.ts`) for messages the user should see; `onError` maps it to a 400 `{ error }`. Write routes return `{ ok: "<message>" }` plus an `id` when something was created.

- `createApp({ getDb, authenticate })` takes its dependencies as arguments. Tests (`api/tests/roles.test.ts`) pass PGlite and a fake authenticate, then call `app.request()`.
- **Services** take `(db, actor email, input)` and run in one transaction with `.for("update")` row locks, so concurrent floor users can't double-cut or double-sew.
- **Inventory is derived**, not stored: the count of non-voided `in_stock` pieces plus the sum of `inventory_adjustments`.
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
