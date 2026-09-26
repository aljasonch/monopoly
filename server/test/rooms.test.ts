import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RoomManager, RoomStore, StoredRoom, MatchRecord, ProfileStore, rankPlayers } from '../src/rooms.js';

// Host + one ready guest, game started. Returns the guest's seat token.
function startedRoom(manager: RoomManager) {
  const room = manager.createRoom('socket-host', 'p-host', 'Host');
  const join = manager.joinRoom(room.roomId, 'socket-p2', 'p2', 'Player 2');
  manager.toggleReady(room.roomId, 'p2', true);
  manager.startGame(room.roomId, 'p-host');
  return { room, token: join.token!, hostToken: room.hostToken };
}

class MemoryStore implements RoomStore, ProfileStore {
  rooms = new Map<string, StoredRoom>();
  matches: MatchRecord[] = [];
  async loadAll() {
    return [...this.rooms.values()].map((r) => JSON.parse(JSON.stringify(r)));
  }
  async save(room: StoredRoom) {
    this.rooms.set(room.roomId, JSON.parse(JSON.stringify(room)));
  }
  async remove(roomId: string) {
    this.rooms.delete(roomId);
  }
  async recordMatch(m: MatchRecord) {
    this.matches.push(m);
  }
  async leaderboard(limit: number) {
    return rankPlayers(this.matches, limit);
  }
}

describe('RoomManager sessions', () => {
  let manager: RoomManager;

  beforeEach(() => {
    manager = new RoomManager();
  });
  afterEach(() => {
    vi.useRealTimers();
    manager.allRooms().forEach((r) => r.engine?.dispose());
  });

  it('a seated player rejoins an active game with their seat token', () => {
    const { room, token } = startedRoom(manager);
    manager.handleDisconnect('socket-p2');
    const p2Seat = room.seats.find((s) => s.playerId === 'p2');
    expect(p2Seat?.isConnected).toBe(false);
    expect(room.engine?.state.players.find((p) => p.playerId === 'p2')?.isConnected).toBe(false);

    const rejoin = manager.joinRoom(room.roomId, 'socket-p2-new', 'p2', 'Player 2 Rejoined', token);
    expect(rejoin.ok).toBe(true);
    expect(p2Seat?.isConnected).toBe(true);
    expect(p2Seat?.displayName).toBe('Player 2 Rejoined');
    expect(manager.getPlayerBySocket('socket-p2-new')).toEqual({ roomId: room.roomId, playerId: 'p2' });
    expect(room.engine?.state.players.find((p) => p.playerId === 'p2')?.isConnected).toBe(true);
  });

  it('room codes use only letters and digits the join box accepts', () => {
    for (let i = 0; i < 200; i++) {
      expect(manager.createRoom(`s${i}`, `p${i}`, 'X').roomId).toMatch(/^[A-Z2-9]{6}$/);
    }
  });

  it('nobody can take a seat by knowing its player id', () => {
    const { room } = startedRoom(manager);
    expect(manager.joinRoom(room.roomId, 'evil', 'p2', 'Mallory').ok).toBe(false);
    expect(manager.joinRoom(room.roomId, 'evil', 'p2', 'Mallory', 'guess').error).toMatch(/belongs to someone else/);
    expect(manager.reconnectSocket('evil', room.roomId, 'p2', 'nope').ok).toBe(false);
    // A verified account (Firebase uid) may reclaim its own seat anywhere.
    expect(manager.reconnectSocket('phone', room.roomId, 'p2', undefined, 'P2', true).ok).toBe(true);
  });

  it('rejects an unknown player attempting to join an active game', () => {
    const { room } = startedRoom(manager);
    const res = manager.joinRoom(room.roomId, 'socket-stranger', 'p-stranger', 'Stranger');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Game already in progress');
  });

  it('reconnect restores the socket mapping; the newest tab takes the seat over', () => {
    const { room, token } = startedRoom(manager);
    const res = manager.reconnectSocket('socket-p2-b', room.roomId.toLowerCase(), 'p2', token, 'Player 2');
    expect(res.ok).toBe(true);
    expect(res.replaced).toEqual(['socket-p2']);
    expect(manager.getPlayerBySocket('socket-p2')).toBeUndefined();
    expect(manager.getPlayerBySocket('socket-p2-b')).toEqual({ roomId: room.roomId, playerId: 'p2' });
  });

  it('leaving the lobby frees the seat; the host role passes on', () => {
    const room = manager.createRoom('socket-host', 'p-host', 'Host');
    manager.joinRoom(room.roomId, 'socket-p2', 'p2', 'Player 2');
    expect(manager.leaveRoom('socket-host').ok).toBe(true);
    expect(room.seats.map((s) => s.playerId)).toEqual(['p2']);
    expect(room.hostPlayerId).toBe('p2');
    expect(room.seats[0].isHost).toBe(true);
  });

  it('leaving a running game forfeits it and revokes the seat token', () => {
    const { room, token } = startedRoom(manager);
    manager.leaveRoom('socket-p2');
    expect(room.engine?.state.players.find((p) => p.playerId === 'p2')?.surrendered).toBe(true);
    expect(room.engine?.state.phase).toBe('GAME_OVER');
    expect(manager.reconnectSocket('x', room.roomId, 'p2', token).ok).toBe(false);
  });

  it('the host can remove players from the lobby only', () => {
    const room = manager.createRoom('socket-host', 'p-host', 'Host');
    manager.joinRoom(room.roomId, 'socket-p2', 'p2', 'Player 2');
    expect(manager.kick(room.roomId, 'p2', 'p-host').ok).toBe(false);
    const res = manager.kick(room.roomId, 'p-host', 'p2');
    expect(res.ok).toBe(true);
    expect(res.sockets).toEqual(['socket-p2']);
    expect(room.seats).toHaveLength(1);
  });

  it('only the host sets the turn timer, to an allowed value', () => {
    const room = manager.createRoom('socket-host', 'p-host', 'Host');
    expect(manager.setTurnTimer(room.roomId, 'p-host', 60)).toBe(true);
    expect(manager.setTurnTimer(room.roomId, 'p-host', 7)).toBe(false);
    expect(manager.setTurnTimer(room.roomId, 'someone', 0)).toBe(false);
    expect(room.settings.turnTimeoutSec).toBe(60);
  });

  it('room state always carries complete settings and the protocol version', () => {
    const room = manager.createRoom('socket-host', 'p-host', 'Host');
    // A room created by older code has no force-buy / random-events fields.
    const legacy = room.settings as Partial<typeof room.settings>;
    delete legacy.forceBuyMode;
    delete legacy.randomEvents;
    const state = manager.toRoomState(room);
    expect(state.settings.forceBuyMode).toBe('developed');
    expect(state.settings.randomEvents).toBe(true);
    expect(state.protocol).toBeGreaterThanOrEqual(2);
    expect(manager.setForceBuyMode(room.roomId, 'p-host', 'any')).toBe(true);
    expect(manager.toRoomState(room).settings.forceBuyMode).toBe('any');
  });

  it('idle rooms are cleaned up', () => {
    const room = manager.createRoom('socket-host', 'p-host', 'Host');
    manager.handleDisconnect('socket-host');
    const later = Date.now() + 31 * 60_000;
    expect(manager.sweep(later)).toEqual([room.roomId]);
    expect(manager.getRoom(room.roomId)).toBeUndefined();
  });

  it('games survive a restart through the room store and record match history', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    manager = new RoomManager(store, store);
    const { room, token } = startedRoom(manager);
    room.engine!.rollDice(1, 2);
    await manager.flush();
    expect(store.rooms.has(room.roomId)).toBe(true);

    const rebooted = new RoomManager(store, store);
    const [back] = await rebooted.restore();
    expect(back.status).toBe('playing');
    expect(back.engine?.state.players[0].position).toBe(3);
    expect(back.seats.every((s) => !s.isConnected)).toBe(true);
    expect(rebooted.reconnectSocket('s', room.roomId, 'p2', token).ok).toBe(true);

    back.engine!.surrender('p-host');
    rebooted.onGameChanged(room.roomId);
    expect(back.status).toBe('finished');
    await Promise.resolve();
    expect(store.matches[0]?.winnerId).toBe('p2');
    const [top] = await rebooted.leaderboard(5);
    expect(top).toMatchObject({ playerId: 'p2', wins: 1, gamesPlayed: 1 });
    expect(top.bestScore).toBeGreaterThan(0);
    back.engine?.dispose();
    room.engine?.dispose();
  });
});
