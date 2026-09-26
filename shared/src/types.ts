export type PlayerColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange';
export type TokenType = 'car' | 'hat' | 'dog' | 'ship' | 'thimble' | 'boot';

export type RoomStatus = 'waiting' | 'playing' | 'finished';

export type VictoryType = 'bankruptcy' | 'triple_victory' | 'line_victory';

// 'off' = landing on an opponent's built property is always just rent.
// 'developed' = classic LINE Get Rich rule: only built-up (house+) deeds can
// be force-bought, raw land cannot. 'any' = any owned deed can be forced,
// built or not.
export type ForceBuyMode = 'off' | 'developed' | 'any';

export interface RoomSettings {
  maxPlayers: number;
  specialVictory: boolean; // LINE Get Rich: Triple Victory & Line Victory enabled
  // Seconds per decision before the server plays the turn (0 = off).
  turnTimeoutSec: number;
  forceBuyMode: ForceBuyMode;
  // Occasional board-wide random events (Market Crash, Bank Bonus, ...).
  randomEvents: boolean;
}

export interface Seat {
  seatIndex: number; // 0..5
  playerId: string;
  displayName: string;
  tokenType: TokenType;
  color: PlayerColor;
  isReady: boolean;
  isConnected: boolean;
  isHost: boolean;
}

export interface RoomState {
  roomId: string;
  hostPlayerId: string;
  status: RoomStatus;
  settings: RoomSettings;
  seats: Seat[];
  winnerId: string | null;
  victoryType: VictoryType | null;
  // Server feature level (see PROTOCOL_VERSION); older servers omit it.
  protocol?: number;
}

/**
 * Bumped when client and server must be updated together (new lobby
 * settings, new events...). A client talking to an older server shows a
 * "server needs an update" notice instead of silently broken controls.
 */
export const PROTOCOL_VERSION = 2;

// Board & Tile types
export type TileGroup =
  | 'brown'
  | 'lightblue'
  | 'pink'
  | 'orange'
  | 'red'
  | 'yellow'
  | 'green'
  | 'darkblue'
  | 'railroad'
  | 'utility'
  | 'special';

export type TileType =
  | 'property'
  | 'railroad'
  | 'utility'
  | 'go'
  | 'jail'
  | 'gotojail'
  | 'parking'
  | 'chance'
  | 'chest'
  | 'tax';

export interface TileDef {
  index: number; // 0..39
  name: string;
  type: TileType;
  group: TileGroup;
  price: number; // 0 for non-purchasable
  // rentByLevel: index 0 = base rent, 1 = house, 2 = building, 3 = hotel, 4 = landmark
  rentByLevel: [number, number, number, number, number];
  buildCost: number; // cost per upgrade level (0 for non-buildable)
  country?: string; // ISO 3166 alpha-2 of the city's country (color sets)
}

// BuildLevel: 0 = unbuilt/raw land, 1 = house, 2 = building, 3 = hotel, 4 = landmark
export type BuildLevel = 0 | 1 | 2 | 3 | 4;

export interface PropertyState {
  tileIndex: number;
  ownerId: string | null;
  buildLevel: BuildLevel;
  isMortgaged: boolean;
  forceBought: boolean; // true if acquired via force-buy -> landmark LOCKED (cannot upgrade to 4)
  // The owner's lapsCompleted at the moment this was mortgaged. Once the
  // owner has gone another FORECLOSURE_ROUNDS laps without lifting it, the
  // Bank forecloses and auctions it off. Unset while not mortgaged.
  mortgagedAtLap?: number;
}

export interface PlayerState {
  playerId: string;
  seatIndex: number;
  name: string;
  color: PlayerColor;
  tokenType: TokenType;
  money: number;
  position: number; // 0..39
  inJail: boolean;
  jailTurns: number;
  jailCards: number; // get-out-of-jail-free cards held
  // Which deck each held jail card came from (returned there when used).
  jailCardDecks?: ('chance' | 'chest')[];
  isBankrupt: boolean;
  isConnected: boolean;
  consecutiveDoubles: number;
  // Times this player has passed / landed on GO. Building on land needs >= 1.
  lapsCompleted: number;
  // Voluntary mortgages taken this round (since the last time they passed
  // GO). Capped at MAX_MORTGAGES_PER_ROUND; resets to 0 when lapsCompleted
  // increments. Mortgages forced by an active debt don't count against it.
  mortgagesThisRound: number;
  // Left the game by surrendering (also counted as bankrupt).
  surrendered?: boolean;
  // Turns in a row the server had to play for this player (turn timer).
  timeouts?: number;
}

export type GamePhase =
  | 'ROLLING'
  | 'MOVING'
  | 'RESOLVING'
  | 'BUY_OFFER'
  | 'FORCE_BUY_OFFER'
  | 'DEBT'
  | 'AUCTION'
  | 'TURN_ENDED'
  | 'GAME_OVER';

export interface BuyOffer {
  tileIndex: number;
  price: number;
  buyerPlayerId: string;
}

export interface ForceBuyOffer {
  tileIndex: number;
  targetPlayerId: string; // the victim (owner)
  buyerPlayerId: string; // the active player landing
  price: number; // 2x total value
  currentBuildLevel: BuildLevel;
  expiresAt: number; // timestamp ms
}

// Pending payment the active player cannot afford yet.
// While debt is set, the game sits in DEBT phase: the debtor may sell
// buildings (or mortgage) to raise cash, then the debt auto-pays.
// creditorId null means the debt is owed to the bank (tax / cards).
export interface DebtOffer {
  amount: number;
  creditorId: string | null;
  reason: string;
  // Debt owed to several players at once ("pay each player $50"):
  // the amount is split between them when paid.
  splits?: { playerId: string; amount: number }[];
}

// Player-to-player trade proposal. `give*` flows from -> to, `get*` flows
// to -> from. Only unbuilt properties can change hands.
export interface TradeOffer {
  id: string;
  fromId: string;
  toId: string;
  giveMoney: number;
  giveProps: number[];
  getMoney: number;
  getProps: number[];
  createdAt: number;
  // Negotiation: 1 = first offer, +1 per counter-offer.
  round?: number;
  // Short note from the sender ("add $50 and it's yours").
  message?: string;
  // Earlier rounds, oldest first (terms as the sender of that round saw them).
  history?: TradeTerms[];
}

/** One round of a negotiation: `fromId` gives `give*` and asks for `get*`. */
export interface TradeTerms {
  fromId: string;
  toId: string;
  giveMoney: number;
  giveProps: number[];
  getMoney: number;
  getProps: number[];
  message?: string;
}

// A drawn Chance / Community Chest card, broadcast for the info modal.
export interface CardDraw {
  id: number; // increasing per draw (animations key on it)
  deck: 'chance' | 'chest';
  title: string;
  text: string;
  drawerId: string;
  // Extra line for dice-based cards, e.g. "Rolled 4 + 3: pay 10 x 7 = $70".
  detail?: string;
}

// ---------------------------------------------------------------- Bank
// Every money movement, for the bank statement. null = the Bank.
export interface BankTxn {
  id: number;
  ts: number;
  fromId: string | null;
  toId: string | null;
  amount: number;
  reason: string;
}

// The Bank owns the limited building supply (real Monopoly: 32 houses,
// 12 hotels) and keeps a ledger of the latest transactions.
export interface BankState {
  houses: number;
  hotels: number;
  ledger: BankTxn[];
  nextTxnId: number;
}

// Random board-wide event, rolled occasionally between turns. Only one is
// active at a time; it clears itself once turnNumber passes expiresAtTurn.
export type ActiveEventType = 'market_crash' | 'building_boom';

export interface ActiveEvent {
  type: ActiveEventType;
  label: string; // shown to players, e.g. "Market Crash! Rent halved"
  factor: number; // rent or build-cost multiplier while active
  expiresAtTurn: number;
}

// Bank auction of a property the landing player declined / could not afford.
export interface AuctionState {
  tileIndex: number;
  highBid: number;
  highBidderId: string | null;
  endsAt: number; // timestamp ms
  bidders: string[]; // players who placed at least one bid
}

// The last dice move, so clients can animate walk -> landing -> follow-up
// (e.g. walk onto Chance, show the card, then travel to the card target).
export interface MoveRecord {
  seq: number;
  playerId: string;
  from: number;
  landed: number; // tile the dice walk ends on
  to: number; // final tile after the landing resolved (card / go-to-jail)
  // The follow-up move (landed -> to) paid the GO salary.
  passedGo?: boolean;
}

export interface GameState {
  roomId: string;
  phase: GamePhase;
  turnNumber: number;
  currentPlayerIndex: number; // index into players array
  players: PlayerState[];
  properties: Record<number, PropertyState>; // key: tileIndex 0..39
  dice: [number, number];
  doubles: boolean;
  doublesCount: number;
  buyOffer: BuyOffer | null;
  forceBuyOffer: ForceBuyOffer | null;
  debt: DebtOffer | null;
  trades: TradeOffer[];
  lastMove: MoveRecord | null;
  bank: BankState;
  auction: AuctionState | null;
  activeEvent: ActiveEvent | null;
  winnerId: string | null;
  victoryType: VictoryType | null;
  lastActionText: string;
  // When the current decision times out (ms timestamp), null = no timer.
  turnDeadline?: number | null;
}

// Chat
export interface ChatMessage {
  id: string;
  senderName: string;
  senderColor: PlayerColor;
  text: string;
  timestamp: number;
}
