---
name: cloudflare-temporary-accounts
description: Deploy Cloudflare Workers to a temporary no-signup account with `wrangler deploy --temporary` and hand the user a claim URL. Use for demos, prototypes, and agent-built Workers that need a live workers.dev URL when no Cloudflare account, login, or API token exists.
---

# Temporary Cloudflare accounts (claim deployments)

`wrangler deploy --temporary` provisions a throwaway Cloudflare account, deploys the
Worker into it, and prints a claim URL. The user can preview the live result
immediately and claim the account later to keep the deployment and its resources.

**Use it when:**

- A demo or prototype needs a real URL and the user has no Cloudflare account, or
  should not have to make one.
- An agent is asked to "build it and deploy it" with no credentials available.
- You want to validate a project end to end for real, rather than trusting
  `wrangler deploy --dry-run`.

**Do not use it for** production, CI/CD, or anything the user must keep without acting.
Those need a permanent account and `wrangler login` or an API token.

Source of truth: <https://developers.cloudflare.com/workers/platform/claim-deployments/>

## Pre-flight checks

Run these before designing anything. Each one has burned a real deployment.

1. **Wrangler must be >= 4.102.0.** Read the installed version from the project, not
   from memory. `--temporary` is *hidden* from `wrangler deploy --help`, so a missing
   help entry does not mean it is unsupported. Confirm it instead by running
   `wrangler whoami` while logged out — unauthenticated Wrangler advertises the flag:

   ```txt
   You are not authenticated. Please run `wrangler login`.
   To deploy without logging in, run a command like `wrangler deploy --temporary` to use a temporary preview account.
   ```

2. **The user must be logged out.** `--temporary` only works unauthenticated. Any
   existing OAuth session, `CLOUDFLARE_API_TOKEN`, or global API key makes it error.
   Check for ambient credentials before deploying:

   ```bash
   env | grep -iE 'cloudflare|cf_' ; npx wrangler whoami
   ```

   If a session exists, `npx wrangler logout` first. Note that logout is destructive to
   the user's existing CLI session — confirm before running it if they might rely on it.

3. **Check the home directory is writable.** Wrangler persists temporary credentials
   and claim state to its global config directory. If that write fails, the deploy dies
   *after* solving the proof-of-work challenge. See
   [Sandboxes and read-only home directories](#sandboxes-and-read-only-home-directories).

## Make the project temporary-account ready

The single most common blocker is a config that pins resource IDs belonging to some
other account. A fresh account does not have them, so deploy fails.

**Rule: declare bindings without IDs.** Omitting the ID is what triggers
[automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
for KV, R2, D1, Queues, and others.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-demo",
  "main": "src/index.ts",
  "compatibility_date": "<today>",
  // No "id" -> Wrangler creates the namespace and reports it on first deploy.
  "kv_namespaces": [{ "binding": "DEMO_KV" }],
  // No "database_id" -> same for D1. Keep "database_name" to control its name.
  "d1_databases": [{ "binding": "DEMO_DB", "database_name": "my-demo-db" }]
}
```

Durable Objects need no external provisioning at all — the class ships with the Worker.
Decide whether the SQLite backend is required:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

`new_sqlite_classes` is what makes Durable Objects usable on the free plan. Export the
class from the Worker entrypoint (`export { Counter } from "./counter";`) — a class only
exported from a non-entry module will not deploy.

Also:

- Prefer `wrangler.jsonc` and set `compatibility_date` to today for a new project.
- Regenerate types after every config change: `npx wrangler types`, then typecheck.
- Keep the Worker name <= 63 characters if it will serve `workers.dev`.
- **Do not commit account-specific IDs.** Auto-provisioning *may* write provisioned IDs
  back into the config file. Documentation says it does; in practice this has been
  observed not to for temporary deploys. Either way, read the config after the first
  deploy and strip any IDs before sharing the project.

## Deploy

```bash
npx wrangler deploy --temporary
```

It must run **non-interactively in one shot**: accepting the terms is implied by
continuing, and there is no prompt to answer. Expect this sequence:

```txt
Continuing means you accept Cloudflare's Terms of Service ... and Privacy Policy ...
Solving proof-of-work challenge…
Temporary account ready:
	Account: Glowing Cauliflower (created)
	Claim within: 60 minutes
	Claim URL:      https://dash.cloudflare.com/claim-preview?claimToken=<TOKEN>
...
The following bindings need to be provisioned:
Binding             Resource
env.DEMO_KV         KV Namespace
env.DEMO_DB         D1 Database
Provisioning DEMO_KV (KV Namespace)...
✨ DEMO_KV provisioned 🎉
...
Deployed my-demo triggers
  https://my-demo.<account-name>.workers.dev
```

The proof-of-work step can take a while — allow several minutes and run it as a
background job rather than under a short timeout.

**Reuse the account; do not burn new ones.** While the credentials and claim URL are
valid, Wrangler caches the account and later deploys report the same account as
`(reused)`, with bindings listed as `(inherited)`. Temporary account creation is rate
limited, so iterate by redeploying into the cached account. `wrangler login` or
`wrangler logout` clears the cache.

## Verify before handing anything over

A successful deploy proves packaging, not behavior. Exercise the live URL.

```bash
B=https://my-demo.<account-name>.workers.dev
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$B/"
curl -s "$B/api/health"
```

Cover every write path and the error paths, not just the happy path — a demo that 500s
on first click is worse than no demo. Include: each CRUD operation, a 404 for a missing
key, a 400 for invalid input, and a 405 for a wrong method.

Then **redeploy once and re-check persisted state**. This catches missing migrations and
proves KV/D1/Durable Object data actually survives, which is worth reporting:

```txt
KV:  same value after redeploy
D1:  same rows after redeploy
DO:  counter unchanged after redeploy
```

## Hand off the claim URL

Deliver the live URL and the claim URL together, and state the deadline explicitly.

**Treat the claim URL as a bearer credential.** Anyone holding it can take ownership of
the account. Therefore:

- Give it to the intended user directly, in your reply.
- **Never** write it into a committed file (README, `.env.example`, source) or a shared
  log, and do not echo it into artifacts you present.
- Note that the 60-minute window requires *completing* the claim in the dashboard —
  opening the link is not enough.
- State plainly that an unclaimed account and all its resources are deleted.
- The temporary API token is equally sensitive and lives on disk; see below.

## Resource support

Temporary accounts expose a deliberate subset. Design within it rather than discovering
the gaps mid-build.

| Supported | Notes |
| --- | --- |
| Workers | Deployments on `workers.dev` |
| Static Assets | Up to 1,000 files, 5 MiB each |
| KV | Namespaces + key operations |
| D1 | One database, 100 MB |
| Durable Objects | Including migrations |
| Hyperdrive | Up to two configs |
| Queues | Up to 10 |
| mTLS / CA certificates | `wrangler cert` operations |

**Not available — do not build a temporary-account demo on these:** R2, Workers AI,
Vectorize, Containers / Sandbox. If a project needs them, say so up front instead of
producing a demo that cannot deploy.

Even within supported products, temporary tokens do not grant every permanent-account
permission; unsupported operations return an authorization error. Provisioning is also
only available on the default public API endpoint, not the FedRAMP High endpoint.

## Gotchas that cost real debugging time

### Static Assets routing swallows the bare `/api` path

With `assets` configured, routing is asset-first: a request matching a file in the
assets directory is served directly, and everything else invokes the Worker. Two traps:

- **`not_found_handling: "single-page-application"` returns `index.html` (HTTP 200) for
  any unmatched path**, including your API. An API route then "works" but returns HTML.
  Only use SPA fallback when the app genuinely has client-side routing.
- **`run_worker_first: ["/api/*"]` does not match `/api`** (no trailing slash), and
  adding a bare `"/api"` entry did not reliably match either. If you need the bare path,
  do not rely on the pattern — let default asset-first routing send it to the Worker.

Correspondingly, guard API detection on both forms, because `startsWith("/api/")` alone
silently delegates the bare `/api` index to the asset binding:

```ts
const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
if (!isApi) return env.ASSETS.fetch(request);
```

The simplest reliable shape is the documented full-stack pattern — no `run_worker_first`,
no SPA fallback:

```jsonc
"assets": { "directory": "./public", "binding": "ASSETS" }
```

### KV is eventually consistent and will look broken

A key is readable immediately after `put`, but a subsequent `list` can omit it for up to
60 seconds. A UI that reloads the key list right after a write appears to lose data.

Do not paper over this — surface it. Show the just-written key as a distinct "pending
sync" row and explain the lag. It is also a genuinely instructive contrast against D1
and Durable Objects, which are strongly consistent.

Related: KV time-to-live and list operations are the wrong tool for anything requiring
read-your-writes. Use D1 or a Durable Object.

### D1 has no migration step on the free tier

Create tables lazily and cache the promise per isolate so only a cold start pays for it:

```ts
let schemaReady: Promise<unknown> | null = null;
function ensureSchema(env: Env) {
  schemaReady ??= env.DEMO_DB
    .prepare("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)")
    .run()
    .catch((err) => { schemaReady = null; throw err; });
  return schemaReady;
}
```

Reset the cache on failure, or a transient error poisons the isolate for its lifetime.

### Transient edge errors immediately after deploy

A request made seconds after deploy can return a Cloudflare error page (for example
`error code: 1042`) while the deployment propagates. Re-run it before debugging the
Worker — it is usually not your code.

## Sandboxes and read-only home directories

Wrangler stores temporary credentials and claim state in its global config directory
(`~/Library/Preferences/.wrangler/` on macOS, `~/.config/.wrangler/` on Linux,
`%APPDATA%` on Windows). If that path is not writable — sandboxed agents, containers,
restricted CI — the deploy fails *after* solving the proof-of-work:

```txt
A permission error occurred while accessing the file system.
Affected path: /Users/<user>/Library/Preferences/.wrangler/wrangler-temporary-account.toml
```

`WRANGLER_HOME` is **not** supported. Wrangler does honor `XDG_CONFIG_HOME` (and
`XDG_CACHE_HOME`), so relocate its state into a writable directory instead of escalating
permissions:

```bash
XDG_CONFIG_HOME=./.cfstate XDG_CACHE_HOME=./.cfstate/cache npx wrangler deploy --temporary
```

Add that directory to `.gitignore`. It contains `wrangler-temporary-account.toml` with
the account ID, API token, and claim URL — never commit, log, or present it.

Prefer this over requesting broader filesystem access: it needs no elevated permissions
and keeps the deployment reproducible.

## Reporting to the user

Always include:

1. The live `workers.dev` URL.
2. The claim URL, with the deadline in absolute UTC time, framed as sensitive.
3. The consequence of inaction — the account and its resources are deleted.
4. What was actually verified (which endpoints, which error paths, that state survived a
   redeploy), and what was not.
5. Any resource the user asked for that temporary accounts cannot support, called out
   rather than silently omitted.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `--temporary` not in `--help` | It is a hidden flag | Confirm via `wrangler whoami`; check version >= 4.102.0 |
| Error mentioning existing credentials | Already authenticated | `wrangler logout`, then retry |
| Deploy fails right after proof-of-work | Config dir not writable | Set `XDG_CONFIG_HOME` to a writable path |
| Deploy fails resolving a binding ID | Config pins another account's ID | Remove `id` / `database_id`; let Wrangler provision |
| API route returns HTML with status 200 | SPA `not_found_handling` fallback | Drop SPA fallback, or exclude the API path |
| `/api` index 404s but `/api/x` works | `startsWith("/api/")` guard | Match `=== "/api"` as well |
| Key missing from list right after write | KV eventual consistency | Expected; surface it in the UI |
| `error code: 1042` right after deploy | Edge propagation | Retry; usually transient |
| Rate-limited creating an account | Too many new temporary accounts | Reuse the cached account; wait before retrying |
