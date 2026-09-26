import { BOARD_TILES, GO_TILE_INDEX, GameState, PlayerState, PropertyState, TileDef, buildBlockReason } from '@monopoly/shared';
import { useGameStore } from '../../store/gameStore.js';

export interface UpgradeOption {
  prop: PropertyState;
  tile: TileDef;
  nextLevel: number;
  cost: number;
  affordable: boolean;
  // Rule that blocks it (pass GO first, landmark set rule...), null if allowed.
  blocked: string | null;
}

export interface TurnInfo {
  game: GameState;
  me: PlayerState | undefined;
  current: PlayerState;
  isMyTurn: boolean;
  isWalking: boolean;
  d1: number;
  d2: number;
  // Roll / end turn / upgrade allowed right now.
  canAct: boolean;
  // Sell / mortgage allowed right now (also during my debt).
  canManage: boolean;
  upgrade: UpgradeOption | null;
  // Landing exactly on GO: every owned property you can build on, not just
  // the one you're standing on.
  goBuildOptions: UpgradeOption[];
}

// The server only allows upgrading the tile you stand on (LINE Get Rich
// rule) -- except landing exactly on GO, which allows building anywhere you
// own. Returns null when there is nothing to upgrade at `tileIndex` at all.
export function upgradeOptionFor(game: GameState, me: PlayerState | undefined, tileIndex: number): UpgradeOption | null {
  if (!me) return null;
  const prop = game.properties[tileIndex];
  const tile = BOARD_TILES[tileIndex];
  if (!prop || !tile || prop.ownerId !== me.playerId) return null;
  if (prop.isMortgaged || tile.buildCost <= 0 || prop.buildLevel >= 4) return null;
  if (prop.buildLevel === 3 && prop.forceBought) return null;
  const blocked = buildBlockReason(game, me, tileIndex);
  const affordable = me.money >= tile.buildCost;
  return {
    prop,
    tile,
    nextLevel: prop.buildLevel + 1,
    cost: tile.buildCost,
    affordable,
    // Cash shortage is shown as a disabled price, not as a rule message.
    blocked: affordable ? blocked : null
  };
}

// Every property `me` owns that could in principle take another level, from
// a GO building spree -- including ones a rule currently blocks (mortgaged
// sibling in the set, bank out of supply, not yet past GO...). Those are
// still listed, disabled, with the reason shown: silently dropping them made
// the spree look broken ("some of my land just isn't in the list").
function goBuildOptionsFor(game: GameState, me: PlayerState | undefined): UpgradeOption[] {
  if (!me || me.position !== GO_TILE_INDEX) return [];
  const options: UpgradeOption[] = [];
  for (const tile of BOARD_TILES) {
    if (game.properties[tile.index]?.ownerId !== me.playerId) continue;
    const option = upgradeOptionFor(game, me, tile.index);
    if (option) options.push(option);
  }
  return options;
}

export function useTurn(): TurnInfo | null {
  const game = useGameStore((s) => s.gameState);
  const myPlayerId = useGameStore((s) => s.myPlayerId);
  const isWalking = useGameStore((s) => s.isWalking);
  const diceRoll = useGameStore((s) => s.diceRoll);

  if (!game) return null;
  const current = game.players[game.currentPlayerIndex];
  if (!current) return null;
  const me = game.players.find((p) => p.playerId === myPlayerId);
  const isMyTurn = current.playerId === myPlayerId;
  const canAct = isMyTurn && !isWalking && (game.phase === 'ROLLING' || game.phase === 'TURN_ENDED');
  const canManage = isMyTurn && (game.phase === 'ROLLING' || game.phase === 'TURN_ENDED' || game.phase === 'DEBT');

  return {
    game,
    me,
    current,
    isMyTurn,
    isWalking,
    d1: diceRoll?.d1 ?? game.dice?.[0] ?? 1,
    d2: diceRoll?.d2 ?? game.dice?.[1] ?? 1,
    canAct,
    canManage,
    upgrade: canAct && me ? upgradeOptionFor(game, me, me.position) : null,
    goBuildOptions: canAct ? goBuildOptionsFor(game, me) : []
  };
}
