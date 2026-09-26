import {
  BOARD_TILES,
  CardDef,
  CardDraw,
  ForceBuyMode,
  GO_TO_JAIL_TILE_INDEX,
  JAIL_TILE_INDEX,
  GO_SALARY,
  GameState,
  piecesAt,
  PlayerState
} from '@monopoly/shared';
import { record } from './bank.js';
import { executeAutoBuy } from './actions.js';
import { canForceBuy, createForceBuyOffer } from './forceBuy.js';
import { calculateRent, payRent } from './rent.js';

export interface ResolveResult {
  needsForceBuyChoice: boolean;
  toast: string;
  // Unowned property the player cannot afford: the Bank auctions it.
  auctionTile?: number;
}

export interface LandingOptions {
  // "Nearest airport" card: pay twice the normal rent.
  rentMultiplier?: number;
  // "Nearest utility" card: pay 10x this fresh dice total.
  utilityRoll?: number;
}

export function resolveLanding(
  gameState: GameState,
  player: PlayerState,
  chanceDeck: CardDef[],
  chestDeck: CardDef[],
  onCard?: (draw: CardDraw) => void,
  depth = 0,
  opts: LandingOptions = {},
  forceBuyMode: ForceBuyMode = 'developed'
): ResolveResult {
  const tileIndex = player.position;
  const tile = BOARD_TILES[tileIndex];
  const prop = gameState.properties[tileIndex];

  // 1. Go To Jail tile
  if (tileIndex === GO_TO_JAIL_TILE_INDEX) {
    player.position = JAIL_TILE_INDEX;
    player.inJail = true;
    player.jailTurns = 0;
    const msg = `${player.name} landed on Go To Jail and is arrested.`;
    gameState.lastActionText = msg;
    return { needsForceBuyChoice: false, toast: msg };
  }

  // 2. Tax
  if (tile.type === 'tax') {
    const tax = tile.rentByLevel[0];
    if (player.money >= tax) {
      player.money -= tax;
      record(gameState, player.playerId, null, tax, tile.name);
      const msg = `${player.name} paid $${tax} in ${tile.name}.`;
      gameState.lastActionText = msg;
      return { needsForceBuyChoice: false, toast: msg };
    }
    gameState.debt = { amount: tax, creditorId: null, reason: `${tile.name} tax` };
    const debtMsg = `${player.name} cannot afford the $${tax} ${tile.name}. Sell buildings to pay or go bankrupt.`;
    gameState.lastActionText = debtMsg;
    return { needsForceBuyChoice: false, toast: debtMsg };
  }

  // 3. Chance / Chest
  if (tile.type === 'chance' || tile.type === 'chest') {
    return drawCard(gameState, player, tile.type, chanceDeck, chestDeck, onCard, depth, forceBuyMode);
  }

  // 4. Purchasable tiles: Property / Railroad / Utility
  if (prop) {
    // Unowned property: offer to buy if player has funds
    if (prop.ownerId === null && tile.price > 0) {
      if (player.money >= tile.price) {
        gameState.phase = 'BUY_OFFER';
        gameState.buyOffer = {
          tileIndex,
          price: tile.price,
          buyerPlayerId: player.playerId
        };
        const msg = `${player.name} landed on unowned ${tile.name}. Purchase offer: $${tile.price}.`;
        gameState.lastActionText = msg;
        return { needsForceBuyChoice: false, toast: msg };
      } else {
        gameState.buyOffer = null;
        const msg = `${player.name} landed on ${tile.name} but can't afford the $${tile.price} asking price.`;
        gameState.lastActionText = msg;
        return { needsForceBuyChoice: false, toast: msg };
      }
    }

    // Owned by self
    if (prop.ownerId === player.playerId) {
      const msg = `${player.name} landed on their own property (${tile.name}).`;
      gameState.lastActionText = msg;
      return { needsForceBuyChoice: false, toast: msg };
    }

    // Owned by opponent!
    const opponent = gameState.players.find((p) => p.playerId === prop.ownerId);
    if (!opponent) return { needsForceBuyChoice: false, toast: '' };

    // Rent is always due first. Force-buying (when eligible) is an option on
    // top of that, not instead of it: taking over the deed costs rent + the
    // takeover price, not just the takeover price.
    const diceTotal = gameState.dice[0] + gameState.dice[1];
    let rent = calculateRent(gameState, tileIndex, diceTotal);
    if (tile.type === 'utility' && opts.utilityRoll !== undefined && !prop.isMortgaged) {
      rent = opts.utilityRoll * 10;
    } else if (opts.rentMultiplier) {
      rent *= opts.rentMultiplier;
    }
    const result = payRent(gameState, player, opponent, rent, `Rent for ${tile.name}`);

    if (result.debt !== undefined) {
      gameState.debt = {
        amount: result.debt,
        creditorId: opponent.playerId,
        reason: `rent for ${tile.name}`
      };
      const debtMsg = `${player.name} cannot afford $${rent} rent to ${opponent.name}. Sell buildings to pay or go bankrupt.`;
      gameState.lastActionText = debtMsg;
      return { needsForceBuyChoice: false, toast: debtMsg };
    }

    const rentMsg = `${player.name} paid $${result.paid} rent to ${opponent.name} for ${tile.name}.`;

    // Check force-buy eligibility against what's left after rent -- the
    // takeover price is due on top of it, not instead of it.
    const fbCheck = canForceBuy(tileIndex, player, prop, forceBuyMode);
    if (fbCheck.eligible) {
      gameState.phase = 'FORCE_BUY_OFFER';
      gameState.forceBuyOffer = createForceBuyOffer(tileIndex, player, prop);
      const msg = `${rentMsg} Force-buy offer: $${fbCheck.price} on top of the rent.`;
      gameState.lastActionText = msg;
      return { needsForceBuyChoice: true, toast: msg };
    }

    gameState.lastActionText = rentMsg;
    return { needsForceBuyChoice: false, toast: rentMsg };
  }

  return { needsForceBuyChoice: false, toast: `Landed on ${tile.name}` };
}

// ---------------------------------------------------------------- cards

const RAILROADS = [5, 15, 25, 35];
const UTILITIES = [12, 28];

function nextOf(list: number[], from: number): number {
  return list.find((i) => i > from) ?? list[0];
}

function payGoSalary(gameState: GameState, player: PlayerState): void {
  player.money += GO_SALARY;
  player.lapsCompleted++;
  player.mortgagesThisRound = 0;
  record(gameState, null, player.playerId, GO_SALARY, 'GO salary');
}

// Buildings a player owns, in house / hotel pieces (Lv1 = 1 house, Lv2 = 2
// houses, Hotel & Landmark = 1 hotel).
function buildingPieces(gameState: GameState, playerId: string) {
  let houses = 0;
  let hotels = 0;
  for (const p of Object.values(gameState.properties)) {
    if (p.ownerId !== playerId) continue;
    const pc = piecesAt(p.buildLevel);
    houses += pc.houses;
    hotels += pc.hotels;
  }
  return { houses, hotels };
}

function payBank(gameState: GameState, player: PlayerState, amount: number, reason: string, deckName: string): string | null {
  if (amount <= 0) return null;
  if (player.money >= amount) {
    player.money -= amount;
    record(gameState, player.playerId, null, amount, deckName);
    return null;
  }
  gameState.debt = { amount, creditorId: null, reason };
  return `${player.name} cannot pay $${amount}. Sell buildings to pay or go bankrupt.`;
}

/**
 * Draws the top card of a deck and applies it (classic Monopoly rules).
 * The card goes back under the deck, except Get Out of Jail Free, which the
 * player keeps until it is used.
 */
export function drawCard(
  gameState: GameState,
  player: PlayerState,
  deckType: 'chance' | 'chest',
  chanceDeck: CardDef[],
  chestDeck: CardDef[],
  onCard?: (draw: CardDraw) => void,
  depth = 0,
  forceBuyMode: ForceBuyMode = 'developed'
): ResolveResult {
  const deck = deckType === 'chance' ? chanceDeck : chestDeck;
  const deckName = deckType === 'chance' ? 'Chance' : 'Community Chest';
  const card = deck.shift();
  if (!card) return { needsForceBuyChoice: false, toast: '' };
  const action = card.action;
  if (action.type === 'getOutOfJail') {
    player.jailCards++;
    player.jailCardDecks = [...(player.jailCardDecks ?? []), deckType];
  } else {
    deck.push(card);
  }

  let detail: string | undefined;
  let toast = `${player.name} drew ${deckName}: ${action.text}`;
  const finish = (extra?: string): ResolveResult => {
    const text = extra ? `${toast} ${extra}` : toast;
    gameState.lastActionText = text;
    return { needsForceBuyChoice: false, toast: text };
  };
  // Moves the token and resolves the destination like a normal landing.
  const moveAndResolve = (target: number, collectGo: boolean, opts: LandingOptions = {}): ResolveResult => {
    if (collectGo && target <= player.position) payGoSalary(gameState, player);
    player.position = target;
    if (target === 0 || depth >= 2) return finish();
    const landed = resolveLanding(gameState, player, chanceDeck, chestDeck, onCard, depth + 1, opts, forceBuyMode);
    const combined = landed.toast ? `${toast} ${landed.toast}` : toast;
    gameState.lastActionText = combined;
    return { needsForceBuyChoice: landed.needsForceBuyChoice, toast: combined, auctionTile: landed.auctionTile };
  };

  const emit = () =>
    onCard?.({
      id: Date.now() + Math.floor(Math.random() * 1000),
      deck: deckType,
      title: card.title,
      text: action.text,
      drawerId: player.playerId,
      detail
    });

  switch (action.type) {
    case 'money': {
      if (action.amount > 0) {
        player.money += action.amount;
        record(gameState, null, player.playerId, action.amount, deckName);
        emit();
        return finish();
      }
      emit();
      const debt = payBank(gameState, player, -action.amount, `${deckName} card payment`, deckName);
      return finish(debt ?? undefined);
    }
    case 'moveTo':
      emit();
      return moveAndResolve(action.tileIndex, true);
    case 'moveBack': {
      emit();
      const target = (player.position - action.spaces + 40) % 40;
      return moveAndResolve(target, false);
    }
    case 'nearest': {
      const target = nextOf(action.kind === 'railroad' ? RAILROADS : UTILITIES, player.position);
      let opts: LandingOptions = { rentMultiplier: 2 };
      if (action.kind === 'utility') {
        const owner = gameState.properties[target]?.ownerId;
        if (owner && owner !== player.playerId) {
          const d1 = Math.floor(Math.random() * 6) + 1;
          const d2 = Math.floor(Math.random() * 6) + 1;
          detail = `Rolled ${d1} + ${d2}: pay 10 x ${d1 + d2} = $${(d1 + d2) * 10}.`;
          toast += ` ${detail}`;
          opts = { utilityRoll: d1 + d2 };
        } else {
          opts = {};
        }
      }
      emit();
      return moveAndResolve(target, true, opts);
    }
    case 'jail':
      emit();
      player.position = JAIL_TILE_INDEX;
      player.inJail = true;
      player.jailTurns = 0;
      return finish();
    case 'getOutOfJail':
      emit();
      return finish();
    case 'collectFromAll':
      emit();
      gameState.players.forEach((other) => {
        if (other.playerId !== player.playerId && !other.isBankrupt) {
          const amt = Math.min(other.money, action.amount);
          other.money -= amt;
          player.money += amt;
          record(gameState, other.playerId, player.playerId, amt, deckName);
        }
      });
      return finish();
    case 'payToAll': {
      emit();
      const others = gameState.players.filter((o) => o.playerId !== player.playerId && !o.isBankrupt);
      const total = others.length * action.amount;
      if (player.money >= total) {
        others.forEach((o) => {
          player.money -= action.amount;
          o.money += action.amount;
          record(gameState, player.playerId, o.playerId, action.amount, deckName);
        });
        return finish();
      }
      gameState.debt = {
        amount: total,
        creditorId: null,
        reason: `${deckName}: pay each player $${action.amount}`,
        splits: others.map((o) => ({ playerId: o.playerId, amount: action.amount }))
      };
      return finish(`${player.name} cannot pay $${total}. Sell buildings to pay or go bankrupt.`);
    }
    case 'repairs': {
      const { houses, hotels } = buildingPieces(gameState, player.playerId);
      const cost = houses * action.perHouse + hotels * action.perHotel;
      detail = `${houses} house${houses === 1 ? '' : 's'}, ${hotels} hotel${hotels === 1 ? '' : 's'}: pay $${cost}.`;
      toast += ` ${detail}`;
      emit();
      const debt = payBank(gameState, player, cost, `${deckName}: repairs`, deckName);
      return finish(debt ?? undefined);
    }
  }
}
