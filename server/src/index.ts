import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import compression from 'compression';
import { Server } from 'socket.io';
import {
  PROTOCOL_VERSION,
  ClientToServerEvents,
  ServerToClientEvents
} from '@monopoly/shared';
import { ProfileStore, RoomManager } from './rooms.js';
import { FileRoomStore } from './store/fileStore.js';
import { broadcastRoom, wireEngine } from './wire.js';
import { verifyIdToken } from './firebase.js';
import { registerLobbyHandlers } from './handlers/lobby.js';
import { registerGameHandlers } from './handlers/gameplay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// One .env at the repo root configures server and client (see .env.example).
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = parseInt(process.env.PORT || '5000', 10);

const app = express();
app.use(cors());
// Allow Firebase's Google sign-in popup to be tracked by this window; without
// this, Chrome's default cross-origin isolation blocks the popup-closed
// check Firebase relies on (logs as "window.closed"/"window.close" COOP
// warnings and can leave the sign-in stuck).
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});
// gzip everything (JS, CSS, glTF, SVG): big win over a Cloudflare tunnel / 4G.
app.use(compression());
app.use(express.json());

// Serve static build from client/dist (for local play / single-origin tunnel).
// Hashed build assets never change: cache them for a year. Models / icons for
// a week. index.html and the service worker must always be re-checked.
const clientDistPath = path.resolve(__dirname, '../../client/dist');
app.use(
  express.static(clientDistPath, {
    setHeaders(res, filePath) {
      const rel = path.relative(clientDistPath, filePath).split(path.sep).join('/');
      if (rel.startsWith('assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else if (rel.startsWith('models/') || rel.startsWith('icons/') || rel.startsWith('audio/')) res.setHeader('Cache-Control', 'public, max-age=604800');
      else res.setHeader('Cache-Control', 'no-cache');
    }
  })
);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: Date.now(), protocol: PROTOCOL_VERSION });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
    if (err) {
      res.status(200).send('TMpoly server is running. Build the client to view the UI.');
    }
  });
});

const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Running games are saved on this server (JSON files, ROOMS_DIR) so they
// survive restarts; PERSIST=off keeps them in memory only. Player stats for
// the leaderboard go to Firestore when Firebase is configured, otherwise to
// a local history file.
const fileStore =
  process.env.PERSIST === 'off' ? undefined : new FileRoomStore(process.env.ROOMS_DIR || path.resolve(__dirname, '../data/rooms'));
if (fileStore) console.log('Rooms are saved to', process.env.ROOMS_DIR || path.resolve(__dirname, '../data/rooms'));

async function createProfiles(): Promise<ProfileStore | undefined> {
  if (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const { FirestoreProfiles } = await import('./store/firestoreProfiles.js');
      const profiles = await FirestoreProfiles.create();
      console.log('Player stats are saved to Firestore');
      return profiles;
    } catch (e) {
      console.warn('Firestore unavailable, keeping stats locally:', (e as Error).message);
    }
  }
  return fileStore;
}

const roomManager = new RoomManager(fileStore, await createProfiles());

// Firebase sign-in (optional): a valid ID token makes the account uid the
// player's identity. Invalid / missing tokens just play as guests.
io.use(async (socket, next) => {
  socket.data.user = await verifyIdToken(socket.handshake.auth?.idToken as string | undefined);
  next();
});

io.on('connection', (socket) => {
  registerLobbyHandlers(io, socket, roomManager);
  registerGameHandlers(io, socket, roomManager);

  socket.on('disconnect', () => {
    const { room } = roomManager.handleDisconnect(socket.id);
    if (room) broadcastRoom(io, roomManager, room.roomId);
  });
});

// Games in progress come back after a restart; players rejoin with their
// saved seat token.
for (const room of await roomManager.restore()) wireEngine(io, roomManager, room.roomId);
const restoredCount = roomManager.allRooms().length;
if (restoredCount) console.log(`Restored ${restoredCount} room(s)`);

// Idle / finished rooms are cleaned up.
setInterval(() => {
  const removed = roomManager.sweep();
  if (removed.length) console.log(`Closed idle rooms: ${removed.join(', ')}`);
}, 60_000).unref();

// Save everything before exiting (deploys send SIGTERM).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await roomManager.flush().catch(() => undefined);
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`TMpoly Server running on http://localhost:${PORT}`);
});
