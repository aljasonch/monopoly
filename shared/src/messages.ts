import {
  RoomState,
  GameState,
  ChatMessage,
  TokenType,
  PlayerColor,
  VictoryType,
  ForceBuyOffer,
  ForceBuyMode,
  CardDraw,
  TradeOffer
} from './types.js';

// Reply to create / join / reconnect: the seat and its secret token.
export interface SeatResponse {
  ok: boolean;
  error?: string;
  roomId?: string;
  playerId?: string;
  token?: string;
}

export interface ResumableGame {
  roomId: string;
  playerId: string;
  token?: string;
  status: 'waiting' | 'playing' | 'finished';
  myName: string;
  players: string[];
  turnNumber: number | null;
  updatedAt: number;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  wins: number;
  gamesPlayed: number;
  // Highest net worth at the end of any game.
  bestScore: number;
  // Signed in with an account (stats follow them across devices).
  account: boolean;
}

export type TradeProposal = Omit<TradeOffer, 'id' | 'fromId' | 'createdAt' | 'round' | 'history'>;

// Client -> Server events
export interface ClientToServerEvents {
  // Room/Lobby
  'room:create': (payload: { name: string }, callback: (res: SeatResponse) => void) => void;
  // `token` reclaims your own seat (reload / second tab / resume).
  'room:join': (payload: { roomId: string; name: string; token?: string }, callback: (res: SeatResponse) => void) => void;
  'room:selectToken': (payload: { tokenType: TokenType; color: PlayerColor }) => void;
  'room:ready': (payload: { ready: boolean }) => void;
  'room:toggleSpecialVictory': (payload: { enabled: boolean }) => void;
  'room:setTurnTimer': (payload: { seconds: number }) => void;
  'room:setForceBuyMode': (payload: { mode: ForceBuyMode }) => void;
  'room:setRandomEvents': (payload: { enabled: boolean }) => void;
  'room:kick': (payload: { playerId: string }) => void;
  'room:start': () => void;
  'room:reconnect': (
    payload: { roomId: string; playerId: string; token?: string; name?: string },
    callback: (res: SeatResponse) => void
  ) => void;
  'room:leave': (callback?: (res: { ok: boolean; error?: string }) => void) => void;
  // Games this player can go back to (saved seat tokens, or a signed-in
  // account's seats on any device).
  'leaderboard:get': (callback: (entries: LeaderboardEntry[]) => void) => void;
  'session:list': (
    payload: { sessions: { roomId: string; playerId: string; token: string }[] },
    callback: (games: ResumableGame[]) => void
  ) => void;

  // In-Game
  'game:roll': () => void;
  'game:payJail': () => void;
  'game:useJailCard': () => void;
  'game:buyResponse': (payload: { accept: boolean }) => void;
  'game:forceBuyResponse': (payload: { accept: boolean }) => void;
  'game:build': (payload: { tileIndex: number }) => void;
  'game:sell': (payload: { tileIndex: number; toLevel?: number }) => void;
  'game:sellProperty': (payload: { tileIndex: number }) => void;
  'game:declareBankruptcy': () => void;
  // Give up (any time): everything goes back to the Bank, you can watch on.
  'game:surrender': () => void;
  'game:mortgage': (payload: { tileIndex: number; mortgage: boolean }) => void;
  'game:endTurn': () => void;
  'auction:bid': (payload: { amount: number }) => void;
  'trade:propose': (payload: TradeProposal) => void;
  'trade:respond': (payload: { tradeId: string; accept: boolean }) => void;
  'trade:cancel': (payload: { tradeId: string }) => void;
  // The receiver sends back changed terms (from their own point of view:
  // give = what they give, get = what they ask for).
  'trade:counter': (payload: { tradeId: string; proposal: TradeProposal }) => void;

  // Chat
  'chat:send': (payload: { text: string }) => void;
}

// Server -> Client events
export interface ServerToClientEvents {
  'room:state': (state: RoomState) => void;
  'game:state': (state: GameState) => void;
  'game:dice': (payload: { d1: number; d2: number; doubles: boolean }) => void;
  'game:card': (draw: CardDraw) => void;
  'game:forceBuyOffer': (offer: ForceBuyOffer) => void;
  'game:toast': (payload: { text: string; type?: 'info' | 'success' | 'warning' | 'danger' }) => void;
  // A random board-wide event fired: shown as a big centered banner, not a
  // corner toast, and held on screen long enough to actually read.
  'game:randomEvent': (payload: { text: string; type?: 'info' | 'success' | 'warning' | 'danger' }) => void;
  'game:ended': (payload: { winnerId: string; victoryType: VictoryType }) => void;
  'chat:message': (message: ChatMessage) => void;
  // This seat was opened in another tab / device.
  'session:replaced': () => void;
  // The host removed you from the lobby.
  'room:kicked': () => void;
  'error': (payload: { message: string }) => void;
}
