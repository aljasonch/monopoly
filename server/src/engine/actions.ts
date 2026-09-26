import {
  BOARD_TILES,
  COLOR_GROUPS,
  BuildLevel,
  GameState,
  PlayerState,
  PropertyState,
  buildBlockReason,
  buildingRefund,
  effectiveBuildCost,
  mortgageBlockReason,
  mortgageValue,
  sellToBankValue,
  unmortgageCost
} from '@monopoly/shared';
import { movePieces, record } from './bank.js';

/**
 * Auto-buys an unowned purchasable property when player lands on it (LINE Get Rich style)
 * If player has enough money: buys instantly, returns success: true
 * If player lacks money: property remains unowned, no auction (LINE Get Rich style)
 */
export function executeAutoBuy(
  gameState: GameState,
  buyer: PlayerState,
  tileIndex: number
): { bought: boolean; text: string } {
  const tile = BOARD_TILES[tileIndex];
  const prop = gameState.properties[tileIndex];

  if (!tile || !prop) {
    return { bought: false, text: 'Invalid tile' };
  }

  if (tile.price <= 0 || prop.ownerId !== null) {
    return { bought: false, text: 'Tile cannot be purchased' };
  }

  if (buyer.money >= tile.price) {
    buyer.money -= tile.price;
    record(gameState, buyer.playerId, null, tile.price, `Bought ${tile.name}`);
    prop.ownerId = buyer.playerId;
    prop.buildLevel = 0;
    prop.isMortgaged = false;
    prop.mortgagedAtLap = undefined;
    prop.forceBought = false; // bought cleanly from bank, can landmark

    const msg = `${buyer.name} auto-bought ${tile.name} for $${tile.price}.`;
    gameState.lastActionText = msg;
    return { bought: true, text: msg };
  } else {
    const msg = `${buyer.name} cannot afford ${tile.name} ($${tile.price}). It remains unowned.`;
    gameState.lastActionText = msg;
    return { bought: false, text: msg };
  }
}

/**
 * Builds / upgrades a property owned by the player:
 * Level 0 -> 1 (House)
 * Level 1 -> 2 (Building)
 * Level 2 -> 3 (Hotel)
 * Level 3 -> 4 (Landmark) - only if not force-bought AND the whole color set
 *   is owned and built to Hotels.
 * Building on raw land needs the player to have passed GO at least once.
 *
 * LINE Get Rich rule: you may only upgrade the property your token is
 * currently standing on (i.e. right after landing on your own property).
 */
export function buildProperty(
  gameState: GameState,
  player: PlayerState,
  tileIndex: number
): { success: boolean; text: string } {
  const tile = BOARD_TILES[tileIndex];
  const prop = gameState.properties[tileIndex];
  const blocked = buildBlockReason(gameState, player, tileIndex);
  if (blocked || !tile || !prop) {
    return { success: false, text: blocked ?? 'Invalid property' };
  }

  const cost = effectiveBuildCost(gameState, tileIndex);
  player.money -= cost;
  movePieces(gameState, prop.buildLevel, prop.buildLevel + 1);
  prop.buildLevel = (prop.buildLevel + 1) as BuildLevel;
  record(gameState, player.playerId, null, cost, `Built on ${tile.name}`);

  const levelNames = ['Land', 'House (Lv 1)', 'Building (Lv 2)', 'Hotel (Lv 3)', 'LANDMARK (Lv 4)'];
  const newLevelName = levelNames[prop.buildLevel];

  const msg = `${player.name} upgraded ${tile.name} to ${newLevelName} for $${cost}.`;
  gameState.lastActionText = msg;
  return { success: true, text: msg };
}

/**
 * Sells buildings back to the Bank at half the build cost per level
 * (Landmark -> Hotel -> Building -> House -> Land). By default one level;
 * `toLevel` sells straight down to that level.
 */
export function sellBuilding(
  gameState: GameState,
  player: PlayerState,
  tileIndex: number,
  toLevel?: number
): { success: boolean; text: string; refund?: number } {
  const tile = BOARD_TILES[tileIndex];
  const prop = gameState.properties[tileIndex];

  if (!tile || !prop) {
    return { success: false, text: 'Invalid property' };
  }

  if (prop.ownerId !== player.playerId) {
    return { success: false, text: 'You do not own this property' };
  }

  if (prop.buildLevel <= 0 || tile.buildCost <= 0) {
    return { success: false, text: `${tile.name} has no buildings to sell` };
  }

  let targetLevel = toLevel === undefined ? prop.buildLevel - 1 : Math.floor(toLevel);
  if (!Number.isInteger(targetLevel) || targetLevel < 0 || targetLevel >= prop.buildLevel) {
    return { success: false, text: 'Pick a lower level to sell down to' };
  }
  // Breaking a hotel back into houses needs the Bank to have them; during a
  // housing shortage the property is sold down to land instead (real rule).
  if (prop.buildLevel >= 3 && targetLevel > 0 && targetLevel < 3 && gameState.bank.houses < targetLevel) {
    targetLevel = 0;
  }
  const refund = buildingRefund(tileIndex, prop.buildLevel - targetLevel);
  movePieces(gameState, prop.buildLevel, targetLevel);
  prop.buildLevel = targetLevel as BuildLevel;
  player.money += refund;
  record(gameState, null, player.playerId, refund, `Sold buildings on ${tile.name}`);

  const levelNames = ['Land', 'House (Lv 1)', 'Building (Lv 2)', 'Hotel (Lv 3)', 'LANDMARK (Lv 4)'];
  const msg = `${player.name} sold buildings on ${tile.name} for $${refund} (now ${levelNames[prop.buildLevel]}).`;
  gameState.lastActionText = msg;
  return { success: true, text: msg, refund };
}

/**
 * Sells a whole deed back to the Bank: buildings at half the build cost plus
 * the land at its mortgage value (a mortgaged deed just cancels the loan).
 * The property becomes unowned and can be bought again.
 */
export function sellPropertyToBank(
  gameState: GameState,
  player: PlayerState,
  tileIndex: number
): { success: boolean; text: string; refund?: number } {
  const tile = BOARD_TILES[tileIndex];
  const prop = gameState.properties[tileIndex];
  if (!tile || !prop || tile.price <= 0) return { success: false, text: 'Invalid property' };
  if (prop.ownerId !== player.playerId) return { success: false, text: 'You do not own this property' };

  const refund = sellToBankValue(prop);
  movePieces(gameState, prop.buildLevel, 0);
  prop.ownerId = null;
  prop.buildLevel = 0;
  prop.isMortgaged = false;
  prop.mortgagedAtLap = undefined;
  prop.forceBought = false;
  player.money += refund;
  if (refund > 0) record(gameState, null, player.playerId, refund, `Sold ${tile.name} to the Bank`);

  const msg = `${player.name} sold ${tile.name} back to the Bank for $${refund}.`;
  gameState.lastActionText = msg;
  return { success: true, text: msg, refund };
}

/**
 * Mortgage / unmortgage property
 */
export function toggleMortgage(
  gameState: GameState,
  player: PlayerState,
  tileIndex: number,
  mortgage: boolean
): { success: boolean; text: string } {
  const tile = BOARD_TILES[tileIndex];
  const prop = gameState.properties[tileIndex];

  if (!tile || !prop || prop.ownerId !== player.playerId) {
    return { success: false, text: 'You do not own this property' };
  }

  if (mortgage) {
    const blocked = mortgageBlockReason(gameState, player.playerId, tileIndex);
    if (blocked) return { success: false, text: blocked };
    const value = mortgageValue(tileIndex);
    prop.isMortgaged = true;
    prop.mortgagedAtLap = player.lapsCompleted;
    player.money += value;
    record(gameState, null, player.playerId, value, `Mortgaged ${tile.name}`);
    const msg = `${player.name} mortgaged ${tile.name} for $${value}.`;
    gameState.lastActionText = msg;
    return { success: true, text: msg };
  } else {
    if (!prop.isMortgaged) {
      return { success: false, text: 'Property is not mortgaged' };
    }
    const cost = unmortgageCost(tileIndex); // mortgage value + 10% interest
    if (player.money < cost) {
      return { success: false, text: `Need $${cost} to lift the mortgage on ${tile.name}` };
    }
    player.money -= cost;
    prop.isMortgaged = false;
    prop.mortgagedAtLap = undefined;
    record(gameState, player.playerId, null, cost, `Paid off mortgage on ${tile.name}`);
    const msg = `${player.name} lifted the mortgage on ${tile.name} for $${cost}.`;
    gameState.lastActionText = msg;
    return { success: true, text: msg };
  }
}
