/**
 * D1 access: identity, the table directory, and finished-game results.
 * Live game state never reaches this module — that is the Durable Object's job.
 */
import type { HistoryEntry, TableSummary } from "../shared/protocol";

/**
 * Free-tier D1 has no migration step, so the schema is created lazily. The
 * promise is cached per isolate but the cache is cleared on failure, otherwise
 * one transient error poisons the isolate for its whole lifetime.
 */
let schemaReady: Promise<unknown> | null = null;

export function ensureSchema(env: Env): Promise<unknown> {
  schemaReady ??= env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS app_config (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS players (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         last_seen_at INTEGER NOT NULL
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS tables (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         host_id TEXT NOT NULL,
         status TEXT NOT NULL,
         player_count INTEGER NOT NULL DEFAULT 0,
         max_players INTEGER NOT NULL DEFAULT 8,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS games (
         id TEXT PRIMARY KEY,
         table_id TEXT NOT NULL,
         table_name TEXT NOT NULL,
         started_at INTEGER NOT NULL,
         finished_at INTEGER NOT NULL,
         winner_id TEXT NOT NULL,
         winner_name TEXT NOT NULL
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS game_players (
         game_id TEXT NOT NULL,
         player_id TEXT NOT NULL,
         name TEXT NOT NULL,
         place INTEGER NOT NULL,
         lives_left INTEGER NOT NULL,
         rounds_played INTEGER NOT NULL,
         PRIMARY KEY (game_id, player_id)
       )`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tables_status_updated ON tables (status, updated_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_games_finished ON games (finished_at DESC)`),
  ]).catch((error: unknown) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

// ---------------------------------------------------------------------------
// app_config
// ---------------------------------------------------------------------------

export async function getConfig(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM app_config WHERE key = ?1`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setConfig(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_config (key, value) VALUES (?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, value)
    .run();
}

// ---------------------------------------------------------------------------
// players
// ---------------------------------------------------------------------------

export interface PlayerRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
}

export async function insertPlayer(env: Env, id: string, name: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO players (id, name, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)`)
    .bind(id, name, now)
    .run();
}

export async function getPlayer(env: Env, id: string): Promise<PlayerRow | null> {
  return await env.DB.prepare(`SELECT id, name, created_at, last_seen_at FROM players WHERE id = ?1`)
    .bind(id)
    .first<PlayerRow>();
}

export async function touchPlayer(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE players SET last_seen_at = ?2 WHERE id = ?1`).bind(id, now).run();
}

export async function renamePlayer(env: Env, id: string, name: string): Promise<void> {
  await env.DB.prepare(`UPDATE players SET name = ?2 WHERE id = ?1`).bind(id, name).run();
}

export async function listPlayerNames(env: Env): Promise<string[]> {
  const result = await env.DB.prepare(`SELECT name FROM players`).all<{ name: string }>();
  return (result.results ?? []).map((row) => row.name);
}

// ---------------------------------------------------------------------------
// tables (lobby directory)
// ---------------------------------------------------------------------------

export const STALE_TABLE_MS = 30 * 60 * 1000;

interface TableRow {
  id: string;
  name: string;
  host_id: string;
  status: string;
  player_count: number;
  max_players: number;
  created_at: number;
  updated_at: number;
}

function toSummary(row: TableRow, hostName = "someone"): TableSummary {
  return {
    id: row.id,
    name: row.name,
    hostId: row.host_id,
    hostName,
    status: row.status as TableSummary["status"],
    playerCount: row.player_count,
    maxPlayers: row.max_players,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Tables worth showing in the lobby. A row whose Durable Object has gone quiet
 * is treated as abandoned rather than advertised forever.
 */
export async function listOpenTables(env: Env, now: number): Promise<TableSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, host_id, status, player_count, max_players, created_at, updated_at
       FROM tables
      WHERE status IN ('waiting', 'playing') AND updated_at > ?1
      ORDER BY CASE status WHEN 'waiting' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 50`,
  )
    .bind(now - STALE_TABLE_MS)
    .all<TableRow>();
  return (rows.results ?? []).map((row) => toSummary(row));
}

export async function getTable(env: Env, id: string): Promise<TableSummary | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, host_id, status, player_count, max_players, created_at, updated_at
       FROM tables WHERE id = ?1`,
  )
    .bind(id)
    .first<TableRow>();
  return row ? toSummary(row) : null;
}

export async function createTable(
  env: Env,
  table: { id: string; name: string; hostId: string; maxPlayers: number; now: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tables (id, name, host_id, status, player_count, max_players, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'waiting', 0, ?4, ?5, ?5)`,
  )
    .bind(table.id, table.name, table.hostId, table.maxPlayers, table.now)
    .run();
}

export async function updateTable(
  env: Env,
  id: string,
  patch: { status?: string; playerCount?: number; name?: string; now: number },
): Promise<void> {
  const sets: string[] = ["updated_at = ?2"];
  const values: unknown[] = [id, patch.now];
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = ?${values.length}`);
  }
  if (patch.playerCount !== undefined) {
    values.push(patch.playerCount);
    sets.push(`player_count = ?${values.length}`);
  }
  if (patch.name !== undefined) {
    values.push(patch.name);
    sets.push(`name = ?${values.length}`);
  }
  await env.DB.prepare(`UPDATE tables SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(...values)
    .run();
}

// ---------------------------------------------------------------------------
// finished games
// ---------------------------------------------------------------------------

export interface FinalPlayer {
  playerId: string;
  name: string;
  place: number;
  livesLeft: number;
  roundsPlayed: number;
}

export interface FinalGame {
  id: string;
  tableId: string;
  tableName: string;
  startedAt: number;
  finishedAt: number;
  winnerId: string;
  winnerName: string;
  players: FinalPlayer[];
}

/**
 * The only game data that reaches D1. Games and their player rows go in one
 * batch so a half-written result is impossible.
 */
export async function recordGame(env: Env, game: FinalGame): Promise<void> {
  const statements = [
    env.DB.prepare(
      `INSERT INTO games (id, table_id, table_name, started_at, finished_at, winner_id, winner_name)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(
      game.id,
      game.tableId,
      game.tableName,
      game.startedAt,
      game.finishedAt,
      game.winnerId,
      game.winnerName,
    ),
    ...game.players.map((player) =>
      env.DB.prepare(
        `INSERT INTO game_players (game_id, player_id, name, place, lives_left, rounds_played)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (game_id, player_id) DO NOTHING`,
      ).bind(game.id, player.playerId, player.name, player.place, player.livesLeft, player.roundsPlayed),
    ),
  ];
  await env.DB.batch(statements);
}

export async function listHistory(env: Env, limit = 10): Promise<HistoryEntry[]> {
  const games = await env.DB.prepare(
    `SELECT id, table_id, table_name, started_at, finished_at, winner_id, winner_name
       FROM games ORDER BY finished_at DESC LIMIT ?1`,
  )
    .bind(limit)
    .all<{
      id: string;
      table_id: string;
      table_name: string;
      started_at: number;
      finished_at: number;
      winner_id: string;
      winner_name: string;
    }>();

  const rows = games.results ?? [];
  if (rows.length === 0) return [];

  const placeholders = rows.map((_, index) => `?${index + 1}`).join(", ");
  const players = await env.DB.prepare(
    `SELECT game_id, player_id, name, place, lives_left, rounds_played
       FROM game_players WHERE game_id IN (${placeholders}) ORDER BY place ASC`,
  )
    .bind(...rows.map((row) => row.id))
    .all<{
      game_id: string;
      player_id: string;
      name: string;
      place: number;
      lives_left: number;
      rounds_played: number;
    }>();

  const byGame = new Map<string, HistoryEntry["players"]>();
  for (const row of players.results ?? []) {
    const list = byGame.get(row.game_id) ?? [];
    list.push({
      playerId: row.player_id,
      name: row.name,
      place: row.place,
      livesLeft: row.lives_left,
      roundsPlayed: row.rounds_played,
    });
    byGame.set(row.game_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    tableId: row.table_id,
    tableName: row.table_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    winnerId: row.winner_id,
    winnerName: row.winner_name,
    players: byGame.get(row.id) ?? [],
  }));
}
