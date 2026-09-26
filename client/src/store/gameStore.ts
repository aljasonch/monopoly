import { create } from 'zustand';
import {
  GameState,
  RoomState,
  ChatMessage,
  BuyOffer,
  ForceBuyOffer,
  VictoryType,
  CardDraw,
  GO_SALARY
} from '@monopoly/shared';
import { socket, currentPlayerId, clearSession } from '../net/socket.js';
import { audioManager } from '../sound/audioManager.js';

export interface ToastMessage {
  id: string;
  text: string;
  type: 'info' | 'success' | 'warning' | 'danger';
}

export interface ActivityEntry {
  id: string;
  text: string;
  type: ToastMessage['type'];
  timestamp: number;
}

interface GameStore {
  myPlayerId: string;
  roomState: RoomState | null;
  // What the UI shows: rawGame with balances / bankruptcy held at their
  // pre-roll values until the token has finished walking (see moneyHold).
  gameState: GameState | null;
  // Latest authoritative state from the server.
  rawGame: GameState | null;
  moneyHold: Record<string, { money: number; isBankrupt: boolean }> | null;
  diceRoll: { d1: number; d2: number; doubles: boolean } | null;
  buyOffer: BuyOffer | null;
  forceBuyOffer: ForceBuyOffer | null;
  isWalking: boolean;
  // Token paused on the tile it rolled onto before a follow-up move
  // (card target / go-to-jail): events for that landing may show now.
  walkPaused: boolean;
  // Latest event line for the compact mobile ticker.
  ticker: ToastMessage | null;
  // Incoming trade ids the player chose to look at later.
  snoozedTrades: string[];
  // Desktop: right panel collapsed into the compact dock.
  panelCollapsed: boolean;
  // Debt planner shrunk to a pill so the player can look at the board.
  debtMinimized: boolean;
  // Tile highlighted on the 3D board (planner card / tile info).
  focusTile: number | null;
  // Tile whose detail sheet is open.
  infoTile: number | null;
  // Latest "passed GO" celebration (3D coin burst + banner).
  goCelebration: { id: number; playerId: string } | null;
  // Latest random board event (Market Crash, Bank Bonus, ...): a big
  // centered banner, held on screen long enough to actually read.
  eventBanner: { id: number; text: string; type: ToastMessage['type'] } | null;
  // Auction the player closed with "Not interested" (see auctionKey).
  dismissedAuction: string | null;
  chatMessages: ChatMessage[];
  // Messages from other players received so far (drives unread badges and
  // the chat preview bubbles; unaffected by the history cap).
  chatFromOthers: number;
  chatPreview: { id: string; msg: ChatMessage }[];
  toasts: ToastMessage[];
  winner: { winnerId: string; victoryType: VictoryType } | null;
  cardDraw: CardDraw | null;
  activity: ActivityEntry[];

  // This seat was opened in another tab / device.
  replaced: boolean;
  // Socket connection is down (shows a reconnect banner in game).
  offline: boolean;
  leaderboardOpen: boolean;

  // Actions
  setMyPlayerId: (id: string) => void;
  setReplaced: (v: boolean) => void;
  setLeaderboardOpen: (v: boolean) => void;
  setRoomState: (room: RoomState) => void;
  setGameState: (game: GameState) => void;
  releaseMoneyHold: () => void;
  setDiceRoll: (dice: { d1: number; d2: number; doubles: boolean }) => void;
  setBuyOffer: (offer: BuyOffer | null) => void;
  setForceBuyOffer: (offer: ForceBuyOffer | null) => void;
  setCardDraw: (draw: CardDraw | null) => void;
  setIsWalking: (isWalking: boolean) => void;
  setWalkPaused: (paused: boolean) => void;
  snoozeTrade: (id: string) => void;
  setPanelCollapsed: (collapsed: boolean) => void;
  setDismissedAuction: (key: string | null) => void;
  celebrateGo: (playerId: string) => void;
  celebrateEvent: (text: string, type?: ToastMessage['type']) => void;
  setDebtMinimized: (v: boolean) => void;
  setFocusTile: (tile: number | null) => void;
  setInfoTile: (tile: number | null) => void;
  addChatMessage: (msg: ChatMessage, fromOther?: boolean) => void;
  addToast: (text: string, type?: 'info' | 'success' | 'warning' | 'danger') => void;
  removeToast: (id: string) => void;
  setWinner: (winner: { winnerId: string; victoryType: VictoryType } | null) => void;
  pushActivity: (text: string, type?: ToastMessage['type']) => void;
  resetAll: () => void;
}

// Per-device UI preferences; storage can be unavailable (private mode).
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export const useGameStore = create<GameStore>((set) => ({
  myPlayerId: currentPlayerId(),
  roomState: null,
  gameState: null,
  rawGame: null,
  moneyHold: null,
  diceRoll: null,
  buyOffer: null,
  forceBuyOffer: null,
  isWalking: false,
  walkPaused: false,
  ticker: null,
  snoozedTrades: [],
  panelCollapsed: readPref('ui.panelCollapsed') === '1',
  dismissedAuction: null,
  goCelebration: null,
  eventBanner: null,
  debtMinimized: false,
  focusTile: null,
  infoTile: null,
  chatMessages: [],
  chatFromOthers: 0,
  chatPreview: [],
  toasts: [],
  winner: null,
  cardDraw: null,
  activity: [],

  replaced: false,
  offline: false,
  leaderboardOpen: false,
  setLeaderboardOpen: (leaderboardOpen) => set({ leaderboardOpen }),
  setMyPlayerId: (myPlayerId) => set({ myPlayerId }),
  setReplaced: (replaced) => set({ replaced }),
  setRoomState: (roomState) => set({ roomState }),
  setGameState: (gameState) =>
    set((s) => {
      // A new dice move: keep showing the balances from before the roll until
      // the walk ends, so rent / tax / salary land when the token does.
      const newMove =
        !!s.rawGame && !!gameState.lastMove && gameState.lastMove.seq !== s.rawGame.lastMove?.seq;
      let moneyHold = s.moneyHold;
      if (newMove && !moneyHold && s.gameState) {
        moneyHold = Object.fromEntries(
          s.gameState.players.map((p) => [p.playerId, { money: p.money, isBankrupt: p.isBankrupt }])
        );
        scheduleHoldCheck();
      }
      if (gameState.phase === 'GAME_OVER') moneyHold = null;
      return {
        rawGame: gameState,
        moneyHold,
        gameState: present(gameState, moneyHold),
        buyOffer: gameState.buyOffer,
        forceBuyOffer: gameState.forceBuyOffer,
        // Persist winner locally so a tab reload during GAME_OVER still shows
        // the victory overlay (the server only emits game:ended on transition).
        winner:
          gameState.phase === 'GAME_OVER' && gameState.winnerId && gameState.victoryType
            ? { winnerId: gameState.winnerId, victoryType: gameState.victoryType }
            : s.winner,
      };
    }),
  releaseMoneyHold: () =>
    set((s) => (s.moneyHold ? { moneyHold: null, gameState: s.rawGame } : s)),
  setDiceRoll: (diceRoll) => set({ diceRoll }),
  setBuyOffer: (buyOffer) => set({ buyOffer }),
  setForceBuyOffer: (forceBuyOffer) => set({ forceBuyOffer }),
  setCardDraw: (cardDraw) => set({ cardDraw }),
  setIsWalking: (isWalking) =>
    set((s) => (isWalking || !s.moneyHold ? { isWalking } : { isWalking, moneyHold: null, gameState: s.rawGame })),
  // Paused on the landing tile: that landing's money changes may show now.
  setWalkPaused: (walkPaused) =>
    set((s) => (!walkPaused || !s.moneyHold ? { walkPaused } : { walkPaused, moneyHold: null, gameState: s.rawGame })),
  setPanelCollapsed: (panelCollapsed) => {
    writePref('ui.panelCollapsed', panelCollapsed ? '1' : '0');
    set({ panelCollapsed });
  },
  setDismissedAuction: (dismissedAuction) => set({ dismissedAuction }),
  setDebtMinimized: (debtMinimized) => set({ debtMinimized }),
  setFocusTile: (focusTile) => set({ focusTile }),
  setInfoTile: (infoTile) => set({ infoTile, focusTile: infoTile }),
  celebrateGo: (playerId) => {
    audioManager.playCoin();
    setTimeout(() => audioManager.playBuy(), 180);
    set((s) => {
      const goCelebration = { id: (s.goCelebration?.id ?? 0) + 1, playerId };
      const held = s.moneyHold?.[playerId];
      if (!s.moneyHold || !held || !s.rawGame) return { goCelebration };
      // The salary is paid the moment the token passes GO.
      const moneyHold = { ...s.moneyHold, [playerId]: { ...held, money: held.money + GO_SALARY } };
      return { goCelebration, moneyHold, gameState: present(s.rawGame, moneyHold) };
    });
  },
  celebrateEvent: (text, type = 'info') => {
    if (type === 'success') audioManager.playCoin();
    else audioManager.playModal();
    set((s) => ({ eventBanner: { id: (s.eventBanner?.id ?? 0) + 1, text, type } }));
  },
  snoozeTrade: (id) => set((s) => ({ snoozedTrades: [...s.snoozedTrades, id] })),
  addChatMessage: (msg, fromOther = false) =>
    set((s) => ({
      chatMessages: [...s.chatMessages.slice(-50), msg],
      chatFromOthers: s.chatFromOthers + (fromOther ? 1 : 0),
      // Latest few messages from others for the preview bubbles.
      chatPreview: fromOther ? [...s.chatPreview, { id: msg.id, msg }].slice(-3) : s.chatPreview,
    })),
  addToast: (text, type = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    // Keep the stack short so it never covers the board.
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, type }], ticker: { id, text, type } }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4500);
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setWinner: (winner) => set({ winner }),
  pushActivity: (text, type = 'info') =>
    set((s) => {
      // The server often sends the same line as a toast and as lastActionText.
      if (!text || s.activity.slice(-4).some((a) => a.text === text)) return s;
      const entry = { id: Math.random().toString(36).substring(2, 9), text, type, timestamp: Date.now() };
      return { activity: [...s.activity.slice(-99), entry] };
    }),
  resetAll: () =>
    set({
      roomState: null,
      gameState: null,
      rawGame: null,
      moneyHold: null,
      diceRoll: null,
      forceBuyOffer: null,
      cardDraw: null,
      chatMessages: [],
      chatFromOthers: 0,
      chatPreview: [],
      activity: [],
      snoozedTrades: [],
      ticker: null,
      goCelebration: null,
      eventBanner: null,
      focusTile: null,
      infoTile: null,
      isWalking: false,
      walkPaused: false,
      buyOffer: null,
      winner: null,
      replaced: false,
    }),
}));

function present(
  game: GameState,
  hold: Record<string, { money: number; isBankrupt: boolean }> | null
): GameState {
  if (!hold) return game;
  return {
    ...game,
    players: game.players.map((p) => {
      const h = hold[p.playerId];
      return h ? { ...p, money: h.money, isBankrupt: h.isBankrupt } : p;
    }),
  };
}

// Release the hold if no walk starts (e.g. rolled into jail without moving),
// and never keep it longer than a long walk could take.
let holdGen = 0;
function scheduleHoldCheck() {
  const gen = ++holdGen;
  setTimeout(() => {
    if (gen !== holdGen) return;
    const s = useGameStore.getState();
    if (s.moneyHold && !s.isWalking) s.releaseMoneyHold();
  }, 700);
  setTimeout(() => gen === holdGen && useGameStore.getState().releaseMoneyHold(), 20000);
}

// ------------------------------------------------------------------
// Event gate: the server sends landing toasts and Chance/Chest cards the
// moment dice are rolled, before the token has walked there. Hold them until
// the walk finishes (or pauses on the landing tile) so nothing is spoiled.
// ------------------------------------------------------------------
const eventQueue: (() => void)[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let waitUnsub: (() => void) | null = null;

function flushEvents() {
  waitUnsub?.();
  waitUnsub = null;
  const batch = eventQueue.splice(0);
  batch.forEach((fn) => fn());
}

function settled(s: GameStore) {
  return !s.isWalking || s.walkPaused;
}

function enqueueEvent(fn: () => void) {
  eventQueue.push(fn);
  if (flushTimer || waitUnsub) return;
  // Give the matching game:state / game:dice a moment to start the walk.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (settled(useGameStore.getState())) return flushEvents();
    const safety = setTimeout(flushEvents, 15000);
    const unsub = useGameStore.subscribe((s) => {
      if (settled(s)) {
        clearTimeout(safety);
        flushEvents();
      }
    });
    waitUnsub = () => {
      clearTimeout(safety);
      unsub();
    };
  }, 260);
}

// Setup global socket event bindings into store (idempotent: safe under StrictMode)
let listenersInitialized = false;

export function initSocketListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;
  registerLateListeners();

  socket.on('room:state', (room) => {
    const prev = useGameStore.getState().roomState;
    useGameStore.getState().setRoomState(room);
    // Soft cues when others join / leave / drop / come back.
    if (!prev || prev.roomId !== room.roomId) return;
    const myId = useGameStore.getState().myPlayerId;
    const was = new Map(prev.seats.map((s) => [s.playerId, s.isConnected]));
    const now = new Map(room.seats.map((s) => [s.playerId, s.isConnected]));
    let joined = false;
    let left = false;
    for (const [id, conn] of now) {
      if (id === myId) continue;
      if (!was.has(id) || (conn && was.get(id) === false)) joined = true;
      else if (!conn && was.get(id)) left = true;
    }
    for (const id of was.keys()) if (id !== myId && !now.has(id)) left = true;
    if (joined) audioManager.playJoin();
    else if (left) audioManager.playLeave();
  });

  socket.on('connect', () => useGameStore.setState({ offline: false }));
  socket.on('disconnect', () => useGameStore.setState({ offline: true }));

  socket.on('session:replaced', () => {
    useGameStore.getState().setReplaced(true);
  });

  socket.on('room:kicked', () => {
    const st = useGameStore.getState();
    clearSession();
    st.resetAll();
    st.addToast('You left the room (removed by the host or from another tab).', 'warning');
  });

  socket.on('game:state', (game) => {
    const prev = useGameStore.getState();
    // Late updates after leaving a room are ignored.
    if (!prev.roomState || prev.roomState.roomId !== game.roomId) return;
    const prevGame = prev.rawGame;
    const myId = prev.myPlayerId;
    prev.setGameState(game);
    if (game.lastActionText && game.lastActionText !== prevGame?.lastActionText) {
      const text = game.lastActionText;
      enqueueEvent(() => useGameStore.getState().pushActivity(text));
    }

    // Transition sounds only for live updates, not the first sync after
    // (re)connect — otherwise a reload replays every sound at once.
    if (!prevGame) return;

    const wasMine = (pid: string | undefined) => pid === myId;

    // Buy / force-buy offers addressed to me
    if (!prevGame.buyOffer && game.buyOffer && wasMine(game.buyOffer.buyerPlayerId)) {
      audioManager.playModal();
    }
    if (!prevGame.forceBuyOffer && game.forceBuyOffer && wasMine(game.forceBuyOffer.buyerPlayerId)) {
      audioManager.playForceBuyAlarm();
    }

    // The Bank opened an auction
    if (prevGame.phase !== 'AUCTION' && game.phase === 'AUCTION') {
      audioManager.playModal();
    }

    // My turn begins (after the previous token finished walking).
    const curNow = game.players[game.currentPlayerIndex];
    const prevCur = prevGame.players[prevGame.currentPlayerIndex];
    if (curNow?.playerId === myId && (prevCur?.playerId !== myId || prevGame.turnNumber !== game.turnNumber) && game.phase === 'ROLLING') {
      enqueueEvent(() => audioManager.playMyTurn());
    }

    // Someone was sent to jail
    const jailed = game.players.some((p) => p.inJail && !prevGame.players.find((q) => q.playerId === p.playerId)?.inJail);
    if (jailed) enqueueEvent(() => audioManager.playJail());

    // Debt entered and I am the debtor
    const cur = game.players[game.currentPlayerIndex];
    if (prevGame.phase !== 'DEBT' && game.phase === 'DEBT' && cur?.playerId === myId) {
      enqueueEvent(() => audioManager.playDebtAlarm());
    }

    // I went bankrupt
    const prevMe = prevGame.players.find((p) => p.playerId === myId);
    const nextMe = game.players.find((p) => p.playerId === myId);
    if (prevMe && !prevMe.isBankrupt && nextMe?.isBankrupt) {
      enqueueEvent(() => audioManager.playBankrupt());
    }

    // My buildings changed level (upgrade / sell)
    if (prevMe && nextMe) {
      for (const [idx, prop] of Object.entries(game.properties)) {
        if (prop.ownerId !== myId) continue;
        const before = prevGame.properties[Number(idx)]?.buildLevel ?? 0;
        if (prop.buildLevel > before) audioManager.playBuild();
        else if (prop.buildLevel < before) audioManager.playSell();
      }
    }
  });

  socket.on('game:dice', (dice) => {
    useGameStore.getState().setDiceRoll(dice);
  });

  socket.on('game:card', (draw) => {
    enqueueEvent(() => {
      useGameStore.getState().setCardDraw(draw);
      audioManager.playCardDraw();
    });
  });

  socket.on('game:forceBuyOffer', (offer) => {
    useGameStore.getState().setForceBuyOffer(offer);
  });

  socket.on('game:toast', ({ text, type }) => {
    enqueueEvent(() => showGameToast(text, type));
  });

  // Random board events get their own big centered banner instead of a
  // corner toast, still logged to the activity tab like anything else.
  socket.on('game:randomEvent', ({ text, type }) => {
    enqueueEvent(() => {
      useGameStore.getState().pushActivity(text, type ?? 'info');
      useGameStore.getState().celebrateEvent(text, type);
    });
  });
}

function showGameToast(text: string, type?: ToastMessage['type']) {
  useGameStore.getState().addToast(text, type);
  useGameStore.getState().pushActivity(text, type ?? 'info');
  // Debt entry already plays the debt alarm via the DEBT phase change,
  // and bankruptcy plays its own dirge via the state change — the toasts
  // for those arrive alongside, so skip them here to avoid stacking.
  const coveredByStateSound = /owes \$|cannot afford|cannot pay|bankrupt|game over|arrested|jail/i.test(text);
  const st = useGameStore.getState();
  const myName = st.gameState?.players.find((p) => p.playerId === st.myPlayerId)?.name;
  const rent = /^(.+?) paid \$\d+ rent to (.+?)\.$/.exec(text) ?? /^(.+?) declined force-buy\. Paid \$\d+ rent to (.+?)\.$/.exec(text);
  if (rent && myName && (rent[1] === myName || rent[2] === myName)) {
    if (rent[1] === myName) audioManager.playRentPaid();
    else audioManager.playRentReceived();
    return;
  }
  if (/surrendered|left the game/i.test(text)) return audioManager.playSurrender();
  if (/^It is now .+'s turn\.$/.test(text)) return; // my-turn cue / silence
  if (type === 'success' && myName && !text.startsWith(myName) && /bought|completed a trade|wins .* at auction/i.test(text)) {
    return audioManager.playSoftDeal();
  }
  if (type === 'success') audioManager.playCoin();
  else if (type === 'danger' && !coveredByStateSound) audioManager.playError();
  else if (type === 'warning' && !coveredByStateSound) audioManager.playModal();
  else if (!type || type === 'info') audioManager.playTick();
}

function registerLateListeners() {
  socket.on('game:ended', (winner) => {
    useGameStore.getState().setWinner(winner);
    audioManager.playVictory();
  });

  socket.on('chat:message', (msg) => {
    const st = useGameStore.getState();
    // Skip the echo of my own messages.
    const mySeat = st.roomState?.seats.find((s) => s.playerId === st.myPlayerId);
    const fromOther = !mySeat || msg.senderName !== mySeat.displayName;
    st.addChatMessage(msg, fromOther);
    if (fromOther) audioManager.playChat();
  });

  socket.on('error', ({ message }) => {
    useGameStore.getState().addToast(message, 'danger');
    audioManager.playError();
  });
}

// Dev-only hook for browser tests (stripped from production builds).
if (import.meta.env.DEV) (window as unknown as { __game: typeof useGameStore }).__game = useGameStore;
