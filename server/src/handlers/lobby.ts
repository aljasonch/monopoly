import { Server, Socket } from 'socket.io';
import { ClientToServerEvents, ResumableGame, ServerToClientEvents } from '@monopoly/shared';
import { RoomManager, JoinResult, RoomSession, tokenMatches } from '../rooms.js';
import { broadcastRoom, wireEngine } from '../wire.js';
import type { VerifiedUser } from '../firebase.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;

export function registerLobbyHandlers(
  io: IO,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  roomManager: RoomManager
) {
  // A Firebase-verified account is the identity; otherwise the device id.
  const user = socket.data.user as VerifiedUser | null | undefined;
  const playerIdOf = () => user?.uid || (socket.handshake.query.playerId as string) || socket.id;
  const broadcast = (roomId: string) => broadcastRoom(io, roomManager, roomId);

  // Seat claimed: join the socket room, release older tabs, send the state.
  const seated = (result: JoinResult, playerId: string) => {
    const room = result.room!;
    if (user && user.uid === playerId && !user.anonymous) roomManager.markAccount(room.roomId, playerId);
    socket.join(room.roomId);
    for (const sid of result.replaced ?? []) {
      const old = io.sockets.sockets.get(sid);
      old?.emit('session:replaced');
      old?.leave(room.roomId);
    }
    return { ok: true, roomId: room.roomId, playerId, token: result.token };
  };
  // After the reply: everyone gets the new room state, the joiner the game.
  const announce = (result: JoinResult) => {
    const room = result.room!;
    broadcast(room.roomId);
    if (room.engine) socket.emit('game:state', room.engine.state);
  };

  socket.on('room:create', ({ name }, callback) => {
    const playerId = playerIdOf();
    const room = roomManager.createRoom(socket.id, playerId, String(name ?? '').slice(0, 15));
    if (user && !user.anonymous) roomManager.markAccount(room.roomId, playerId);
    socket.join(room.roomId);
    callback({ ok: true, roomId: room.roomId, playerId, token: room.hostToken });
    broadcast(room.roomId);
  });

  socket.on('room:join', ({ roomId, name, token }, callback) => {
    const playerId = playerIdOf();
    const result = roomManager.joinRoom(String(roomId ?? ''), socket.id, playerId, String(name ?? '').slice(0, 15), token, !!user);
    if (!result.ok || !result.room) return callback({ ok: false, error: result.error });
    callback(seated(result, playerId));
    announce(result);
  });

  socket.on('room:reconnect', ({ roomId, playerId, token, name }, callback) => {
    const verified = !!user && user.uid === playerId;
    const result = roomManager.reconnectSocket(socket.id, String(roomId ?? ''), playerId, token, name?.slice(0, 15), verified);
    if (!result.ok || !result.room) return callback({ ok: false, error: result.error || 'Reconnect failed' });
    callback(seated(result, playerId));
    announce(result);
  });

  socket.on('leaderboard:get', async (callback) => {
    if (typeof callback !== 'function') return;
    callback(await roomManager.leaderboard(20));
  });

  socket.on('session:list', ({ sessions }, callback) => {
    if (typeof callback !== 'function') return;
    const found = new Map<string, ResumableGame>();
    const describe = (room: RoomSession, playerId: string, token?: string): ResumableGame => {
      const seat = room.seats.find((s) => s.playerId === playerId);
      return {
        roomId: room.roomId,
        playerId,
        token,
        status: room.status,
        myName: seat?.displayName ?? '',
        players: room.seats.map((s) => s.displayName),
        turnNumber: room.engine?.state.turnNumber ?? null,
        updatedAt: room.lastSeenAt
      };
    };
    for (const s of (Array.isArray(sessions) ? sessions : []).slice(0, 10)) {
      const room = roomManager.getRoom(String(s.roomId ?? ''));
      if (room && room.status !== 'finished' && tokenMatches(room.tokens[s.playerId], s.token)) {
        found.set(room.roomId, describe(room, s.playerId, s.token));
      }
    }
    if (user) {
      for (const room of roomManager.roomsOf(user.uid)) {
        if (!found.has(room.roomId)) found.set(room.roomId, describe(room, user.uid, room.tokens[user.uid]));
      }
    }
    callback([...found.values()].sort((a, b) => b.updatedAt - a.updatedAt));
  });

  socket.on('room:selectToken', ({ tokenType, color }) => {
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) return;
    if (roomManager.selectToken(info.roomId, info.playerId, tokenType, color)) broadcast(info.roomId);
  });

  socket.on('room:ready', ({ ready }) => {
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) return;
    if (roomManager.toggleReady(info.roomId, info.playerId, ready)) broadcast(info.roomId);
  });

  socket.on('room:toggleSpecialVictory', ({ enabled }) => {
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) return;
    if (roomManager.toggleSpecialVictory(info.roomId, info.playerId, enabled)) broadcast(info.roomId);
  });

  socket.on('room:setTurnTimer', ({ seconds }) => {
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) return;
    if (roomManager.setTurnTimer(info.roomId, info.playerId, Number(seconds))) broadcast(info.roomId);
  });

  socket.on('room:setForceBuyMode', ({ mode }) => {
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) return;
    if (roomManager.setForceBuyMode(info.roomId, info.playerId, mode)) broadcast(info.roomId);
  });

  socket.on('room:setRandomEvents', ({ enabled }) => {
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) return;
    if (roomManager.setRandomEvents(info.roomId, info.playerId, enabled)) broadcast(info.roomId);
  });

  socket.on('room:kick', ({ playerId }) => {
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) return;
    const res = roomManager.kick(info.roomId, info.playerId, playerId);
    if (!res.ok) return socket.emit('error', { message: res.error || 'Could not remove that player' });
    for (const sid of res.sockets ?? []) {
      const s = io.sockets.sockets.get(sid);
      s?.emit('room:kicked');
      s?.leave(info.roomId);
    }
    broadcast(info.roomId);
  });

  socket.on('room:start', () => {
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) return;
    const res = roomManager.startGame(info.roomId, info.playerId);
    if (!res.ok || !res.engine) {
      return socket.emit('error', { message: res.error || 'Failed to start game' });
    }
    wireEngine(io, roomManager, info.roomId);
    broadcast(info.roomId);
    io.to(info.roomId).emit('game:state', res.engine.state);
  });

  socket.on('room:leave', (...args: unknown[]) => {
    const callback = args.find((a) => typeof a === 'function') as
      | ((res: { ok: boolean; error?: string }) => void)
      | undefined;
    const info = roomManager.getPlayerBySocket(socket.id);
    if (!info) {
      callback?.({ ok: true });
      return;
    }
    const others = roomManager.socketsOf(info.roomId, info.playerId).filter((sid) => sid !== socket.id);
    // Leave the broadcast room first: the leaver gets no more game updates.
    socket.leave(info.roomId);
    const result = roomManager.leaveRoom(socket.id);
    // Other tabs of the same player leave too.
    for (const sid of others) {
      const s = io.sockets.sockets.get(sid);
      s?.emit('room:kicked');
      s?.leave(info.roomId);
    }
    if (result.room) broadcast(result.room.roomId);
    callback?.({ ok: true });
  });
}
