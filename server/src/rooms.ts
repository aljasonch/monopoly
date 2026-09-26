import crypto from 'crypto';
import { customAlphabet } from 'nanoid';
import {
  BOARD_TILES,
  PROTOCOL_VERSION,
  ForceBuyMode,
  LeaderboardEntry,
  PlayerColor,
  RoomSettings,
  RoomState,
  Seat,
  TokenType
} from '@monopoly/shared';
import { EngineSnapshot, MonopolyGameEngine } from './engine/game.js';

// Room codes: 6 characters people can read out loud (no 0/O, 1/I/L, and no
// '-' / '_', which the join box does not accept).
const roomCode = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);

const AVAILABLE_COLORS: PlayerColor[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
const AVAILABLE_TOKENS: TokenType[] = ['car', 'hat', 'dog', 'ship', 'thimble', 'boot'];
export const TURN_TIMER_CHOICES = [0, 60, 90, 120] as const;
const FORCE_BUY_MODES: ForceBuyMode[] = ['off', 'developed', 'any'];

// Idle rooms are cleaned up (nobody connected for this long).
const IDLE_LOBBY_MS = 30 * 60_000;
const IDLE_GAME_MS = 3 * 60 * 60_000;
const FINISHED_MS = 30 * 60_000;

export interface RoomSession {
  roomId: string;
  hostPlayerId: string;
  settings: RoomSettings;
  seats: Seat[];
  engine: MonopolyGameEngine | null;
  status: 'waiting' | 'playing' | 'finished';
  createdAt: number;
  // Secret per seat: only the holder can reclaim it (never broadcast).
  tokens: Record<string, string>;
  // Last time anyone was connected (for idle cleanup).
  lastSeenAt: number;
  finishedAt?: number;
  // Seats held by signed-in accounts (Firebase uid = playerId).
  accounts?: string[];
}

/** Everything persisted per room (engine as a snapshot). */
export interface StoredRoom {
  roomId: string;
  hostPlayerId: string;
  settings: RoomSettings;
  seats: Seat[];
  status: RoomSession['status'];
  createdAt: number;
  tokens: Record<string, string>;
  lastSeenAt: number;
  finishedAt?: number;
  accounts?: string[];
  engine: EngineSnapshot | null;
}

/** A finished game, for match history / player stats. */
export interface MatchRecord {
  roomId: string;
  startedAt: number;
  finishedAt: number;
  turns: number;
  winnerId: string;
  victoryType: string;
  players: {
    playerId: string;
    name: string;
    token: string;
    color: string;
    netWorth: number;
    bankrupt: boolean;
    surrendered: boolean;
    account?: boolean;
  }[];
}

/** Wins / games per player from a list of finished matches. */
export function rankPlayers(matches: MatchRecord[], limit: number): LeaderboardEntry[] {
  const by = new Map<string, LeaderboardEntry>();
  for (const m of matches) {
    for (const p of m.players) {
      // Accounts are one player everywhere; guests (a new id per browser tab)
      // are grouped by name.
      const key = p.account ? `a:${p.playerId}` : `g:${p.name.trim().toLowerCase()}`;
      const e = by.get(key) ?? { playerId: p.playerId, name: p.name, wins: 0, gamesPlayed: 0, bestScore: 0, account: !!p.account };
      e.name = p.name;
      e.gamesPlayed++;
      e.bestScore = Math.max(e.bestScore, p.netWorth);
      if (p.playerId === m.winnerId) e.wins++;
      by.set(key, e);
    }
  }
  return sortBoard([...by.values()]).slice(0, limit);
}

export function sortBoard(list: LeaderboardEntry[]): LeaderboardEntry[] {
  return list.sort(
    (a, b) => b.wins - a.wins || a.gamesPlayed - b.gamesPlayed || b.bestScore - a.bestScore || a.name.localeCompare(b.name)
  );
}

/** Where rooms survive server restarts (local files). */
export interface RoomStore {
  loadAll(): Promise<StoredRoom[]>;
  save(room: StoredRoom): Promise<void>;
  remove(roomId: string): Promise<void>;
}

/** Player stats for the leaderboard (Firestore profiles, or local history). */
export interface ProfileStore {
  recordMatch(match: MatchRecord): Promise<void>;
  leaderboard(limit: number): Promise<LeaderboardEntry[]>;
}

export type JoinResult = { ok: boolean; room?: RoomSession; token?: string; error?: string; replaced?: string[] };

const newToken = () => crypto.randomBytes(18).toString('base64url');

// Constant-time token check.
export function tokenMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class RoomManager {
  private rooms = new Map<string, RoomSession>();
  private socketToPlayer = new Map<string, { roomId: string; playerId: string }>();
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private store?: RoomStore,
    private profiles?: ProfileStore
  ) {}

  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------

  public createRoom(hostSocketId: string, hostPlayerId: string, hostName: string): RoomSession & { hostToken: string } {
    let roomId = roomCode();
    while (this.rooms.has(roomId)) roomId = roomCode();

    const hostSeat: Seat = {
      seatIndex: 0,
      playerId: hostPlayerId,
      displayName: hostName || 'Player 1',
      tokenType: AVAILABLE_TOKENS[0],
      color: AVAILABLE_COLORS[0],
      isReady: true,
      isConnected: true,
      isHost: true
    };

    const hostToken = newToken();
    const room: RoomSession = {
      roomId,
      hostPlayerId,
      settings: {
        maxPlayers: 6,
        specialVictory: true,
        turnTimeoutSec: 90,
        forceBuyMode: 'developed',
        randomEvents: true
      },
      seats: [hostSeat],
      engine: null,
      status: 'waiting',
      createdAt: Date.now(),
      tokens: { [hostPlayerId]: hostToken },
      lastSeenAt: Date.now()
    };

    this.rooms.set(roomId, room);
    this.socketToPlayer.set(hostSocketId, { roomId, playerId: hostPlayerId });
    this.persist(roomId);
    return Object.assign(room, { hostToken });
  }

  /**
   * Takes a new seat, or reclaims the caller's own seat when they present
   * its token (a reload, a second tab, or a resumed session).
   */
  // `verified`: the player id was proven by a Firebase sign-in, so the seat
  // can be reclaimed from any device without its token.
  public joinRoom(roomId: string, socketId: string, playerId: string, name: string, token?: string, verified = false): JoinResult {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return { ok: false, error: 'Room not found' };
    const existing = room.seats.find((s) => s.playerId === playerId);
    if (existing) {
      if (!verified && !tokenMatches(room.tokens[playerId], token)) return { ok: false, error: 'That seat belongs to someone else' };
      return this.claimSeat(room, socketId, playerId, name);
    }

    if (room.status !== 'waiting') return { ok: false, error: 'Game already in progress' };
    if (room.seats.length >= room.settings.maxPlayers) return { ok: false, error: 'Room is full (max 6)' };

    const seatIndex = room.seats.length;
    const usedColors = new Set(room.seats.map((s) => s.color));
    const usedTokens = new Set(room.seats.map((s) => s.tokenType));

    const color = AVAILABLE_COLORS.find((c) => !usedColors.has(c)) || AVAILABLE_COLORS[seatIndex % 6];
    const tokenType = AVAILABLE_TOKENS.find((t) => !usedTokens.has(t)) || AVAILABLE_TOKENS[seatIndex % 6];

    room.seats.push({
      seatIndex,
      playerId,
      displayName: name || `Player ${seatIndex + 1}`,
      tokenType,
      color,
      isReady: false,
      isConnected: true,
      isHost: false
    });
    const seatToken = newToken();
    room.tokens[playerId] = seatToken;
    this.socketToPlayer.set(socketId, { roomId: room.roomId, playerId });
    room.lastSeenAt = Date.now();
    this.persist(room.roomId);
    return { ok: true, room, token: seatToken };
  }

  /** Reload / resume: same seat, proven by its token. */
  public reconnectSocket(
    socketId: string,
    roomId: string,
    playerId: string,
    token: string | undefined,
    displayName?: string,
    verified = false
  ): JoinResult {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return { ok: false, error: 'Room not found' };
    const seat = room.seats.find((s) => s.playerId === playerId);
    if (!seat) return { ok: false, error: 'Player seat not found' };
    if (!room.tokens[playerId]) return { ok: false, error: 'You left this game' };
    if (!verified && !tokenMatches(room.tokens[playerId], token)) return { ok: false, error: 'Session expired' };
    return this.claimSeat(room, socketId, playerId, displayName);
  }

  // The newest connection wins: older sockets on the same seat are released
  // (their tabs are told the game moved to another window).
  private claimSeat(room: RoomSession, socketId: string, playerId: string, name?: string): JoinResult {
    const seat = room.seats.find((s) => s.playerId === playerId)!;
    const replaced: string[] = [];
    for (const [sid, mapped] of [...this.socketToPlayer.entries()]) {
      if (sid !== socketId && mapped.roomId === room.roomId && mapped.playerId === playerId) {
        this.socketToPlayer.delete(sid);
        replaced.push(sid);
      }
    }
    if (name) seat.displayName = name;
    seat.isConnected = true;
    this.socketToPlayer.set(socketId, { roomId: room.roomId, playerId });
    room.lastSeenAt = Date.now();
    if (room.engine) {
      const player = room.engine.state.players.find((p) => p.playerId === playerId);
      if (player && name) player.name = name;
      room.engine.setConnected(playerId, true);
    }
    this.persist(room.roomId);
    return { ok: true, room, token: room.tokens[playerId], replaced };
  }

  public getRoom(roomId: string): RoomSession | undefined {
    return this.rooms.get(roomId.toUpperCase());
  }

  public allRooms(): RoomSession[] {
    return [...this.rooms.values()];
  }

  public getPlayerBySocket(socketId: string): { roomId: string; playerId: string } | undefined {
    return this.socketToPlayer.get(socketId);
  }

  /** Sockets currently holding `playerId`'s seat in `roomId`. */
  public socketsOf(roomId: string, playerId: string): string[] {
    return [...this.socketToPlayer.entries()]
      .filter(([, m]) => m.roomId === roomId && m.playerId === playerId)
      .map(([sid]) => sid);
  }

  public selectToken(roomId: string, playerId: string, token: TokenType, color: PlayerColor): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting') return false;

    const seat = room.seats.find((s) => s.playerId === playerId);
    if (!seat) return false;

    const tokenTaken = room.seats.some((s) => s.playerId !== playerId && s.tokenType === token);
    const colorTaken = room.seats.some((s) => s.playerId !== playerId && s.color === color);

    if (!tokenTaken) seat.tokenType = token;
    if (!colorTaken) seat.color = color;
    this.persist(roomId);
    return true;
  }

  public toggleReady(roomId: string, playerId: string, ready: boolean): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting') return false;

    const seat = room.seats.find((s) => s.playerId === playerId);
    if (!seat) return false;

    seat.isReady = ready;
    this.persist(roomId);
    return true;
  }

  public toggleSpecialVictory(roomId: string, playerId: string, enabled: boolean): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting') return false;
    if (room.hostPlayerId !== playerId) return false;

    room.settings.specialVictory = enabled;
    this.persist(roomId);
    return true;
  }

  public setTurnTimer(roomId: string, playerId: string, sec: number): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting' || room.hostPlayerId !== playerId) return false;
    if (!(TURN_TIMER_CHOICES as readonly number[]).includes(sec)) return false;
    room.settings.turnTimeoutSec = sec;
    this.persist(roomId);
    return true;
  }

  public setForceBuyMode(roomId: string, playerId: string, mode: ForceBuyMode): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting' || room.hostPlayerId !== playerId) return false;
    if (!FORCE_BUY_MODES.includes(mode)) return false;
    room.settings.forceBuyMode = mode;
    this.persist(roomId);
    return true;
  }

  public setRandomEvents(roomId: string, playerId: string, enabled: boolean): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting' || room.hostPlayerId !== playerId) return false;
    room.settings.randomEvents = enabled;
    this.persist(roomId);
    return true;
  }

  /** Host removes someone from the lobby (before the game starts). */
  public kick(roomId: string, hostId: string, targetId: string): { ok: boolean; sockets?: string[]; error?: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: 'Room not found' };
    if (room.hostPlayerId !== hostId) return { ok: false, error: 'Only the host can remove players' };
    if (room.status !== 'waiting') return { ok: false, error: 'Players cannot be removed once the game has started' };
    if (targetId === hostId) return { ok: false, error: 'You cannot remove yourself' };
    const idx = room.seats.findIndex((s) => s.playerId === targetId);
    if (idx < 0) return { ok: false, error: 'Player not found' };
    const sockets = this.socketsOf(room.roomId, targetId);
    sockets.forEach((sid) => this.socketToPlayer.delete(sid));
    room.seats.splice(idx, 1);
    room.seats.forEach((s, i) => (s.seatIndex = i));
    delete room.tokens[targetId];
    this.persist(roomId);
    return { ok: true, sockets };
  }

  public startGame(roomId: string, playerId: string): { ok: boolean; engine?: MonopolyGameEngine; error?: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: 'Room not found' };
    if (room.hostPlayerId !== playerId) return { ok: false, error: 'Only the host can start the game' };
    if (room.status !== 'waiting') return { ok: false, error: 'The game has already started' };
    if (room.seats.length < 2) return { ok: false, error: 'Need at least 2 players to start' };

    const unready = room.seats.filter((s) => !s.isReady && !s.isHost);
    if (unready.length > 0) {
      return { ok: false, error: 'All players must be ready to start' };
    }

    room.status = 'playing';
    room.engine = new MonopolyGameEngine(room.roomId, room.seats, {
      specialVictory: room.settings.specialVictory,
      turnTimerSec: room.settings.turnTimeoutSec,
      randomEvents: room.settings.randomEvents,
      forceBuyMode: room.settings.forceBuyMode
    });
    for (const seat of room.seats) {
      const p = room.engine.state.players.find((pl) => pl.playerId === seat.playerId);
      if (p) p.isConnected = seat.isConnected;
    }
    room.engine.begin();
    this.persist(roomId);
    return { ok: true, engine: room.engine };
  }

  /** Marks a seat as belonging to a signed-in account. */
  public markAccount(roomId: string, playerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.accounts = [...new Set([...(room.accounts ?? []), playerId])];
  }

  // Cached for 5 minutes (Firestore free plan: few reads), and refreshed
  // after each finished game so new results show up.
  private boardCache: { at: number; limit: number; list: Promise<LeaderboardEntry[]> } | null = null;

  public leaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    const c = this.boardCache;
    if (c && c.limit >= limit && Date.now() - c.at < 5 * 60_000) return c.list.then((l) => l.slice(0, limit));
    const list = (this.profiles?.leaderboard(limit) ?? Promise.resolve([])).catch((e) => {
      console.warn('leaderboard unavailable', e);
      this.boardCache = null;
      return [] as LeaderboardEntry[];
    });
    this.boardCache = { at: Date.now(), limit, list };
    return list;
  }

  /** Rooms where `playerId` still holds a seat (for "resume your game"). */
  public roomsOf(playerId: string): RoomSession[] {
    return [...this.rooms.values()].filter((r) => r.status !== 'finished' && !!r.tokens[playerId]);
  }

  private matchRecord(room: RoomSession): MatchRecord | null {
    const st = room.engine?.state;
    if (!st?.winnerId) return null;
    const worth = (id: string, money: number) =>
      Object.values(st.properties).reduce((sum, p) => {
        if (p.ownerId !== id) return sum;
        const t = BOARD_TILES[p.tileIndex];
        return sum + (p.isMortgaged ? Math.floor(t.price / 2) : t.price) + t.buildCost * p.buildLevel;
      }, money);
    return {
      roomId: room.roomId,
      startedAt: room.createdAt,
      finishedAt: room.finishedAt ?? Date.now(),
      turns: st.turnNumber,
      winnerId: st.winnerId,
      victoryType: st.victoryType ?? 'bankruptcy',
      players: st.players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        token: p.tokenType,
        color: p.color,
        netWorth: p.isBankrupt ? 0 : worth(p.playerId, p.money),
        bankrupt: p.isBankrupt,
        surrendered: !!p.surrendered,
        account: room.accounts?.includes(p.playerId) ?? false
      }))
    };
  }

  /** Called whenever the engine state changes. */
  public onGameChanged(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room?.engine) return;
    if (room.engine.state.phase === 'GAME_OVER' && room.status !== 'finished') {
      room.status = 'finished';
      room.finishedAt = Date.now();
      const match = this.matchRecord(room);
      if (match) {
        this.profiles
          ?.recordMatch(match)
          .then(() => (this.boardCache = null))
          .catch((e) => console.warn('player stats save failed', e));
      }
    }
    this.persist(roomId);
  }

  // ------------------------------------------------------------------
  // Connections
  // ------------------------------------------------------------------

  public handleDisconnect(socketId: string): { room?: RoomSession; seat?: Seat } {
    const info = this.socketToPlayer.get(socketId);
    if (!info) return {};

    this.socketToPlayer.delete(socketId);

    // Still connected from another socket (second tab): nothing changes.
    if (this.socketsOf(info.roomId, info.playerId).length > 0) {
      return { room: this.rooms.get(info.roomId) };
    }

    const room = this.rooms.get(info.roomId);
    if (!room) return {};

    const seat = room.seats.find((s) => s.playerId === info.playerId);
    if (seat) {
      seat.isConnected = false;
      room.lastSeenAt = Date.now();
      room.engine?.setConnected(info.playerId, false);
    }
    this.persist(room.roomId);
    return { room, seat };
  }

  /**
   * Leaving for good. In the lobby the seat is freed (host passes on); in a
   * running game leaving means forfeiting: the player surrenders and their
   * seat token is revoked.
   */
  public leaveRoom(socketId: string): { ok: boolean; room?: RoomSession; error?: string } {
    const info = this.socketToPlayer.get(socketId);
    if (!info) return { ok: false, error: 'Not in a room' };

    const room = this.rooms.get(info.roomId);
    for (const sid of this.socketsOf(info.roomId, info.playerId)) this.socketToPlayer.delete(sid);
    if (!room) return { ok: true };

    const seatIdx = room.seats.findIndex((s) => s.playerId === info.playerId);
    if (seatIdx < 0) return { ok: true, room };

    if (room.status === 'waiting') {
      const wasHost = room.seats[seatIdx].isHost;
      room.seats.splice(seatIdx, 1);
      room.seats.forEach((s, i) => (s.seatIndex = i));
      delete room.tokens[info.playerId];
      if (wasHost && room.seats.length > 0) {
        room.seats[0].isHost = true;
        room.seats[0].isReady = true;
        room.hostPlayerId = room.seats[0].playerId;
      }
      if (room.seats.length === 0) {
        this.deleteRoom(room.roomId);
        return { ok: true };
      }
    } else {
      const seat = room.seats[seatIdx];
      seat.isConnected = false;
      delete room.tokens[info.playerId];
      const player = room.engine?.state.players.find((p) => p.playerId === info.playerId);
      if (room.engine && player && !player.isBankrupt && room.engine.state.phase !== 'GAME_OVER') {
        room.engine.surrender(info.playerId);
      }
      room.engine?.setConnected(info.playerId, false);
    }
    this.persist(room.roomId);
    return { ok: true, room };
  }

  public toRoomState(room: RoomSession): RoomState {
    return {
      roomId: room.roomId,
      hostPlayerId: room.hostPlayerId,
      status: room.status,
      // Always complete, whatever older code created or saved the room.
      settings: {
        ...room.settings,
        forceBuyMode: room.settings.forceBuyMode ?? 'developed',
        randomEvents: room.settings.randomEvents ?? true
      },
      seats: room.seats,
      winnerId: room.engine?.state.winnerId ?? null,
      victoryType: room.engine?.state.victoryType ?? null,
      protocol: PROTOCOL_VERSION
    };
  }

  // ------------------------------------------------------------------
  // Lifecycle: cleanup + persistence
  // ------------------------------------------------------------------

  /** Deletes rooms nobody uses any more. Returns the removed room ids. */
  public sweep(now = Date.now()): string[] {
    const removed: string[] = [];
    for (const room of this.rooms.values()) {
      const anyoneHere = room.seats.some((s) => s.isConnected);
      if (anyoneHere) room.lastSeenAt = now;
      const idle = now - room.lastSeenAt;
      const expired =
        (room.status === 'finished' && now - (room.finishedAt ?? now) > FINISHED_MS && !anyoneHere) ||
        (room.status === 'waiting' && idle > IDLE_LOBBY_MS) ||
        (room.status === 'playing' && idle > IDLE_GAME_MS);
      if (expired) {
        removed.push(room.roomId);
        this.deleteRoom(room.roomId);
      }
    }
    return removed;
  }

  private deleteRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    room?.engine?.dispose();
    this.rooms.delete(roomId);
    for (const [sid, m] of [...this.socketToPlayer.entries()]) if (m.roomId === roomId) this.socketToPlayer.delete(sid);
    const t = this.saveTimers.get(roomId);
    if (t) clearTimeout(t);
    this.saveTimers.delete(roomId);
    this.store?.remove(roomId).catch((e) => console.warn('room store remove failed', e));
  }

  public toStored(room: RoomSession): StoredRoom {
    return {
      roomId: room.roomId,
      hostPlayerId: room.hostPlayerId,
      settings: room.settings,
      seats: room.seats,
      status: room.status,
      createdAt: room.createdAt,
      tokens: room.tokens,
      lastSeenAt: room.lastSeenAt,
      finishedAt: room.finishedAt,
      accounts: room.accounts,
      engine: room.engine ? room.engine.snapshot() : null
    };
  }

  // Debounced write: a burst of changes becomes one save.
  public persist(roomId: string): void {
    if (!this.store || this.saveTimers.has(roomId)) return;
    this.saveTimers.set(
      roomId,
      setTimeout(() => {
        this.saveTimers.delete(roomId);
        const room = this.rooms.get(roomId);
        if (!room || !this.store) return;
        this.store.save(this.toStored(room)).catch((e) => console.warn('room store save failed', e));
      }, 800)
    );
  }

  /** Writes every pending room now (graceful shutdown). */
  public async flush(): Promise<void> {
    if (!this.store) return;
    const ids = [...this.saveTimers.keys()];
    ids.forEach((id) => clearTimeout(this.saveTimers.get(id)!));
    this.saveTimers.clear();
    await Promise.all(
      ids.map((id) => {
        const room = this.rooms.get(id);
        return room ? this.store!.save(this.toStored(room)) : Promise.resolve();
      })
    );
  }

  /** Loads saved rooms after a restart; returns the restored rooms. */
  public async restore(): Promise<RoomSession[]> {
    if (!this.store) return [];
    const stored = await this.store.loadAll();
    const restored: RoomSession[] = [];
    for (const s of stored) {
      try {
        // Rooms saved before force-buy modes / random events shipped won't
        // have these fields on disk: fall back to the old always-on rules.
        const settings: RoomSettings = {
          ...s.settings,
          forceBuyMode: s.settings.forceBuyMode ?? 'developed',
          randomEvents: s.settings.randomEvents ?? true
        };
        const room: RoomSession = {
          roomId: s.roomId,
          hostPlayerId: s.hostPlayerId,
          settings,
          seats: s.seats.map((seat) => ({ ...seat, isConnected: false })),
          engine: s.engine
            ? MonopolyGameEngine.restore(s.engine, {
                randomEvents: settings.randomEvents,
                forceBuyMode: settings.forceBuyMode
              })
            : null,
          status: s.status,
          createdAt: s.createdAt,
          tokens: s.tokens ?? {},
          lastSeenAt: Date.now(),
          finishedAt: s.finishedAt,
          accounts: s.accounts
        };
        this.rooms.set(room.roomId, room);
        restored.push(room);
      } catch (e) {
        console.warn(`Could not restore room ${s.roomId}`, e);
      }
    }
    return restored;
  }
}
