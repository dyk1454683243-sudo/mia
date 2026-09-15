/**
 * Worker entrypoint: static assets, the JSON API, and the WebSocket upgrade
 * proxy into a table's Durable Object.
 *
 * Routing deliberately avoids SPA fallback and `run_worker_first`: the two HTML
 * pages are real files, `/t/:id` is not, so it reaches this Worker.
 */
import { MAX_PLAYERS } from "../shared/mia";
import type { CreateTableResponse, HistoryEntry, TableSummary } from "../shared/protocol";
import { createTable, ensureSchema, getTable, listHistory, listOpenTables, renamePlayer } from "./db";
import { attachSession, ensurePlayer, isLocalRequest, validateName, validateTableName, type SessionPlayer } from "./session";

export { TableRoom } from "./table-room";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function apiError(message: string, status: number): Response {
  return json({ error: message }, { status });
}

function methodNotAllowed(allow: string[]): Response {
  return json({ error: `Method not allowed. Use ${allow.join(", ")}.` }, { status: 405, headers: { Allow: allow.join(", ") } });
}

/** Reject cross-site writes. Same-origin, navigations and curl are unaffected. */
function crossSiteWrite(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  const site = request.headers.get("Sec-Fetch-Site");
  return site !== null && site !== "same-origin" && site !== "none";
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `/` is the lobby; `/t/:id` is the shareable join link; both are real files. */
function htmlEntryFor(pathname: string): string | null {
  if (pathname === "/") return "/index.html";
  if (pathname === "/index.html" || pathname === "/table.html") return pathname;
  if (pathname.startsWith("/t/")) return "/table.html";
  return null;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const secure = !isLocalRequest(url);

    const htmlEntry = htmlEntryFor(url.pathname);
    if (htmlEntry !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
      const session = await ensurePlayer(request, env, { secure });
      const asset = await env.ASSETS.fetch(new Request(new URL(htmlEntry, url), request));
      return attachSession(decorate(asset), session);
    }

    if (!isApiPath(url.pathname)) {
      // Static asset, served directly by the binding.
      return env.ASSETS.fetch(request);
    }

    if (crossSiteWrite(request)) return apiError("Cross-site request rejected.", 403);

    try {
      return await handleApi(request, env, url, secure);
    } catch (error) {
      console.error("unhandled api error", error instanceof Error ? error.message : String(error));
      return apiError("Internal error.", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, url: URL, secure: boolean): Promise<Response> {
  await ensureSchema(env);
  const session = await ensurePlayer(request, env, { secure });
  const respond = (response: Response): Response => attachSession(decorate(response), session);

  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  // segments[0] === "api"

  if (segments.length === 1) {
    return respond(json({ name: "mia", routes: ["/api/me", "/api/tables", "/api/tables/:id", "/api/tables/:id/ws", "/api/history"] }));
  }

  const [resource, id, sub] = segments.slice(1);

  if (resource === "me") {
    if (id !== undefined) return respond(apiError("Unknown route.", 404));
    if (request.method === "GET") return respond(json({ id: session.id, name: session.name }));
    if (request.method === "PATCH") {
      const body = await readJson(request);
      if (body === null) return respond(apiError("Expected a JSON object body.", 400));
      const name = validateName(body.name);
      if (!name.ok) return respond(apiError(name.error ?? "Invalid name.", 400));
      await renamePlayer(env, session.id, name.value);
      return respond(json({ id: session.id, name: name.value }));
    }
    return respond(methodNotAllowed(["GET", "PATCH"]));
  }

  if (resource === "tables") {
    if (id === undefined) {
      if (request.method === "GET") return respond(await listTables(env));
      if (request.method === "POST") return respond(await createTableRoute(request, env, session));
      return respond(methodNotAllowed(["GET", "POST"]));
    }
    if (sub === "ws") {
      if (request.method !== "GET") return respond(methodNotAllowed(["GET"]));
      return await upgrade(request, env, id, session, respond);
    }
    if (sub !== undefined) return respond(apiError("Unknown route.", 404));
    if (request.method === "GET") {
      const table = await getTable(env, id);
      if (!table) return respond(apiError("No such table.", 404));
      return respond(json(table));
    }
    return respond(methodNotAllowed(["GET"]));
  }

  if (resource === "history") {
    if (id !== undefined) return respond(apiError("Unknown route.", 404));
    if (request.method !== "GET") return respond(methodNotAllowed(["GET"]));
    return respond(await history(env, url));
  }

  return respond(apiError("Unknown route.", 404));
}

async function listTables(env: Env): Promise<Response> {
  const tables = await listOpenTables(env, Date.now());
  return json({ tables: tables satisfies TableSummary[] });
}

async function createTableRoute(request: Request, env: Env, session: SessionPlayer): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return apiError("Expected a JSON object body.", 400);
  const name = validateTableName(body.name, `${session.name}'s table`);
  if (!name.ok) return apiError(name.error ?? "Invalid table name.", 400);

  const id = crypto.randomUUID();
  const now = Date.now();
  await createTable(env, { id, name: name.value, hostId: session.id, maxPlayers: MAX_PLAYERS, now });
  const created: CreateTableResponse = { id, name: name.value };
  return json(created, { status: 201 });
}

async function history(env: Env, url: URL): Promise<Response> {
  const raw = Number(url.searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 50) : 10;
  const games = await listHistory(env, limit);
  return json({ games: games satisfies HistoryEntry[] });
}

async function upgrade(
  request: Request,
  env: Env,
  tableId: string,
  session: SessionPlayer,
  respond: (response: Response) => Response,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return respond(apiError("Expected a WebSocket upgrade.", 426));
  }
  const table = await getTable(env, tableId);
  if (!table) return respond(apiError("No such table.", 404));

  const stub = env.TABLE.getByName(tableId);
  const forwarded = new Request(request);
  forwarded.headers.set("X-Mia-Player", session.id);
  forwarded.headers.set("X-Mia-Name", encodeURIComponent(session.name));
  forwarded.headers.set("X-Mia-Table-Name", encodeURIComponent(table.name));
  forwarded.headers.set("X-Mia-Table-Id", tableId);
  // The creator is a property of the D1 row, not of who opens a socket first.
  forwarded.headers.set("X-Mia-Host-Id", table.hostId);
  const response = await stub.fetch(forwarded);
  return respond(response);
}

/** Light hardening on every response we hand back. */
function decorate(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set("X-Content-Type-Options", "nosniff");
  next.headers.set("Referrer-Policy", "same-origin");
  return next;
}
