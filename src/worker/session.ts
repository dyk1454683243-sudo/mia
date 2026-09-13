/**
 * Identity: a signed cookie, no signup.
 *
 * Cookie value is `<playerId>.<base64url(HMAC-SHA256(playerId, key))>`. The HMAC
 * key lives in D1 (created on first use) rather than in a provisioned secret, so
 * the whole thing deploys in one command.
 */
import { ensureSchema, getConfig, getPlayer, insertPlayer, listPlayerNames, renamePlayer, setConfig, touchPlayer } from "./db";
import { pickShipName } from "../shared/ships";

export const COOKIE_NAME = "mia_pid";
export const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const KEY_CONFIG_NAME = "session_key";

/** Cached per isolate: the signing key and the parsed CryptoKey. */
let signingKey: Promise<CryptoKey> | null = null;

function randomKeyMaterial(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Wrap bytes in a fresh, definitely-not-shared ArrayBuffer for Web Crypto. */
function bufferOf(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy.buffer as ArrayBuffer;
}

async function loadSigningKey(env: Env): Promise<CryptoKey> {
  await ensureSchema(env);
  let material: Uint8Array;
  const stored = await getConfig(env, KEY_CONFIG_NAME);
  if (stored === null) {
    material = randomKeyMaterial();
    await setConfig(env, KEY_CONFIG_NAME, toBase64Url(material));
  } else {
    material = fromBase64Url(stored);
  }
  return await crypto.subtle.importKey("raw", bufferOf(material), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export function getSigningKey(env: Env): Promise<CryptoKey> {
  signingKey ??= loadSigningKey(env).catch((error: unknown) => {
    signingKey = null;
    throw error;
  });
  return signingKey;
}

function cookieValueOf(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== COOKIE_NAME) continue;
    const value = part.slice(index + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

/** Verify the signature in constant time and return the player id, or null. */
async function verifyCookie(env: Env, raw: string): Promise<string | null> {
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;
  const playerId = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (playerId.length === 0 || signature.length === 0) return null;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(playerId)) return null;

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(signature);
  } catch {
    return null;
  }

  const key = await getSigningKey(env);
  const ok = await crypto.subtle.verify("HMAC", key, bufferOf(signatureBytes), new TextEncoder().encode(playerId));
  return ok ? playerId : null;
}

export async function signCookie(env: Env, playerId: string): Promise<string> {
  const key = await getSigningKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(playerId));
  return `${playerId}.${toBase64Url(new Uint8Array(signature))}`;
}

export interface SessionPlayer {
  id: string;
  name: string;
  /** True when a brand new player row was created and a cookie must be set. */
  created: boolean;
  /** The cookie value to set, when `created` is true. */
  cookie: string | null;
}

export interface SessionOptions {
  /** Omit the Secure attribute on http://localhost so local dev works. */
  secure: boolean;
  now?: number;
}

function cookieHeader(value: string, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_S}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Resolve the current player, minting one on first visit. Every HTML and API
 * response path can call this; `attachSession` puts the cookie on the way out.
 */
export async function ensurePlayer(request: Request, env: Env, options: SessionOptions): Promise<SessionPlayer> {
  const now = options.now ?? Date.now();
  const header = request.headers.get("Cookie");
  const raw = cookieValueOf(header);

  if (raw !== null) {
    const playerId = await verifyCookie(env, raw);
    if (playerId !== null) {
      const row = await getPlayer(env, playerId);
      if (row) {
        // Best-effort presence update; a failure here must not break the request.
        try {
          await touchPlayer(env, playerId, now);
        } catch {
          /* ignore */
        }
        return { id: row.id, name: row.name, created: false, cookie: null };
      }
    }
  }

  await ensureSchema(env);
  const id = crypto.randomUUID();
  const name = pickShipName(await listPlayerNames(env));
  await insertPlayer(env, id, name, now);
  const cookie = await signCookie(env, id);
  return { id, name, created: true, cookie: cookieHeader(cookie, options.secure) };
}

/** True when the request is plain-http localhost, where Secure must be omitted. */
export function isLocalRequest(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/** Put the session cookie on a response that is heading back to the browser. */
export function attachSession(response: Response, session: SessionPlayer, secure: boolean): Response {
  if (session.cookie === null) return response;
  const next = new Response(response.body, response);
  next.headers.append("Set-Cookie", session.cookie);
  return next;
}

export { renamePlayer };

export interface NameValidation {
  ok: boolean;
  value: string;
  error?: string;
}

/** Trim, strip control characters, require 1–40 characters. */
export function validateName(input: unknown): NameValidation {
  if (typeof input !== "string") return { ok: false, value: "", error: "name must be a string" };
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (cleaned.length < 1 || cleaned.length > 40) {
    return { ok: false, value: cleaned, error: "name must be 1-40 characters" };
  }
  return { ok: true, value: cleaned };
}

/** Table names follow the same rules but may be empty, taking a default. */
export function validateTableName(input: unknown, fallback: string): NameValidation {
  if (input === undefined || input === null || input === "") return { ok: true, value: fallback };
  return validateName(input);
}
