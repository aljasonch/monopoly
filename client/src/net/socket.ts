import { io, Socket } from 'socket.io-client';
import {
  ClientToServerEvents,
  ServerToClientEvents
} from '@monopoly/shared';

const PLAYER_ID_KEY = 'monopoly_player_id';
const SESSION_KEY = 'monopoly_session_v2';
const RECENT_KEY = 'tmpoly_recent_sessions';
const LAST_NAME_KEY = 'tmpoly_last_name';

/** A seat this browser holds: room, identity and the seat's secret token. */
export interface PersistedSession {
  roomId: string;
  playerId: string;
  token: string;
  name: string;
}

// The live seat is per tab (sessionStorage): a reload rejoins it and a second
// tab can play as someone else. Recent seats also go to localStorage so a
// closed tab can be resumed from the home screen.
function read(store: 'session' | 'local', key: string): string | null {
  try {
    return (store === 'session' ? sessionStorage : localStorage).getItem(key);
  } catch {
    return memStore[`${store}:${key}`] ?? null;
  }
}

function write(store: 'session' | 'local', key: string, value: string): void {
  try {
    (store === 'session' ? sessionStorage : localStorage).setItem(key, value);
  } catch {
    memStore[`${store}:${key}`] = value;
  }
}

function remove(store: 'session' | 'local', key: string): void {
  try {
    (store === 'session' ? sessionStorage : localStorage).removeItem(key);
  } catch {
    delete memStore[`${store}:${key}`];
  }
}

const memStore: Record<string, string> = {};

// Signed-in account (Firebase uid): the identity on every device.
let accountUid: string | null = null;
export function setAccountUid(uid: string | null): void {
  accountUid = uid;
}

// Guest identity for this tab.
export function getOrCreatePlayerId(): string {
  const stored = read('session', PLAYER_ID_KEY);
  if (stored) return stored;
  const pid = 'p_' + Math.random().toString(36).substring(2, 10);
  write('session', PLAYER_ID_KEY, pid);
  return pid;
}

/** Who this tab plays as right now. */
export function currentPlayerId(): string {
  return accountUid ?? getOrCreatePlayerId();
}

export function saveSession(session: PersistedSession): void {
  const s = { ...session, roomId: session.roomId.toUpperCase() };
  write('session', SESSION_KEY, JSON.stringify(s));
  const recent = loadRecentSessions().filter((r) => !(r.roomId === s.roomId && r.playerId === s.playerId));
  write('local', RECENT_KEY, JSON.stringify([s, ...recent].slice(0, 6)));
}

export function loadSession(): PersistedSession | null {
  try {
    const raw = read('session', SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed.roomId || !parsed.playerId || !parsed.token) return null;
    return { ...parsed, roomId: parsed.roomId.toUpperCase(), name: parsed.name || '' };
  } catch {
    return null;
  }
}

/** Forget this tab's seat (and drop it from the resume list). */
export function clearSession(): void {
  const s = loadSession();
  remove('session', SESSION_KEY);
  if (s) forgetRecent(s.roomId, s.playerId);
}

// Whatever name the player last typed, so the field isn't blank next visit.
export function saveLastName(name: string): void {
  if (name.trim()) write('local', LAST_NAME_KEY, name);
}

export function loadLastName(): string {
  return read('local', LAST_NAME_KEY) ?? '';
}

export function loadRecentSessions(): PersistedSession[] {
  try {
    const list = JSON.parse(read('local', RECENT_KEY) ?? '[]') as PersistedSession[];
    return Array.isArray(list) ? list.filter((s) => s && s.roomId && s.playerId && s.token) : [];
  } catch {
    return [];
  }
}

export function forgetRecent(roomId: string, playerId?: string): void {
  const list = loadRecentSessions().filter((r) => !(r.roomId === roomId.toUpperCase() && (!playerId || r.playerId === playerId)));
  write('local', RECENT_KEY, JSON.stringify(list));
}

/** Resume a seat in this tab (e.g. from the home screen after a closed tab). */
export function adoptSession(s: PersistedSession): void {
  if (!accountUid) write('session', PLAYER_ID_KEY, s.playerId);
  saveSession(s);
}

// Connect to root origin (works on localhost:5173 via proxy AND on tunneled
// HTTPS). The connection opens once the identity is known (connectSocket).
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io('/', {
  transports: ['websocket', 'polling'],
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});

/**
 * (Re)opens the connection as the current identity. `idToken` is the
 * Firebase ID token when signed in; the server verifies it.
 */
export function connectSocket(idToken?: string | null): void {
  socket.auth = idToken ? { idToken } : {};
  socket.io.opts.query = { playerId: currentPlayerId() };
  if (socket.connected) socket.disconnect();
  socket.connect();
}

/** Keeps the handshake token fresh for future reconnects (no reconnect now). */
export function refreshSocketToken(idToken: string): void {
  socket.auth = { idToken };
}

/** Forget the seat in this tab only (it stays resumable elsewhere). */
export function dropTabSession(): void {
  remove('session', SESSION_KEY);
}
