import {
  BOARD_TILES,
  CHANCE_CARDS,
  CHEST_CARDS,
  GO_SALARY,
  JAIL_FINE,
  JAIL_TILE_INDEX,
  STARTING_MONEY,
  AUCTION_EXTEND_MS,
  AUCTION_MIN_INCREMENT,
  AUCTION_MS,
  FORECLOSURE_ROUNDS,
  MAX_MORTGAGES_PER_ROUND,
  CardDef,
  CardDraw,
  DebtOffer,
  ForceBuyMode,
  GameState,
  PlayerState,
  PropertyState,
  Seat,
  TradeOffer,
  TradeProposal,
  TradeTerms,
  mortgageBlockReason,
  tradeBlockReason,
  tradeMortgageFees
} from '@monopoly/shared';
import { executeForceBuy } from './forceBuy.js';
import { buildProperty, sellBuilding, sellPropertyToBank, toggleMortgage } from './actions.js';
import { applyBankruptcy } from './rent.js';
import { resolveLanding } from './resolve.js';
import { createBank, record } from './bank.js';
import { checkVictory } from './victory.js';

// Fisher-Yates: a fair shuffle (sort(() => random) is biased).
function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Between turns, there's a small chance something happens to the whole
// board: a rough 1-in-6 roll, and never more than one event at a time.
const RANDOM_EVENT_CHANCE = 1 / 6;
const RANDOM_EVENT_DURATION_TURNS = 6;
type RandomEventKind =
  | 'property_lottery'
  | 'market_crash'
  | 'building_boom'
  | 'bank_bonus'
  | 'leaders_tax';

export interface GameEngineOptions {
  specialVictory: boolean;
  // Seconds per decision before the server plays for the current player
  // (0 / undefined = no turn timer).
  turnTimerSec?: number;
  // Opt in to the occasional board-wide random events (Market Crash, Bank
  // Bonus, ...). Off by default so unit tests stay deterministic.
  randomEvents?: boolean;
  // 'off' | 'developed' (classic, default) | 'any' (raw land too).
  forceBuyMode?: ForceBuyMode;
  onStateChange?: (state: GameState) => void;
  onToast?: (toast: { text: string; type?: 'info' | 'success' | 'warning' | 'danger' }) => void;
  // A random event fired: shown as its own big banner client-side, in
  // addition to the normal toast / activity log line.
  onRandomEvent?: (toast: { text: string; type?: 'info' | 'success' | 'warning' | 'danger' }) => void;
  onCard?: (draw: CardDraw) => void;
  // Dice the server rolled for a player whose time ran out.
  onDice?: (dice: { d1: number; d2: number; doubles: boolean }) => void;
}

export class MonopolyGameEngine {
  public state: GameState;
  public options: GameEngineOptions;
  private chanceDeck: CardDef[];
  private chestDeck: CardDef[];
  private forceBuyTimer: NodeJS.Timeout | null = null;
  private auctionTimer: NodeJS.Timeout | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private turnKey = '';

  constructor(roomId: string, seats: Seat[], options: GameEngineOptions) {
    this.options = options;

    const players: PlayerState[] = seats.map((seat) => ({
      playerId: seat.playerId,
      seatIndex: seat.seatIndex,
      name: seat.displayName,
      color: seat.color,
      tokenType: seat.tokenType,
      money: STARTING_MONEY,
      position: 0,
      inJail: false,
      jailTurns: 0,
      jailCards: 0,
      isBankrupt: false,
      isConnected: true,
      consecutiveDoubles: 0,
      lapsCompleted: 0,
      mortgagesThisRound: 0,
      jailCardDecks: []
    }));

    const properties: Record<number, PropertyState> = {};
    for (let i = 0; i < 40; i++) {
      properties[i] = {
        tileIndex: i,
        ownerId: null,
        buildLevel: 0,
        isMortgaged: false,
        forceBought: false
      };
    }

    this.chanceDeck = shuffle([...CHANCE_CARDS]);
    this.chestDeck = shuffle([...CHEST_CARDS]);

    this.state = {
      roomId,
      phase: 'ROLLING',
      turnNumber: 1,
      currentPlayerIndex: 0,
      players,
      properties,
      dice: [1, 1],
      doubles: false,
      doublesCount: 0,
      buyOffer: null,
      forceBuyOffer: null,
      debt: null,
      trades: [],
      lastMove: null,
      bank: createBank(),
      auction: null,
      activeEvent: null,
      winnerId: null,
      victoryType: null,
      lastActionText: 'Game started. Roll to begin.'
    };
  }

  private recordMove(player: PlayerState, from: number, landed: number, to: number, passedGo = false): void {
    this.state.lastMove = {
      seq: (this.state.lastMove?.seq ?? 0) + 1,
      playerId: player.playerId,
      from,
      landed,
      to,
      passedGo
    };
  }

  public getCurrentPlayer(): PlayerState {
    return this.state.players[this.state.currentPlayerIndex];
  }

  public rollDice(d1Custom?: number, d2Custom?: number): { d1: number; d2: number; doubles: boolean } {
    if (this.state.phase !== 'ROLLING') {
      throw new Error(`Cannot roll in phase ${this.state.phase}`);
    }

    const player = this.getCurrentPlayer();
    const d1 = d1Custom ?? Math.floor(Math.random() * 6) + 1;
    const d2 = d2Custom ?? Math.floor(Math.random() * 6) + 1;
    const doubles = d1 === d2;

    this.state.dice = [d1, d2];
    this.state.doubles = doubles;

    if (player.inJail) {
      if (doubles) {
        player.inJail = false;
        player.jailTurns = 0;
        this.emitToast(`${player.name} rolled doubles and escaped Jail!`, 'success');
      } else {
        player.jailTurns++;
        if (player.jailTurns >= 3) {
          const fine = Math.min(player.money, JAIL_FINE);
          player.money -= fine;
          record(this.state, player.playerId, null, fine, 'Jail fine');
          player.inJail = false;
          player.jailTurns = 0;
          this.emitToast(`${player.name} paid $${JAIL_FINE} after 3 turns in Jail.`, 'info');
        } else {
          this.emitToast(`${player.name} stays in Jail.`, 'warning');
          this.state.phase = 'TURN_ENDED';
          this.notify();
          return { d1, d2, doubles };
        }
      }
    }

    if (doubles) {
      this.state.doublesCount++;
      if (this.state.doublesCount >= 3) {
        this.recordMove(player, player.position, JAIL_TILE_INDEX, JAIL_TILE_INDEX);
        player.position = JAIL_TILE_INDEX;
        player.inJail = true;
        player.jailTurns = 0;
        this.state.doublesCount = 0;
        this.emitToast(`3 consecutive doubles. ${player.name} goes directly to Jail.`, 'danger');
        this.state.phase = 'TURN_ENDED';
        this.notify();
        return { d1, d2, doubles };
      }
    } else {
      this.state.doublesCount = 0;
    }

    const total = d1 + d2;
    const oldPos = player.position;
    const newPos = (oldPos + total) % 40;

    if (newPos < oldPos) {
      player.money += GO_SALARY;
      player.lapsCompleted++;
      player.mortgagesThisRound = 0;
      record(this.state, null, player.playerId, GO_SALARY, 'GO salary');
      this.emitToast(`${player.name} passed GO and collected $${GO_SALARY}.`, 'success');
    }

    player.position = newPos;
    (this.state as any).phase = 'RESOLVING';

    const lapsBeforeLanding = player.lapsCompleted;
    const res = resolveLanding(
      this.state,
      player,
      this.chanceDeck,
      this.chestDeck,
      (draw: CardDraw) => this.options.onCard?.(draw),
      0,
      {},
      this.options.forceBuyMode
    );
    this.recordMove(player, oldPos, newPos, player.position, player.lapsCompleted > lapsBeforeLanding);
    if (res.toast) {
      this.emitToast(res.toast, 'info');
    }

    const currentPhase = this.state.phase as string;
    if (this.state.debt) {
      this.state.phase = 'DEBT';
    } else if (res.auctionTile !== undefined) {
      this.startAuction(res.auctionTile);
    } else if (currentPhase === 'FORCE_BUY_OFFER' && this.state.forceBuyOffer) {
      this.setupForceBuyTimeout();
    } else if (currentPhase === 'BUY_OFFER' && this.state.buyOffer) {
      // Stay in BUY_OFFER phase waiting for player's purchase choice
    } else if (!this.tryStartForeclosureAuction()) {
      this.state.phase = 'TURN_ENDED';
    }

    this.checkAndApplyVictory();
    this.notify();
    return { d1, d2, doubles };
  }

  public respondToBuyOffer(accept: boolean): void {
    if (this.state.phase !== 'BUY_OFFER' || !this.state.buyOffer) {
      throw new Error('No active buy offer');
    }

    const offer = this.state.buyOffer;
    const player = this.getCurrentPlayer();
    const tile = BOARD_TILES[offer.tileIndex];
    const prop = this.state.properties[offer.tileIndex];

    if (accept) {
      if (player.money < offer.price) {
        throw new Error('Insufficient funds to buy property');
      }
      player.money -= offer.price;
      record(this.state, player.playerId, null, offer.price, `Bought ${tile.name}`);
      prop.ownerId = player.playerId;
      prop.buildLevel = 0;
      prop.isMortgaged = false;
      prop.mortgagedAtLap = undefined;
      prop.forceBought = false;
      this.emitToast(`${player.name} bought ${tile.name} for $${offer.price}.`, 'success');
      this.state.buyOffer = null;
      if (!this.tryStartForeclosureAuction()) this.state.phase = 'TURN_ENDED';
      this.checkAndApplyVictory();
      this.notify();
      return;
    }

    // Real Monopoly: a declined property goes to auction by the Bank.
    this.emitToast(`${player.name} passed on ${tile.name}. The Bank opens an auction!`, 'info');
    this.state.buyOffer = null;
    this.startAuction(offer.tileIndex);
    this.notify();
  }

  // ------------------------------------------------------------------
  // Bank auctions
  // ------------------------------------------------------------------

  // A mortgage the owner hasn't lifted after FORECLOSURE_ROUNDS of their own
  // laps gets seized and put up for auction. Called wherever a turn would
  // otherwise settle into TURN_ENDED, so a stale mortgage from any player
  // (mortgaging is allowed any time, not just on your own turn) gets caught
  // promptly instead of waiting for that owner's next roll. Returns true if
  // it started one (the caller should not also set phase to TURN_ENDED).
  private tryStartForeclosureAuction(): boolean {
    for (const prop of Object.values(this.state.properties)) {
      if (!prop.isMortgaged || !prop.ownerId || prop.mortgagedAtLap === undefined) continue;
      const owner = this.state.players.find((p) => p.playerId === prop.ownerId);
      if (!owner || owner.lapsCompleted - prop.mortgagedAtLap < FORECLOSURE_ROUNDS) continue;
      const tile = BOARD_TILES[prop.tileIndex];
      this.emitToast(
        `${tile.name} was mortgaged for ${FORECLOSURE_ROUNDS} rounds without being paid off. The Bank forecloses on ${owner.name} and auctions it.`,
        'warning'
      );
      prop.ownerId = null;
      prop.buildLevel = 0;
      prop.isMortgaged = false;
      prop.mortgagedAtLap = undefined;
      prop.forceBought = false;
      this.startAuction(prop.tileIndex);
      return true;
    }
    return false;
  }

  private startAuction(tileIndex: number): void {
    this.state.phase = 'AUCTION';
    this.state.auction = {
      tileIndex,
      // Bidding opens at the deed's listed price: the property can never
      // sell for less than the Bank would have charged for it outright.
      highBid: BOARD_TILES[tileIndex].price,
      highBidderId: null,
      endsAt: Date.now() + AUCTION_MS,
      bidders: []
    };
    this.scheduleAuctionEnd();
  }

  private scheduleAuctionEnd(): void {
    this.clearAuctionTimer();
    const auction = this.state.auction;
    if (!auction) return;
    this.auctionTimer = setTimeout(() => this.finishAuction(), Math.max(0, auction.endsAt - Date.now()));
  }

  private clearAuctionTimer(): void {
    if (this.auctionTimer) {
      clearTimeout(this.auctionTimer);
      this.auctionTimer = null;
    }
  }

  public placeBid(playerId: string, amount: number): void {
    const auction = this.state.auction;
    if (this.state.phase !== 'AUCTION' || !auction) throw new Error('There is no auction running');
    const bidder = this.state.players.find((p) => p.playerId === playerId);
    if (!bidder || bidder.isBankrupt) throw new Error('You cannot bid in this auction');
    const bid = Math.floor(Number(amount));
    const minimum = auction.highBid + AUCTION_MIN_INCREMENT;
    if (!Number.isFinite(bid) || bid < minimum) throw new Error(`Bid at least $${minimum}`);
    if (bid > bidder.money) throw new Error(`You only have $${bidder.money}`);
    if (Date.now() > auction.endsAt) throw new Error('The auction has closed');

    auction.highBid = bid;
    auction.highBidderId = playerId;
    if (!auction.bidders.includes(playerId)) auction.bidders.push(playerId);
    auction.endsAt = Math.max(auction.endsAt, Date.now() + AUCTION_EXTEND_MS);
    this.scheduleAuctionEnd();
    this.emitToast(`${bidder.name} bids $${bid} for ${BOARD_TILES[auction.tileIndex].name}.`, 'info');
    this.notify();
  }

  /** Closes the auction: the highest bidder pays the Bank and takes the deed. */
  public finishAuction(): void {
    const auction = this.state.auction;
    if (this.state.phase !== 'AUCTION' || !auction) return;
    this.clearAuctionTimer();
    const tile = BOARD_TILES[auction.tileIndex];
    const winner = auction.highBidderId
      ? this.state.players.find((p) => p.playerId === auction.highBidderId)
      : undefined;

    if (winner && !winner.isBankrupt && winner.money >= auction.highBid) {
      const prop = this.state.properties[auction.tileIndex];
      winner.money -= auction.highBid;
      record(this.state, winner.playerId, null, auction.highBid, `Won auction: ${tile.name}`);
      prop.ownerId = winner.playerId;
      prop.buildLevel = 0;
      prop.isMortgaged = false;
      prop.mortgagedAtLap = undefined;
      prop.forceBought = false;
      this.emitToast(`SOLD! ${winner.name} wins ${tile.name} at auction for $${auction.highBid}.`, 'success');
    } else {
      this.emitToast(`No bids for ${tile.name}. It stays with the Bank.`, 'info');
    }

    this.state.auction = null;
    if (!this.tryStartForeclosureAuction()) this.state.phase = 'TURN_ENDED';
    this.checkAndApplyVictory();
    this.notify();
  }

  public respondToForceBuy(accept: boolean): void {
    if (this.state.phase !== 'FORCE_BUY_OFFER' || !this.state.forceBuyOffer) {
      throw new Error('No active force-buy offer');
    }

    this.clearForceBuyTimeout();

    const offer = this.state.forceBuyOffer;
    const player = this.getCurrentPlayer();
    const opponent = this.state.players.find((p) => p.playerId === offer.targetPlayerId);

    // Rent for landing here was already charged in resolveLanding, before
    // this offer was even made -- force-buying is on top of that, not
    // instead of it, so nothing more is owed just for declining or failing.
    if (accept) {
      const res = executeForceBuy(this.state, offer.tileIndex);
      this.emitToast(res.text, res.success ? 'success' : 'danger');
    } else {
      this.state.forceBuyOffer = null;
      if (opponent) {
        this.emitToast(`${player.name} declined the $${offer.price} force-buy on ${BOARD_TILES[offer.tileIndex].name}.`, 'info');
      }
    }

    if (!this.state.debt && !this.tryStartForeclosureAuction()) {
      this.state.phase = 'TURN_ENDED';
    }
    this.checkAndApplyVictory();
    this.notify();
  }

  public payJailFine(): void {
    const player = this.getCurrentPlayer();
    if (!player.inJail || player.money < JAIL_FINE) {
      throw new Error('Cannot pay jail fine');
    }
    player.money -= JAIL_FINE;
    record(this.state, player.playerId, null, JAIL_FINE, 'Jail fine');
    player.inJail = false;
    player.jailTurns = 0;
    this.emitToast(`${player.name} paid $${JAIL_FINE} and left Jail.`, 'info');
    this.notify();
  }

  public useJailCard(): void {
    const player = this.getCurrentPlayer();
    if (!player.inJail || player.jailCards <= 0) {
      throw new Error('No jail cards');
    }
    player.jailCards--;
    this.returnJailCard(player);
    player.inJail = false;
    player.jailTurns = 0;
    this.emitToast(`${player.name} used a Get Out of Jail Free card.`, 'success');
    this.notify();
  }

  // A used (or forfeited) Get Out of Jail Free card goes back under its deck.
  private returnJailCard(player: PlayerState): void {
    const deckType = player.jailCardDecks?.shift() ?? 'chance';
    const deck = deckType === 'chance' ? this.chanceDeck : this.chestDeck;
    const source = deckType === 'chance' ? CHANCE_CARDS : CHEST_CARDS;
    const card = source.find((c) => c.action.type === 'getOutOfJail');
    if (card && !deck.includes(card)) deck.push(card);
  }

  public build(tileIndex: number): void {
    if (this.state.phase !== 'ROLLING' && this.state.phase !== 'TURN_ENDED') {
      throw new Error(`Cannot build in phase ${this.state.phase}`);
    }
    const player = this.getCurrentPlayer();
    const res = buildProperty(this.state, player, tileIndex);
    if (!res.success) {
      throw new Error(res.text);
    }
    this.emitToast(res.text, 'success');
    this.checkAndApplyVictory();
    this.notify();
  }

  // Selling and mortgaging are allowed at any time (real Monopoly), not
  // only on your own turn, e.g. to raise cash for an auction bid or a trade.
  private manager(playerId: string): PlayerState {
    if (this.state.phase === 'GAME_OVER') throw new Error('The game is over');
    const player = this.state.players.find((p) => p.playerId === playerId);
    if (!player || player.isBankrupt) throw new Error('Only active players can manage property');
    return player;
  }

  private afterPropertyChange(): void {
    // Offers that referenced changed deeds may now be invalid.
    this.state.trades = this.state.trades.filter((t) => this.validateTrade(t) === null);
    this.tryPayDebt();
    this.checkAndApplyVictory();
    this.notify();
  }

  public sell(tileIndex: number, playerId: string = this.getCurrentPlayer().playerId, toLevel?: number): void {
    const player = this.manager(playerId);
    const res = sellBuilding(this.state, player, tileIndex, toLevel);
    if (!res.success) {
      throw new Error(res.text);
    }
    this.emitToast(res.text, 'info');
    this.afterPropertyChange();
  }

  public sellProperty(tileIndex: number, playerId: string = this.getCurrentPlayer().playerId): void {
    const player = this.manager(playerId);
    const res = sellPropertyToBank(this.state, player, tileIndex);
    if (!res.success) {
      throw new Error(res.text);
    }
    this.emitToast(res.text, 'info');
    this.afterPropertyChange();
  }

  public declareBankruptcy(): void {
    if (this.state.phase !== 'DEBT' || !this.state.debt) {
      throw new Error('No pending debt to go bankrupt from');
    }
    const player = this.getCurrentPlayer();
    const debt = this.state.debt;
    this.clearForceBuyTimeout();
    this.clearAuctionTimer();
    this.state.buyOffer = null;
    this.state.forceBuyOffer = null;
    this.state.auction = null;
    this.state.debt = null;

    while ((player.jailCardDecks?.length ?? 0) > 0) this.returnJailCard(player);
    const { raised, paid } = applyBankruptcy(this.state, player, debt.creditorId, debt.amount, debt.splits);
    const creditor = debt.creditorId
      ? this.state.players.find((p) => p.playerId === debt.creditorId)
      : null;
    const msg = creditor
      ? `${player.name} went BANKRUPT. Everything was sold to the bank for $${raised}; ${creditor.name} receives $${paid}.`
      : `${player.name} went BANKRUPT. Everything was sold back to the bank.`;
    this.emitToast(msg, 'danger');

    if (!this.checkAndApplyVictory()) {
      // The bankrupt player has nothing left to do: move straight on.
      this.state.doubles = false;
      this.state.doublesCount = 0;
      this.advanceToNextPlayer();
      return;
    }
    this.notify();
  }

  // ------------------------------------------------------------------
  // Trading (any time, any player, like the real game)
  // ------------------------------------------------------------------

  private validateTrade(t: Omit<TradeOffer, 'id' | 'createdAt'>): string | null {
    const from = this.state.players.find((p) => p.playerId === t.fromId);
    const to = this.state.players.find((p) => p.playerId === t.toId);
    if (!from || !to || from === to) return 'Pick another player to trade with';
    if (from.isBankrupt || to.isBankrupt) return 'Bankrupt players cannot trade';
    const ints = [t.giveMoney, t.getMoney];
    if (ints.some((n) => !Number.isInteger(n) || n < 0)) return 'Money amounts must be whole, non-negative numbers';
    if (new Set([...t.giveProps, ...t.getProps]).size !== t.giveProps.length + t.getProps.length) {
      return 'A property can only appear once in a trade';
    }
    if (t.giveMoney === 0 && t.getMoney === 0 && t.giveProps.length === 0 && t.getProps.length === 0) {
      return 'The trade is empty';
    }
    if (from.money < t.giveMoney) return `${from.name} does not have $${t.giveMoney}`;
    if (to.money < t.getMoney) return `${to.name} does not have $${t.getMoney}`;
    // Taking over a mortgaged deed costs 10% interest to the Bank right away.
    const fromFees = tradeMortgageFees(this.state, t.getProps);
    const toFees = tradeMortgageFees(this.state, t.giveProps);
    if (from.money - t.giveMoney + t.getMoney < fromFees) {
      return `${from.name} cannot cover the $${fromFees} mortgage interest on the deeds they receive`;
    }
    if (to.money - t.getMoney + t.giveMoney < toFees) {
      return `${to.name} cannot cover the $${toFees} mortgage interest on the deeds they receive`;
    }
    for (const i of t.giveProps) {
      const reason = tradeBlockReason(this.state.properties[i], from.playerId);
      if (reason) return reason;
    }
    for (const i of t.getProps) {
      const reason = tradeBlockReason(this.state.properties[i], to.playerId);
      if (reason) return reason;
    }
    return null;
  }

  private static readonly MAX_ROUNDS = 10;

  private tradeDraft(fromId: string, proposal: TradeProposal) {
    const message = typeof proposal.message === 'string' ? proposal.message.trim().slice(0, 80) : '';
    return {
      fromId,
      toId: proposal.toId,
      giveMoney: Math.floor(Number(proposal.giveMoney) || 0),
      getMoney: Math.floor(Number(proposal.getMoney) || 0),
      giveProps: [...new Set((proposal.giveProps ?? []).map(Number))],
      getProps: [...new Set((proposal.getProps ?? []).map(Number))],
      ...(message ? { message } : {})
    };
  }

  /**
   * The receiver answers an offer with changed terms. The original offer is
   * replaced by one going back the other way (round + 1); earlier rounds are
   * kept so both sides can see what changed.
   */
  public counterTrade(tradeId: string, playerId: string, proposal: TradeProposal): TradeOffer {
    if (this.state.phase === 'GAME_OVER') throw new Error('The game is over');
    const original = this.state.trades.find((t) => t.id === tradeId);
    if (!original) throw new Error('That trade is no longer available');
    if (original.toId !== playerId) throw new Error('Only the receiving player can counter this trade');
    const round = (original.round ?? 1) + 1;
    if (round > MonopolyGameEngine.MAX_ROUNDS) throw new Error('This negotiation has gone on long enough: accept or decline');

    const draft = this.tradeDraft(playerId, { ...proposal, toId: original.fromId });
    const invalid = this.validateTrade(draft);
    if (invalid) throw new Error(invalid);
    const same =
      draft.giveMoney === original.getMoney &&
      draft.getMoney === original.giveMoney &&
      [...draft.giveProps].sort().join() === [...original.getProps].sort().join() &&
      [...draft.getProps].sort().join() === [...original.giveProps].sort().join();
    if (same) throw new Error('Change something before sending it back, or just accept');

    const previous: TradeTerms = {
      fromId: original.fromId,
      toId: original.toId,
      giveMoney: original.giveMoney,
      giveProps: original.giveProps,
      getMoney: original.getMoney,
      getProps: original.getProps,
      ...(original.message ? { message: original.message } : {})
    };
    // Replace the answered offer (and any other open offer between them).
    this.state.trades = this.state.trades.filter(
      (t) => t.id !== tradeId && !(t.fromId === playerId && t.toId === original.fromId)
    );
    const offer: TradeOffer = {
      ...draft,
      id: Math.random().toString(36).slice(2, 10),
      createdAt: Date.now(),
      round,
      history: [...(original.history ?? []), previous].slice(-4)
    };
    this.state.trades.push(offer);

    const from = this.state.players.find((p) => p.playerId === playerId)!;
    const to = this.state.players.find((p) => p.playerId === original.fromId)!;
    this.emitToast(`${from.name} sent a counter-offer to ${to.name}.`, 'info');
    this.notify();
    return offer;
  }

  public proposeTrade(fromId: string, proposal: TradeProposal): TradeOffer {
    if (this.state.phase === 'GAME_OVER') throw new Error('The game is over');
    const draft = this.tradeDraft(fromId, proposal);
    const invalid = this.validateTrade(draft);
    if (invalid) throw new Error(invalid);

    // One open offer per pair: a new proposal replaces the previous one.
    this.state.trades = this.state.trades.filter((t) => !(t.fromId === fromId && t.toId === draft.toId));
    const offer: TradeOffer = { ...draft, id: Math.random().toString(36).slice(2, 10), createdAt: Date.now(), round: 1 };
    this.state.trades.push(offer);

    const from = this.state.players.find((p) => p.playerId === fromId)!;
    const to = this.state.players.find((p) => p.playerId === draft.toId)!;
    this.emitToast(`${from.name} sent a trade offer to ${to.name}.`, 'info');
    this.notify();
    return offer;
  }

  public respondToTrade(tradeId: string, playerId: string, accept: boolean): void {
    const trade = this.state.trades.find((t) => t.id === tradeId);
    if (!trade) throw new Error('That trade is no longer available');
    if (trade.toId !== playerId) throw new Error('Only the receiving player can answer this trade');
    const from = this.state.players.find((p) => p.playerId === trade.fromId)!;
    const to = this.state.players.find((p) => p.playerId === trade.toId)!;
    this.state.trades = this.state.trades.filter((t) => t.id !== tradeId);

    if (!accept) {
      this.emitToast(`${to.name} declined ${from.name}'s trade.`, 'info');
      this.notify();
      return;
    }

    const invalid = this.validateTrade(trade);
    if (invalid) {
      this.notify();
      throw new Error(`Trade cancelled: ${invalid}`);
    }

    from.money += trade.getMoney - trade.giveMoney;
    to.money += trade.giveMoney - trade.getMoney;
    record(this.state, from.playerId, to.playerId, trade.giveMoney, 'Trade');
    record(this.state, to.playerId, from.playerId, trade.getMoney, 'Trade');
    const fromFees = tradeMortgageFees(this.state, trade.getProps);
    const toFees = tradeMortgageFees(this.state, trade.giveProps);
    for (const i of trade.giveProps) this.state.properties[i].ownerId = to.playerId;
    for (const i of trade.getProps) this.state.properties[i].ownerId = from.playerId;
    // Mortgaged deeds stay mortgaged; the new owner pays the 10% interest.
    if (fromFees > 0) {
      from.money -= fromFees;
      record(this.state, from.playerId, null, fromFees, 'Mortgage interest (trade)');
    }
    if (toFees > 0) {
      to.money -= toFees;
      record(this.state, to.playerId, null, toFees, 'Mortgage interest (trade)');
    }

    // Offers that referenced these deeds or this cash may now be stale.
    this.state.trades = this.state.trades.filter((t) => this.validateTrade(t) === null);

    this.emitToast(`${from.name} and ${to.name} completed a trade.`, 'success');
    this.tryPayDebt();
    this.checkAndApplyVictory();
    this.notify();
  }

  public cancelTrade(tradeId: string, playerId: string): void {
    const trade = this.state.trades.find((t) => t.id === tradeId);
    if (!trade) return;
    if (trade.fromId !== playerId) throw new Error('Only the sender can cancel this trade');
    this.state.trades = this.state.trades.filter((t) => t.id !== tradeId);
    this.notify();
  }

  private enterDebt(
    debtor: PlayerState,
    amount: number,
    creditorId: string | null,
    reason: string
  ): void {
    const debt: DebtOffer = { amount, creditorId, reason };
    this.state.debt = debt;
    this.state.phase = 'DEBT';
    const creditor = creditorId
      ? this.state.players.find((p) => p.playerId === creditorId)
      : null;
    const toWhom = creditor ? ` to ${creditor.name}` : '';
    this.emitToast(
      `${debtor.name} owes $${amount}${toWhom} (${reason}). Sell buildings to pay, or declare bankruptcy.`,
      'warning'
    );
  }

  /**
   * After the debtor raises cash (sell / mortgage), auto-pay the debt
   * as soon as it is covered.
   */
  private tryPayDebt(): void {
    const debt = this.state.debt;
    if (!debt || this.state.phase !== 'DEBT') return;
    const debtor = this.getCurrentPlayer();
    if (debtor.money < debt.amount) return;

    debtor.money -= debt.amount;
    const creditor = debt.creditorId
      ? this.state.players.find((p) => p.playerId === debt.creditorId)
      : null;
    if (debt.splits?.length) {
      for (const sp of debt.splits) {
        const to = this.state.players.find((p) => p.playerId === sp.playerId);
        if (to && !to.isBankrupt) {
          to.money += sp.amount;
          record(this.state, debtor.playerId, to.playerId, sp.amount, `Debt: ${debt.reason}`);
        } else {
          record(this.state, debtor.playerId, null, sp.amount, `Debt: ${debt.reason}`);
        }
      }
    } else if (creditor && !creditor.isBankrupt) {
      creditor.money += debt.amount;
      record(this.state, debtor.playerId, creditor.playerId, debt.amount, `Debt: ${debt.reason}`);
    } else {
      record(this.state, debtor.playerId, null, debt.amount, `Debt: ${debt.reason}`);
    }
    this.state.debt = null;
    if (!this.tryStartForeclosureAuction()) this.state.phase = 'TURN_ENDED';
    const msg = debt.splits?.length
      ? `${debtor.name} paid off $${debt.amount} (${debt.reason}).`
      : creditor
        ? `${debtor.name} paid off $${debt.amount} debt to ${creditor.name}.`
        : `${debtor.name} paid off $${debt.amount} debt to the bank.`;
    this.state.lastActionText = msg;
    this.emitToast(msg, 'success');
  }

  public mortgage(tileIndex: number, isMortgage: boolean, playerId: string = this.getCurrentPlayer().playerId): void {
    const player = this.manager(playerId);
    // Raising cash to cover your own active debt isn't a strategic choice --
    // don't let the per-round quota block it.
    const payingOwnDebt = this.state.phase === 'DEBT' && !!this.state.debt && this.getCurrentPlayer().playerId === player.playerId;
    if (isMortgage && !payingOwnDebt && (player.mortgagesThisRound ?? 0) >= MAX_MORTGAGES_PER_ROUND) {
      throw new Error(`You can only mortgage ${MAX_MORTGAGES_PER_ROUND} property per round. Pass GO to reset it.`);
    }
    const res = toggleMortgage(this.state, player, tileIndex, isMortgage);
    if (!res.success) {
      throw new Error(res.text);
    }
    if (isMortgage && !payingOwnDebt) player.mortgagesThisRound = (player.mortgagesThisRound ?? 0) + 1;
    this.emitToast(res.text, 'info');
    this.afterPropertyChange();
  }

  public endTurn(): void {
    if (this.state.phase !== 'TURN_ENDED') {
      throw new Error(`Cannot end turn in phase ${this.state.phase}`);
    }

    const player = this.getCurrentPlayer();
    if (this.state.doubles && !player.inJail && !player.isBankrupt) {
      this.state.phase = 'ROLLING';
      this.emitToast(`Doubles! ${player.name} rolls again.`, 'info');
      this.notify();
      return;
    }

    this.state.doublesCount = 0;
    this.state.doubles = false;
    this.advanceToNextPlayer();
  }

  private advanceToNextPlayer(): void {
    const totalPlayers = this.state.players.length;
    let nextIdx = (this.state.currentPlayerIndex + 1) % totalPlayers;
    let attempts = 0;

    while (this.state.players[nextIdx].isBankrupt && attempts < totalPlayers) {
      nextIdx = (nextIdx + 1) % totalPlayers;
      attempts++;
    }

    this.state.currentPlayerIndex = nextIdx;
    this.state.turnNumber++;
    this.state.phase = 'ROLLING';
    this.expireActiveEvent();

    const nextPlayer = this.state.players[nextIdx];
    this.emitToast(`It is now ${nextPlayer.name}'s turn.`, 'info');
    this.maybeTriggerRandomEvent();
    this.checkAndApplyVictory();
    this.notify();
  }

  // ------------------------------------------------------------------
  // Random board-wide events
  // ------------------------------------------------------------------

  private expireActiveEvent(): void {
    const event = this.state.activeEvent;
    if (event && this.state.turnNumber > event.expiresAtTurn) {
      this.state.activeEvent = null;
    }
  }

  private maybeTriggerRandomEvent(): void {
    if (!this.options.randomEvents) return;
    // Never interrupt a decision already in progress (auction, debt, etc).
    if (this.state.phase !== 'ROLLING') return;
    if (Math.random() >= RANDOM_EVENT_CHANCE) return;

    const active = this.state.players.filter((p) => !p.isBankrupt);
    const unownedTiles = BOARD_TILES.filter(
      (t) => t.price > 0 && this.state.properties[t.index]?.ownerId === null
    ).map((t) => t.index);

    const eligible: RandomEventKind[] = [];
    if (unownedTiles.length > 0) eligible.push('property_lottery');
    if (!this.state.activeEvent) eligible.push('market_crash', 'building_boom');
    if (active.length > 0) eligible.push('bank_bonus');
    if (active.length >= 2) eligible.push('leaders_tax');
    if (eligible.length === 0) return;

    const kind = eligible[Math.floor(Math.random() * eligible.length)];
    switch (kind) {
      case 'property_lottery':
        this.eventPropertyLottery(unownedTiles);
        break;
      case 'market_crash':
        this.eventMarketCrash();
        break;
      case 'building_boom':
        this.eventBuildingBoom();
        break;
      case 'bank_bonus':
        this.eventBankBonus(active);
        break;
      case 'leaders_tax':
        this.eventLeadersTax(active);
        break;
    }
  }

  // Bank spontaneously auctions off a random unowned property.
  private eventPropertyLottery(unownedTiles: number[]): void {
    const tileIndex = unownedTiles[Math.floor(Math.random() * unownedTiles.length)];
    this.emitRandomEvent(`Random event! The Bank puts ${BOARD_TILES[tileIndex].name} up for auction.`, 'warning');
    this.startAuction(tileIndex);
  }

  // Rent is halved everywhere for a few turns.
  private eventMarketCrash(): void {
    this.state.activeEvent = {
      type: 'market_crash',
      label: 'Market Crash: rent halved',
      factor: 0.5,
      expiresAtTurn: this.state.turnNumber + RANDOM_EVENT_DURATION_TURNS
    };
    this.emitRandomEvent(
      `Random event! Market Crash — rent is halved board-wide for the next ${RANDOM_EVENT_DURATION_TURNS} turns.`,
      'warning'
    );
  }

  // Building costs are discounted for a few turns.
  private eventBuildingBoom(): void {
    this.state.activeEvent = {
      type: 'building_boom',
      label: 'Building Boom: 50% off construction',
      factor: 0.5,
      expiresAtTurn: this.state.turnNumber + RANDOM_EVENT_DURATION_TURNS
    };
    this.emitRandomEvent(
      `Random event! Building Boom — house/hotel upgrades are 50% off for the next ${RANDOM_EVENT_DURATION_TURNS} turns.`,
      'success'
    );
  }

  // Everyone still playing gets a small surprise windfall from the Bank.
  private eventBankBonus(active: PlayerState[]): void {
    const parts: string[] = [];
    for (const p of active) {
      const bonus = 50 + Math.floor(Math.random() * 11) * 10; // $50..$150
      p.money += bonus;
      record(this.state, null, p.playerId, bonus, 'Random event: Bank Bonus');
      parts.push(`${p.name} +$${bonus}`);
    }
    this.emitRandomEvent(`Random event! Bank Bonus — ${parts.join(', ')}.`, 'success');
  }

  // Catch-up mechanic: the richest player pays 10% of their cash straight
  // to the poorest, so a runaway leader can't coast forever.
  private eventLeadersTax(active: PlayerState[]): void {
    const richest = [...active].sort((a, b) => b.money - a.money)[0];
    const poorest = [...active].filter((p) => p.playerId !== richest.playerId).sort((a, b) => a.money - b.money)[0];
    if (!richest || !poorest || richest.money <= 0) return;
    const tax = Math.max(10, Math.round(richest.money * 0.1));
    richest.money -= tax;
    poorest.money += tax;
    record(this.state, richest.playerId, poorest.playerId, tax, 'Random event: Wealth Tax');
    this.emitRandomEvent(`Random event! Wealth Tax — ${richest.name} pays $${tax} to ${poorest.name}.`, 'warning');
  }

  public checkAndApplyVictory(): boolean {
    const result = checkVictory(this.state, this.options.specialVictory);
    if (result.hasWinner && result.winnerId) {
      this.state.winnerId = result.winnerId;
      this.state.victoryType = result.victoryType;
      this.state.phase = 'GAME_OVER';
      this.clearForceBuyTimeout();
      this.clearAuctionTimer();
      if (this.turnTimer) clearTimeout(this.turnTimer);
      this.turnTimer = null;
      this.state.turnDeadline = null;
      this.state.auction = null;
      if (result.reason) {
        this.emitToast(`GAME OVER. ${result.reason}`, 'success');
      }
      return true;
    }
    return false;
  }

  private setupForceBuyTimeout(): void {
    this.clearForceBuyTimeout();
    this.forceBuyTimer = setTimeout(() => {
      if (this.state.phase === 'FORCE_BUY_OFFER') {
        this.respondToForceBuy(false);
      }
    }, 15000);
  }

  private clearForceBuyTimeout(): void {
    if (this.forceBuyTimer) {
      clearTimeout(this.forceBuyTimer);
      this.forceBuyTimer = null;
    }
  }

  private emitToast(text: string, type: 'info' | 'success' | 'warning' | 'danger' = 'info'): void {
    this.state.lastActionText = text;
    this.options.onToast?.({ text, type });
  }

  // Random events still land in the toast / activity log like anything
  // else, but also get their own big, hard-to-miss banner client-side.
  private emitRandomEvent(text: string, type: 'info' | 'success' | 'warning' | 'danger' = 'info'): void {
    this.emitToast(text, type);
    this.options.onRandomEvent?.({ text, type });
  }

  private notify(): void {
    this.armTurnTimer();
    this.options.onStateChange?.(this.state);
  }

  // ------------------------------------------------------------------
  // Surrender, turn timer and away players
  // ------------------------------------------------------------------

  /**
   * A player gives up: like bankruptcy to the Bank (deeds and buildings go
   * back, trades are cancelled). Works at any moment, on anyone's turn; a
   * pending debt of theirs is settled from the sale like a normal bankruptcy.
   */
  public surrender(playerId: string, reason: 'surrender' | 'away' = 'surrender'): void {
    if (this.state.phase === 'GAME_OVER') throw new Error('The game is over');
    const player = this.state.players.find((p) => p.playerId === playerId);
    if (!player || player.isBankrupt) throw new Error('You are no longer in this game');
    const isCurrent = this.getCurrentPlayer().playerId === playerId;

    // Their own pending decision / debt ends with them.
    const debt = isCurrent ? this.state.debt : null;
    if (isCurrent) {
      this.clearForceBuyTimeout();
      this.state.buyOffer = null;
      this.state.forceBuyOffer = null;
      this.state.debt = null;
      if (this.state.phase === 'AUCTION') this.finishAuctionSilently();
    } else if (this.state.forceBuyOffer?.targetPlayerId === playerId) {
      // The deed being force-bought returns to the Bank instead.
      this.clearForceBuyTimeout();
      this.state.forceBuyOffer = null;
      this.state.phase = 'TURN_ENDED';
    }
    if (this.state.auction?.highBidderId === playerId) {
      this.state.auction.highBidderId = null;
      this.state.auction.highBid = BOARD_TILES[this.state.auction.tileIndex].price;
    }

    while ((player.jailCardDecks?.length ?? 0) > 0) this.returnJailCard(player);
    applyBankruptcy(this.state, player, debt?.creditorId ?? null, debt?.amount ?? 0, debt?.splits);
    player.surrendered = true;
    this.emitToast(
      reason === 'away'
        ? `${player.name} was away too long and left the game. Their properties went back to the Bank.`
        : `${player.name} surrendered. Their properties went back to the Bank.`,
      'warning'
    );

    if (this.checkAndApplyVictory()) {
      this.notify();
      return;
    }
    if (isCurrent) {
      this.state.doubles = false;
      this.state.doublesCount = 0;
      this.advanceToNextPlayer();
      return;
    }
    this.notify();
  }

  // Auction closed early because the player whose turn it is left.
  private finishAuctionSilently(): void {
    if (this.state.phase !== 'AUCTION' || !this.state.auction) return;
    this.finishAuction();
  }

  /** Starts the clocks for the opening move (call once the game begins). */
  public begin(): void {
    this.turnKey = '';
    this.armTurnTimer();
  }

  /** The player acted themselves: their missed-turn streak resets. */
  public markActive(playerId: string): void {
    const p = this.state.players.find((pl) => pl.playerId === playerId);
    if (p && p.timeouts) p.timeouts = 0;
  }

  /** Presence change: an away current player gets a shorter clock. */
  public setConnected(playerId: string, connected: boolean): void {
    const p = this.state.players.find((pl) => pl.playerId === playerId);
    if (!p || p.isConnected === connected) return;
    p.isConnected = connected;
    if (this.getCurrentPlayer()?.playerId === playerId) this.turnKey = '';
    this.notify();
  }

  // Phases where the current player owes a decision (auctions and force-buy
  // offers run their own clocks).
  private static readonly TIMED_PHASES = ['ROLLING', 'BUY_OFFER', 'TURN_ENDED', 'DEBT'];
  private static readonly AWAY_SEC = 20;
  private static readonly AWAY_LIMIT = 3;

  private armTurnTimer(): void {
    const base = this.options.turnTimerSec ?? 0;
    const current = this.getCurrentPlayer();
    const timed =
      this.state.phase !== 'GAME_OVER' &&
      MonopolyGameEngine.TIMED_PHASES.includes(this.state.phase) &&
      !!current &&
      !current.isBankrupt &&
      (base > 0 || !current.isConnected);
    const key = timed ? `${this.state.turnNumber}:${this.state.currentPlayerIndex}:${this.state.phase}:${current.isConnected}` : '';
    if (key === this.turnKey) return;
    this.turnKey = key;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (!timed) {
      this.state.turnDeadline = null;
      return;
    }
    // Someone who is offline gets a short clock even with the timer off, so
    // one closed tab never freezes the table. Debts get extra time to plan.
    let sec = base > 0 ? base : MonopolyGameEngine.AWAY_SEC;
    if (!current.isConnected) sec = Math.min(sec, MonopolyGameEngine.AWAY_SEC);
    if (this.state.phase === 'DEBT' && current.isConnected) sec *= 2;
    this.state.turnDeadline = Date.now() + sec * 1000;
    this.turnTimer = setTimeout(() => this.onTurnTimeout(), sec * 1000);
  }

  /** The clock ran out: play the current decision for the player. */
  public onTurnTimeout(): void {
    this.turnTimer = null;
    this.turnKey = '';
    const player = this.getCurrentPlayer();
    if (!player || player.isBankrupt || this.state.phase === 'GAME_OVER') return;
    player.timeouts = (player.timeouts ?? 0) + 1;

    if (!player.isConnected && player.timeouts >= MonopolyGameEngine.AWAY_LIMIT) {
      this.surrender(player.playerId, 'away');
      return;
    }

    try {
      switch (this.state.phase) {
        case 'ROLLING':
          this.emitToast(`${player.name} ran out of time. Rolling for them.`, 'info');
          this.options.onDice?.(this.rollDice());
          break;
        case 'BUY_OFFER':
          this.emitToast(`${player.name} ran out of time and passed on the property.`, 'info');
          this.respondToBuyOffer(false);
          break;
        case 'TURN_ENDED':
          this.endTurn();
          break;
        case 'DEBT':
          this.autoSettleDebt(player);
          break;
      }
    } catch {
      // A failed auto-action must never stall the game: move on.
      const phase = this.state.phase as string;
      if (phase !== 'GAME_OVER' && phase !== 'AUCTION' && phase !== 'DEBT') {
        this.state.phase = 'TURN_ENDED';
        this.endTurn();
      }
    }
  }

  // Sells buildings (top levels first), then mortgages land until the debt is
  // covered; declares bankruptcy when nothing is left.
  private autoSettleDebt(player: PlayerState): void {
    this.emitToast(`${player.name} ran out of time. The Bank settles their debt.`, 'warning');
    const owned = () => Object.values(this.state.properties).filter((p) => p.ownerId === player.playerId);
    let guard = 60;
    while (this.state.phase === 'DEBT' && this.state.debt && player.money < this.state.debt.amount && guard-- > 0) {
      const built = owned()
        .filter((p) => p.buildLevel > 0)
        .sort((a, b) => b.buildLevel - a.buildLevel)[0];
      if (built) {
        sellBuilding(this.state, player, built.tileIndex);
        continue;
      }
      const land = owned().find((p) => !p.isMortgaged && !mortgageBlockReason(this.state, player.playerId, p.tileIndex));
      if (!land) break;
      toggleMortgage(this.state, player, land.tileIndex, true);
    }
    this.tryPayDebt();
    if (this.state.phase === 'DEBT') {
      this.declareBankruptcy();
      return;
    }
    this.notify();
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  /** Everything needed to rebuild this game after a server restart. */
  public snapshot(): EngineSnapshot {
    return {
      state: this.state,
      chance: this.chanceDeck.map((c) => c.id),
      chest: this.chestDeck.map((c) => c.id),
      specialVictory: this.options.specialVictory,
      turnTimerSec: this.options.turnTimerSec ?? 0
    };
  }

  public static restore(snap: EngineSnapshot, options: Omit<GameEngineOptions, 'specialVictory' | 'turnTimerSec'> = {}): MonopolyGameEngine {
    const engine = new MonopolyGameEngine(snap.state.roomId, [], {
      ...options,
      specialVictory: snap.specialVictory,
      turnTimerSec: snap.turnTimerSec
    });
    const byId = new Map([...CHANCE_CARDS, ...CHEST_CARDS].map((c) => [c.id, c]));
    const deck = (ids: string[], fallback: CardDef[]) => {
      const cards = ids.map((id) => byId.get(id)).filter((c): c is CardDef => !!c);
      return cards.length ? cards : shuffle([...fallback]);
    };
    engine.state = snap.state;
    engine.chanceDeck = deck(snap.chance, CHANCE_CARDS);
    engine.chestDeck = deck(snap.chest, CHEST_CARDS);
    // Nobody is connected right after a restart; they rejoin one by one.
    for (const p of engine.state.players) p.isConnected = false;
    engine.state.turnDeadline = null;
    engine.resumeTimers();
    return engine;
  }

  private resumeTimers(): void {
    if (this.state.phase === 'AUCTION' && this.state.auction) {
      // Give bidders a moment to come back.
      this.state.auction.endsAt = Math.max(this.state.auction.endsAt, Date.now() + AUCTION_EXTEND_MS);
      this.scheduleAuctionEnd();
    }
    if (this.state.phase === 'FORCE_BUY_OFFER' && this.state.forceBuyOffer) this.setupForceBuyTimeout();
    this.turnKey = '';
    this.armTurnTimer();
  }

  /** Stops every timer (room closed / game discarded). */
  public dispose(): void {
    this.clearForceBuyTimeout();
    this.clearAuctionTimer();
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }
}

export interface EngineSnapshot {
  state: GameState;
  chance: string[];
  chest: string[];
  specialVictory: boolean;
  turnTimerSec: number;
}

