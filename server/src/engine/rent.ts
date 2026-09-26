import {
  BOARD_TILES,
  COLOR_GROUPS,
  GameState,
  PlayerState,
  PropertyState,
  liquidationValue,
  rentMultiplier
} from '@monopoly/shared';
import { record, returnPieces } from './bank.js';

/**
 * Calculates rent for a given property:
 * - base rent * 2 if owner has entire color monopoly and buildLevel == 0
 * - or rentByLevel[buildLevel]
 * - railroad: 25 * 2^(count-1)
 * - utility: 4x or 10x dice roll
 */
export function calculateRent(
  gameState: GameState,
  tileIndex: number,
  diceTotal: number
): number {
  const tile = BOARD_TILES[tileIndex];
  const prop = gameState.properties[tileIndex];

  if (!tile || !prop || !prop.ownerId || prop.isMortgaged) {
    return 0;
  }

  let rent: number;

  // Railroad
  if (tile.type === 'railroad') {
    const railroads = [5, 15, 25, 35];
    const ownedRailroads = railroads.filter(
      (idx) => gameState.properties[idx]?.ownerId === prop.ownerId && !gameState.properties[idx]?.isMortgaged
    ).length;
    rent = 25 * Math.pow(2, Math.max(0, ownedRailroads - 1));
  } else if (tile.type === 'utility') {
    // Utility
    const utilities = [12, 28];
    const ownedUtilities = utilities.filter(
      (idx) => gameState.properties[idx]?.ownerId === prop.ownerId && !gameState.properties[idx]?.isMortgaged
    ).length;
    const multiplier = ownedUtilities === 2 ? 10 : 4;
    rent = diceTotal * multiplier;
  } else {
    // Regular Property
    const level = prop.buildLevel;
    rent = tile.rentByLevel[level] ?? tile.rentByLevel[0];

    // If level 0 and player owns entire color set, rent is doubled!
    if (level === 0 && tile.group && COLOR_GROUPS[tile.group]) {
      const groupIndices = COLOR_GROUPS[tile.group];
      const ownsAll = groupIndices.every((idx) => gameState.properties[idx]?.ownerId === prop.ownerId);
      if (ownsAll) {
        rent *= 2;
      }
    }
  }

  // A Market Crash event temporarily halves rent board-wide.
  return Math.round(rent * rentMultiplier(gameState));
}

/**
 * Transfers rent money. If the tenant cannot afford it, no money moves and
 * the shortfall is returned as debt so the game can enter the DEBT phase
 * (sell buildings / mortgage to pay, or declare bankruptcy).
 */
export function payRent(
  gameState: GameState,
  tenant: PlayerState,
  landlord: PlayerState,
  amount: number,
  reason = 'Rent'
): { paid: number; bankrupt: boolean; debt?: number } {
  if (tenant.money >= amount) {
    tenant.money -= amount;
    landlord.money += amount;
    record(gameState, tenant.playerId, landlord.playerId, amount, reason);
    return { paid: amount, bankrupt: false };
  }
  return { paid: 0, bankrupt: false, debt: amount };
}

/**
 * Applies bankruptcy the "sell everything" way: every building and deed goes
 * back to the bank (unowned, unbuilt), and the creditor receives the owed
 * amount out of what that liquidation raised (cash + half the build cost of
 * each building + half the price of each unmortgaged deed). Nothing is handed
 * to an opponent directly. creditorId null means the debt is owed to the bank.
 */
export function applyBankruptcy(
  gameState: GameState,
  tenant: PlayerState,
  creditorId: string | null,
  debtAmount: number,
  splits?: { playerId: string; amount: number }[]
): { raised: number; paid: number } {
  const raised = tenant.money + liquidationValue(gameState, tenant.playerId);
  let paid = 0;
  if (splits?.length) {
    // Several creditors: share what the sale raised in proportion to the debt.
    const share = Math.min(1, raised / Math.max(1, debtAmount));
    for (const sp of splits) {
      const to = gameState.players.find((p) => p.playerId === sp.playerId);
      if (!to || to.isBankrupt) continue;
      const amt = Math.floor(sp.amount * share);
      to.money += amt;
      paid += amt;
      record(gameState, null, to.playerId, amt, `Bankruptcy payout from ${tenant.name}`);
    }
  } else {
    const creditor = creditorId ? gameState.players.find((p) => p.playerId === creditorId) : null;
    paid = creditor && !creditor.isBankrupt ? Math.min(debtAmount, raised) : 0;
    if (creditor) {
      creditor.money += paid;
      record(gameState, null, creditor.playerId, paid, `Bankruptcy payout from ${tenant.name}`);
    }
  }

  tenant.money = 0;
  tenant.isBankrupt = true;
  tenant.jailCards = 0;
  tenant.jailCardDecks = [];

  Object.values(gameState.properties).forEach((p) => {
    if (p.ownerId === tenant.playerId) {
      returnPieces(gameState, p.buildLevel);
      p.ownerId = null;
      p.buildLevel = 0;
      p.isMortgaged = false;
      p.mortgagedAtLap = undefined;
      p.forceBought = false;
    }
  });

  gameState.trades = gameState.trades.filter(
    (t) => t.fromId !== tenant.playerId && t.toId !== tenant.playerId
  );

  return { raised, paid };
}
