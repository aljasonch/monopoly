import {
  BOARD_TILES,
  FORCE_BUY_TIMER_MS,
  ForceBuyMode,
  GameState,
  PlayerState,
  PropertyState,
  ForceBuyOffer
} from '@monopoly/shared';
import { record } from './bank.js';

/**
 * Calculates force-buy price for a property:
 * price = (tile.price + tile.buildCost * currentBuildLevel) * 2
 */
export function calculateForceBuyPrice(tileIndex: number, buildLevel: number): number {
  const tile = BOARD_TILES[tileIndex];
  if (!tile) return 0;
  return (tile.price + tile.buildCost * buildLevel) * 2;
}

/**
 * Checks if a property can be force-bought by the landing player:
 * - Property must be owned by an opponent
 * - Property must be DEVELOPED (buildLevel >= 1) — empty land is not force-bought (just pay rent)
 * - Property CANNOT be a Landmark (buildLevel === 4 is immune!)
 * - Property cannot be mortgaged
 * - Buyer must have sufficient cash
 */
export function canForceBuy(
  tileIndex: number,
  buyer: PlayerState,
  property: PropertyState | undefined,
  mode: ForceBuyMode = 'developed'
): { eligible: boolean; price: number; reason?: string } {
  if (mode === 'off') {
    return { eligible: false, price: 0, reason: 'Force-buy is turned off in this game' };
  }

  if (!property || !property.ownerId) {
    return { eligible: false, price: 0, reason: 'Tile is unowned' };
  }

  // Only color-set properties can be force-bought. Railroads/airports and
  // utilities are never eligible, in any mode.
  const tile = BOARD_TILES[tileIndex];
  if (!tile || tile.type !== 'property') {
    return { eligible: false, price: 0, reason: 'Only properties can be force-bought' };
  }

  if (property.ownerId === buyer.playerId) {
    return { eligible: false, price: 0, reason: 'Already owned by buyer' };
  }

  if (property.isMortgaged) {
    return { eligible: false, price: 0, reason: 'Property is mortgaged' };
  }

  // Classic LINE Get Rich rule: only developed properties can be
  // force-bought. The "any" house rule also allows raw, unbuilt land.
  if (mode === 'developed' && property.buildLevel < 1) {
    return { eligible: false, price: 0, reason: 'Tile has no buildings (empty land cannot be force-bought)' };
  }

  // Landmark is untouchable
  if (property.buildLevel >= 4) {
    return { eligible: false, price: 0, reason: 'Landmarks cannot be bought from opponents' };
  }

  const price = calculateForceBuyPrice(tileIndex, property.buildLevel);
  if (buyer.money < price) {
    return { eligible: false, price, reason: `Insufficient funds (needs $${price}, has $${buyer.money})` };
  }

  return { eligible: true, price };
}

/**
 * Creates a ForceBuyOffer for the active player landing on opponent's property
 */
export function createForceBuyOffer(
  tileIndex: number,
  buyer: PlayerState,
  property: PropertyState
): ForceBuyOffer {
  const price = calculateForceBuyPrice(tileIndex, property.buildLevel);
  return {
    tileIndex,
    targetPlayerId: property.ownerId!,
    buyerPlayerId: buyer.playerId,
    price,
    currentBuildLevel: property.buildLevel,
    expiresAt: Date.now() + FORCE_BUY_TIMER_MS
  };
}

/**
 * Executes a force-buy transfer:
 * - Deducts 2x price from buyer
 * - Pays 2x price to seller (victim)
 * - Transfers ownership to buyer
 * - KEEPS existing buildLevel (decision 2)
 * - Sets forceBought = true -> LANDMARK LOCKED (cannot upgrade to level 4)
 */
export function executeForceBuy(
  gameState: GameState,
  tileIndex: number
): { success: boolean; text: string } {
  const offer = gameState.forceBuyOffer;
  if (!offer || offer.tileIndex !== tileIndex) {
    return { success: false, text: 'No active force-buy offer for this tile' };
  }

  const buyer = gameState.players.find((p) => p.playerId === offer.buyerPlayerId);
  const seller = gameState.players.find((p) => p.playerId === offer.targetPlayerId);
  const prop = gameState.properties[tileIndex];
  const tile = BOARD_TILES[tileIndex];

  if (!buyer || !seller || !prop || !tile) {
    return { success: false, text: 'Invalid participants or property' };
  }

  // Re-check at execution: a Landmark is never acquirable.
  if (prop.buildLevel >= 4) {
    gameState.forceBuyOffer = null;
    return { success: false, text: `${tile.name} is a Landmark and cannot be acquired` };
  }

  if (buyer.money < offer.price) {
    return { success: false, text: `${buyer.name} cannot afford the $${offer.price} force-buy` };
  }

  // Transaction
  buyer.money -= offer.price;
  seller.money += offer.price;
  record(gameState, buyer.playerId, seller.playerId, offer.price, `Force-bought ${tile.name}`);
  prop.ownerId = buyer.playerId;
  // KEEP existing build level!
  prop.buildLevel = offer.currentBuildLevel;
  // LANDMARK LOCKED: cannot ever upgrade to 4 (landmark)
  prop.forceBought = true;

  // Clear offer
  gameState.forceBuyOffer = null;

  const msg = `FORCE BUY: ${buyer.name} bought ${tile.name} from ${seller.name} for $${offer.price}. Kept Lv.${prop.buildLevel}, Landmark locked.`;
  gameState.lastActionText = msg;

  return { success: true, text: msg };
}
