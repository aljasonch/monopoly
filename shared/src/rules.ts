import { BOARD_TILES, COLOR_GROUPS, GO_TILE_INDEX } from './board.js';
import { GameState, PlayerState, PropertyState } from './types.js';

// Shared rule checks so the server enforces and the client explains the same
// thing. Each returns null when allowed, otherwise a human-readable reason.

export const LEVEL_LABELS = ['Land', 'House', 'Building', 'Hotel', 'Landmark'] as const;

/** Rent multiplier from a board-wide random event (1 = no effect). */
export function rentMultiplier(state: GameState): number {
  return state.activeEvent?.type === 'market_crash' ? state.activeEvent.factor : 1;
}

/** Build/upgrade cost after a board-wide random event discount, if any. */
export function effectiveBuildCost(state: GameState, tileIndex: number): number {
  const base = BOARD_TILES[tileIndex].buildCost;
  const factor = state.activeEvent?.type === 'building_boom' ? state.activeEvent.factor : 1;
  return Math.round(base * factor);
}

/** Why `player` cannot upgrade `tileIndex` right now (null = allowed). */
export function buildBlockReason(state: GameState, player: PlayerState, tileIndex: number): string | null {
  const tile = BOARD_TILES[tileIndex];
  const prop = state.properties[tileIndex];
  if (!tile || !prop) return 'Invalid property';
  if (prop.ownerId !== player.playerId) return 'You do not own this property';
  if (tile.buildCost <= 0) return 'Railroads and utilities cannot be built on';
  // Landing exactly on GO is a building spree: upgrade anything you own,
  // not just the tile you're standing on.
  if (player.position !== tileIndex && player.position !== GO_TILE_INDEX) {
    return `You must stand on ${tile.name} to upgrade it. Build right after landing on your own property, or land on GO to build anywhere.`;
  }
  if (prop.isMortgaged) return 'Cannot build on a mortgaged property';
  const mortgagedInSet = (COLOR_GROUPS[tile.group] ?? []).find((i) => state.properties[i]?.isMortgaged);
  if (mortgagedInSet !== undefined) {
    return `Lift the mortgage on ${BOARD_TILES[mortgagedInSet].name} before building in this color set`;
  }
  if (prop.buildLevel >= 4) return `${tile.name} is already a Landmark`;
  if (prop.buildLevel === 0 && player.lapsCompleted < 1) {
    return 'Pass GO once before you start building houses';
  }
  if (prop.buildLevel === 3) {
    if (prop.forceBought) {
      return `Landmark locked. ${tile.name} was force-bought and cannot become a Landmark.`;
    }
    const group = COLOR_GROUPS[tile.group] ?? [tileIndex];
    const fullyBuilt = group.every((i) => {
      const p = state.properties[i];
      return p?.ownerId === player.playerId && p.buildLevel >= 3 && !p.isMortgaged;
    });
    if (!fullyBuilt) {
      return 'A Landmark needs the whole color set owned and built up to Hotels first';
    }
  }
  const supply = supplyBlockReason(state, prop.buildLevel);
  if (supply) return supply;
  const cost = effectiveBuildCost(state, tileIndex);
  if (player.money < cost) {
    return `Upgrade costs $${cost}, you have $${player.money}`;
  }
  return null;
}

// Building pieces a level holds: Lv1 = 1 house, Lv2 = 2 houses,
// Lv3 (Hotel) and Lv4 (Landmark on top of the hotel) = 1 hotel.
export function piecesAt(level: number): { houses: number; hotels: number } {
  if (level <= 0) return { houses: 0, hotels: 0 };
  if (level <= 2) return { houses: level, hotels: 0 };
  return { houses: 0, hotels: 1 };
}

/** Bank supply check for upgrading from `level` (null = pieces available). */
export function supplyBlockReason(state: GameState, level: number): string | null {
  const bank = state.bank;
  if (!bank) return null;
  if ((level === 0 || level === 1) && bank.houses < 1) {
    return 'Housing shortage: the Bank has no houses left';
  }
  if (level === 2 && bank.hotels < 1) {
    return 'The Bank has no hotels left';
  }
  return null;
}

/** Why a property cannot be traded (null = tradeable). */
// Deeds change hands together with their buildings (house rule: no need to
// sell down first); mortgaged deeds can be traded too (see tradeMortgageFees).
export function tradeBlockReason(prop: PropertyState | undefined, ownerId: string): string | null {
  if (!prop || prop.ownerId !== ownerId) return 'Property is not owned by that player';
  return null;
}

/** Cash a player could raise by selling every building and mortgaging all land. */
export function liquidationValue(state: GameState, playerId: string): number {
  return Object.values(state.properties).reduce((sum, p) => {
    if (p.ownerId !== playerId) return sum;
    const tile = BOARD_TILES[p.tileIndex];
    const buildings = Math.floor(tile.buildCost / 2) * p.buildLevel;
    const land = p.isMortgaged ? 0 : Math.floor(tile.price / 2);
    return sum + buildings + land;
  }, 0);
}

// ------------------------------------------------------------------
// Mortgages (classic rules)
// ------------------------------------------------------------------

/** Cash the Bank lends when a deed is mortgaged (half the price). */
export function mortgageValue(tileIndex: number): number {
  return Math.floor((BOARD_TILES[tileIndex]?.price ?? 0) / 2);
}

/** Lifting a mortgage: the mortgage value plus 10% interest. */
export function unmortgageCost(tileIndex: number): number {
  return mortgageValue(tileIndex) + mortgageTransferFee(tileIndex);
}

/** 10% interest a new owner pays when a mortgaged deed changes hands. */
export function mortgageTransferFee(tileIndex: number): number {
  return Math.ceil(mortgageValue(tileIndex) / 10);
}

/** Half the build cost back per building level sold to the Bank. */
export function buildingRefund(tileIndex: number, levels: number): number {
  return Math.floor((BOARD_TILES[tileIndex]?.buildCost ?? 0) / 2) * Math.max(0, levels);
}

/** Why `playerId` cannot mortgage `tileIndex` (null = allowed). */
export function mortgageBlockReason(state: GameState, playerId: string, tileIndex: number): string | null {
  const tile = BOARD_TILES[tileIndex];
  const prop = state.properties[tileIndex];
  if (!tile || !prop || prop.ownerId !== playerId) return 'You do not own this property';
  if (prop.isMortgaged) return `${tile.name} is already mortgaged`;
  // Only bare land: every building in the color set must be sold first.
  const built = (COLOR_GROUPS[tile.group] ?? [tileIndex]).filter((i) => (state.properties[i]?.buildLevel ?? 0) > 0);
  if (built.length) {
    const names = built.map((i) => BOARD_TILES[i].name).join(', ');
    return `Sell the buildings in this color set first (${names})`;
  }
  return null;
}

/** Cash received when selling a whole deed (and its buildings) to the Bank. */
export function sellToBankValue(prop: PropertyState): number {
  // A mortgaged deed returns nothing: the Bank keeps it to cancel the loan.
  const land = prop.isMortgaged ? 0 : mortgageValue(prop.tileIndex);
  return land + buildingRefund(prop.tileIndex, prop.buildLevel);
}

/** Fees `receiverId` pays for mortgaged deeds received in a trade. */
export function tradeMortgageFees(state: GameState, props: number[]): number {
  return props.reduce((sum, i) => sum + (state.properties[i]?.isMortgaged ? mortgageTransferFee(i) : 0), 0);
}
