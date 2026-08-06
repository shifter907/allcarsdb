# Hosting and deployment

## Recommended: Cloudflare

| Piece | Service | Free tier | What happens when you exceed it |
|---|---|---|---|
| Search UI | Pages | Unlimited requests, 500 builds/mo | Static assets stay free regardless |
| API | Workers | 100k requests/day | $5/mo → 10M requests |
| Database | D1 | 5 GB, 5M row-reads/day | $5/mo → 25 GB, 25 bn reads |
| SQLite/dump downloads | R2 | 10 GB, no egress fees | $0.015/GB-month |

**Expected cost at launch: $0.** Realistically $5/month once traffic is meaningful.

Two properties of this design keep the bill flat:

1. **Every response is cacheable.** The data changes only when a build ships, so responses carry `s-maxage=86400`. At the edge, most page views never reach the Worker at all.
2. **There is no write path.** No connection pooling, no locking, no vertical scaling, and read replicas are free.

D1's free tier is the real ceiling. 5 GB holds tens of millions of vehicle-year and engine pairings — comfortably more than every car ever sold in every market.

---

## First deploy

### 1. Build the artifacts

```bash
npm install
npm run build:db
npm run dump -w @allcarsdb/etl
```

Produces `dist/allcars.sqlite` and `dist/allcars.sql`.

### 2. Create the database

```bash
npx wrangler d1 create allcarsdb
```

Paste the returned `database_id` into `apps/api/wrangler.toml`.

### 3. Load the data

```bash
npx wrangler d1 execute allcarsdb --remote --file=dist/allcars.sql
```

### 4. Deploy the API

```bash
npm run deploy -w @allcarsdb/api
```

### 5. Deploy the UI

```bash
npm run build -w @allcarsdb/web
npx wrangler pages deploy apps/web/dist --project-name=allcarsdb
```

Then add a Pages route so `/v1/*` reaches the Worker — in the Cloudflare dashboard, or in `apps/web/public/_routes.json`. Same-origin means the UI needs no environment configuration and no CORS negotiation.

---

## Rebuilds

The database is regenerated from scratch on every data change. Once the dataset is large, a full remote import gets slow, so the sane pattern is:

1. CI builds and validates on every PR (blocking).
2. On merge to `main`, CI rebuilds and uploads `allcars.sqlite` + `allcars.sql` to R2 as the public download.
3. A **new** D1 database is imported, then the Worker binding is switched to it.

Step 3 matters. Importing into the live database leaves it half-populated for the duration; swapping the binding makes the cutover atomic and makes rollback a matter of pointing back at the previous database.

Once the import takes long enough to be annoying, switch to per-make sharded builds — the ETL structure already supports it, since each make's files are independent until the search index is assembled.

---

## Alternatives worth knowing about

### Everything static, no API at all

Ship the SQLite file and query it in the browser with `sql.js-httpvfs`, which fetches only the b-tree pages a query touches over HTTP range requests.

- **For:** literally $0, works on GitHub Pages, no backend to operate.
- **Against:** each query is several round trips; a cold search feels slow; the whole file must be public; and full-text search over a large FTS index gets painful.
- **Verdict:** excellent for a mirror or an offline copy, wrong as the primary interface.

### Postgres (Supabase / Neon)

The schema ports with small changes — `INTEGER PRIMARY KEY` → `GENERATED ALWAYS AS IDENTITY`, `REAL` → `double precision`, FTS5 → `tsvector`.

- **For:** real partial and expression indexes, `GIN` on arrays, materialized views, and window functions for ranking.
- **Against:** free tiers sleep or expire; a connection pooler becomes necessary; more to operate.
- **Verdict:** the right move *if* the search index outgrows what a SQLite scan can serve, or if you ever want a write path. Not before.

### DuckDB-WASM

Genuinely strong for the analytical half of this — "distribution of power-to-weight by decade" is a query DuckDB answers instantly and SQLite labours over.

- **Verdict:** worth adding later as a separate "explore the data" surface. Not the search backend.

---

## Domain and DNS

Point the apex at Pages and use one subdomain for the API only if you want the API independently cacheable:

```
allcarsdb.org        → Pages
api.allcarsdb.org    → Worker   (optional; /v1/* on the apex works fine)
data.allcarsdb.org   → R2       (public SQLite and SQL dumps)
```

Publishing the raw dumps is not an afterthought. An open database that is hard to bulk-download is only nominally open, and the dumps are what make forks credible — which is, in turn, what makes contributors trust the project with their work.

---

## Operational notes

**Cache invalidation.** Responses carry `stale-while-revalidate`, so a deploy never causes a latency spike. If you need an immediate purge, bump a version segment in the API path rather than purging by URL — cheaper and more predictable.

**The browser cache TTL is deliberately short.** Data endpoints carry `max-age=60` against `s-maxage=86400`. The edge absorbs the load; the sixty seconds bounds how long a visitor's cached copy of `/v1/fields` can disagree with the data it is used to render. A long browser TTL there means a schema change leaves people with a filter panel that no longer matches the results, and no amount of reloading fixes it until the entry expires.

**Monitoring.** `[observability]` is on in `wrangler.toml`. The metric that matters is p99 on `/v1/search` with no make/model filter — that is the full-scan case, and it is the first thing that will degrade as the dataset grows.

**Backups.** The data is in Git. The database is reproducible from it with one command. There is nothing else to back up, which is the whole point.
