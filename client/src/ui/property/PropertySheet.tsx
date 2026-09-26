import React, { useEffect, useState } from 'react';
import {
  BOARD_TILES,
  COLOR_GROUPS,
  COUNTRY_NAMES,
  GameState,
  PlayerState,
  PropertyState,
  buildingRefund,
  mortgageBlockReason,
  mortgageValue,
  sellToBankValue,
  unmortgageCost
} from '@monopoly/shared';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Banknote,
  Building2,
  Castle,
  Crown,
  Home,
  Landmark,
  Lightbulb,
  Lock,
  MapPin,
  Plane,
  Shield,
  Undo2,
  X
} from 'lucide-react';
import { useGameStore } from '../../store/gameStore.js';
import { socket } from '../../net/socket.js';
import { audioManager } from '../../sound/audioManager.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { Flag } from '../common/Flag.js';
import { PlayerAvatar } from '../common/PlayerAvatar.js';
import { GROUP_HEX, GROUP_LABEL, LEVEL_NAMES, money, playerHex, rentLabel } from '../theme.js';
import { upgradeOptionFor } from '../game/useTurn.js';

const RAILROADS = [5, 15, 25, 35];
const UTILITIES = [12, 28];
const LEVEL_ICONS = [MapPin, Home, Building2, Castle, Crown];

// Force-buy price (mirrors server/src/engine/forceBuy.ts).
const takeoverPrice = (tileIndex: number, level: number) => {
  const t = BOARD_TILES[tileIndex];
  return (t.price + t.buildCost * level) * 2;
};

interface Row {
  key: string;
  label: string;
  value: string;
  icon?: React.ReactNode;
  current: boolean;
  note?: string;
}

function rentRows(game: GameState, prop: PropertyState | undefined, tileIndex: number): Row[] {
  const tile = BOARD_TILES[tileIndex];
  const owner = prop?.ownerId ?? null;
  const ownsActive = (i: number) => !!owner && game.properties[i]?.ownerId === owner && !game.properties[i]?.isMortgaged;
  if (tile.type === 'railroad') {
    const n = owner ? RAILROADS.filter(ownsActive).length : 0;
    return [1, 2, 3, 4].map((k) => ({
      key: `r${k}`,
      label: k === 1 ? '1 airport owned' : `${k} airports owned`,
      value: money(25 * Math.pow(2, k - 1)),
      icon: <Plane size={15} />,
      current: !!owner && !prop?.isMortgaged && n === k
    }));
  }
  if (tile.type === 'utility') {
    const n = owner ? UTILITIES.filter(ownsActive).length : 0;
    return [
      { key: 'u1', label: '1 utility owned', value: '4x dice', icon: <Lightbulb size={15} />, current: !!owner && !prop?.isMortgaged && n === 1 },
      { key: 'u2', label: 'Both utilities', value: '10x dice', icon: <Lightbulb size={15} />, current: !!owner && !prop?.isMortgaged && n === 2 }
    ];
  }
  const group = COLOR_GROUPS[tile.group] ?? [tileIndex];
  const fullSet = !!owner && group.every((i) => game.properties[i]?.ownerId === owner);
  const level = prop?.buildLevel ?? 0;
  const live = !!owner && !prop?.isMortgaged;
  const rows: Row[] = [
    { key: 'l0', label: 'Land', value: money(tile.rentByLevel[0]), current: live && level === 0 && !fullSet },
    { key: 'l0s', label: 'Land, full color set', value: money(tile.rentByLevel[0] * 2), current: live && level === 0 && fullSet }
  ];
  for (let l = 1; l <= 4; l++) {
    rows.push({
      key: `l${l}`,
      label: `With ${LEVEL_NAMES[l].toLowerCase()}`,
      value: money(tile.rentByLevel[l]),
      current: live && level === l,
      note: l === 4 ? 'Protected' : `Takeover ${money(takeoverPrice(tileIndex, l))}`
    });
  }
  return rows.map((r, i) => {
    const Icon = LEVEL_ICONS[Math.max(0, i - 1)];
    return { ...r, icon: <Icon size={15} /> };
  });
}

// Detail sheet for any tile: who owns it, what a visitor pays now, the full
// rent ladder, and (for the owner) selling / mortgaging at any time.
export const PropertySheet: React.FC = () => {
  const tileIndex = useGameStore((s) => s.infoTile);
  const setInfoTile = useGameStore((s) => s.setInfoTile);
  const game = useGameStore((s) => s.gameState);
  const myPlayerId = useGameStore((s) => s.myPlayerId);
  const isWalking = useGameStore((s) => s.isWalking);
  const isMobile = useIsMobile();
  const [confirmSell, setConfirmSell] = useState(false);

  useEffect(() => setConfirmSell(false), [tileIndex]);
  useEffect(() => {
    if (tileIndex === null) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setInfoTile(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tileIndex, setInfoTile]);

  if (tileIndex === null || !game) return null;
  const tile = BOARD_TILES[tileIndex];
  if (!tile) return null;
  const prop = game.properties[tileIndex];
  const purchasable = tile.price > 0 && !!prop;
  const owner = prop?.ownerId ? game.players.find((p) => p.playerId === prop.ownerId) : undefined;
  const me = game.players.find((p) => p.playerId === myPlayerId);
  const mine = !!owner && owner.playerId === myPlayerId;
  const close = () => setInfoTile(null);

  const head = (
    <header className="ps-head" style={{ '--g': GROUP_HEX[tile.group] } as React.CSSProperties}>
      <div className="ps-band">
        {tile.country ? <Flag country={tile.country} size={40} className="ps-flag" /> : tile.type === 'railroad' ? <Plane size={30} /> : tile.type === 'utility' ? <Lightbulb size={30} /> : <MapPin size={28} />}
        <div className="ps-title">
          <small>{tile.country ? COUNTRY_NAMES[tile.country] : purchasable ? GROUP_LABEL[tile.group] : 'Board space'}</small>
          <h3>{tile.name}</h3>
        </div>
        <button className="icon-btn ps-close" onClick={close} aria-label="Close">
          <X size={18} />
        </button>
      </div>
    </header>
  );

  if (!purchasable || !prop) {
    return (
      <SheetFrame mobile={isMobile} onClose={close}>
        {head}
        <div className="ps-body">
          <p className="ps-plain">{describeSpecial(tile.type, tile.rentByLevel[0])}</p>
        </div>
      </SheetFrame>
    );
  }

  const rows = rentRows(game, prop, tileIndex);
  const payNow = owner ? rentLabel(game, prop) : null;
  const isBuildable = tile.buildCost > 0;

  return (
    <SheetFrame mobile={isMobile} onClose={close}>
      {head}
      <div className="ps-body">
        <div className="ps-status">
          {owner ? (
            <span className="ps-owner" style={{ '--c': playerHex(owner.color) } as React.CSSProperties}>
              <PlayerAvatar token={owner.tokenType} color={owner.color} size={30} />
              <span>
                <small>Owner</small>
                <b>{mine ? 'You' : owner.name}</b>
              </span>
            </span>
          ) : (
            <span className="ps-owner bank">
              <span className="ps-bank-icon">
                <Landmark size={18} />
              </span>
              <span>
                <small>Owner</small>
                <b>The Bank · for sale {money(tile.price)}</b>
              </span>
            </span>
          )}
          {isBuildable && owner && (
            <span className="ps-level">
              <small>Level</small>
              <b>{LEVEL_NAMES[prop.buildLevel]}</b>
            </span>
          )}
          {prop.isMortgaged && <span className="badge red">Mortgaged</span>}
          {prop.forceBought && (
            <span className="badge" title="Force-bought: this property can never become a Landmark">
              <Lock size={11} /> No landmark
            </span>
          )}
        </div>

        {owner && (
          <div className={`ps-pay ${prop.isMortgaged ? 'off' : ''} ${mine ? 'mine' : ''}`}>
            <span>{prop.isMortgaged ? 'Mortgaged: no rent is collected here' : mine ? 'Visitors pay you' : 'If you land here you pay'}</span>
            <strong className="tnum">{prop.isMortgaged ? '$0' : payNow}</strong>
          </div>
        )}

        <table className="ps-ladder">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.current ? 'current' : ''}>
                <td className="ps-ic">{r.icon}</td>
                <td>
                  {r.label}
                  {r.current && <span className="ps-here">now</span>}
                </td>
                <td className="tnum ps-val">{r.value}</td>
                {isBuildable && <td className="ps-note">{r.note ?? ''}</td>}
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="ps-facts">
          <div>
            <dt>Price</dt>
            <dd className="tnum">{money(tile.price)}</dd>
          </div>
          {isBuildable && (
            <div>
              <dt>Each upgrade</dt>
              <dd className="tnum">{money(tile.buildCost)}</dd>
            </div>
          )}
          <div>
            <dt>Mortgage value</dt>
            <dd className="tnum">{money(mortgageValue(tileIndex))}</dd>
          </div>
          <div>
            <dt>Lift mortgage</dt>
            <dd className="tnum">{money(unmortgageCost(tileIndex))}</dd>
          </div>
        </dl>

        <SetStrip game={game} tileIndex={tileIndex} />

        {mine && me && !me.isBankrupt && game.phase !== 'GAME_OVER' && (
          <Manage
            game={game}
            me={me}
            prop={prop}
            isWalking={isWalking}
            confirmSell={confirmSell}
            setConfirmSell={setConfirmSell}
          />
        )}
      </div>
    </SheetFrame>
  );
};

const SheetFrame: React.FC<{ mobile: boolean; onClose: () => void; children: React.ReactNode }> = ({ mobile, onClose, children }) => (
  <div className={`ps-layer ${mobile ? 'mobile' : ''}`}>
    {mobile && <div className="ps-scrim" onClick={onClose} />}
    <div className="ps-sheet" role="dialog" aria-label="Property details">
      {children}
    </div>
  </div>
);

function describeSpecial(type: string, amount: number): string {
  switch (type) {
    case 'go':
      return 'Collect $200 salary every time you pass GO.';
    case 'jail':
      return 'Just visiting, or serving time. Roll doubles, pay $50 or use a Get Out of Jail Free card to leave.';
    case 'parking':
      return 'A free resting spot. Nothing happens here.';
    case 'gotojail':
      return 'Go directly to Jail. Do not pass GO, do not collect $200.';
    case 'chance':
      return 'Draw a Chance card and do what it says.';
    case 'chest':
      return 'Draw a Community Chest card and do what it says.';
    case 'tax':
      return `Pay $${amount} to the Bank.`;
    default:
      return 'A special board space.';
  }
}

// Who owns each deed in the color set (and at what level).
const SetStrip: React.FC<{ game: GameState; tileIndex: number }> = ({ game, tileIndex }) => {
  const tile = BOARD_TILES[tileIndex];
  const group = COLOR_GROUPS[tile.group] ?? (tile.type === 'railroad' ? RAILROADS : tile.type === 'utility' ? UTILITIES : null);
  const setInfoTile = useGameStore((s) => s.setInfoTile);
  if (!group) return null;
  return (
    <div className="ps-set">
      <h4>{GROUP_LABEL[tile.group]} set</h4>
      <div className="ps-set-row">
        {group.map((i) => {
          const p = game.properties[i];
          const o = p?.ownerId ? game.players.find((pl) => pl.playerId === p.ownerId) : undefined;
          return (
            <button
              key={i}
              className={`ps-set-chip ${i === tileIndex ? 'active' : ''}`}
              style={{ '--c': o ? playerHex(o.color) : 'transparent' } as React.CSSProperties}
              onClick={() => setInfoTile(i)}
            >
              <span className="truncate">{BOARD_TILES[i].name}</span>
              <small>
                {o ? o.name : 'Bank'}
                {p && p.buildLevel > 0 ? ` · ${LEVEL_NAMES[p.buildLevel]}` : ''}
                {p?.isMortgaged ? ' · M' : ''}
              </small>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const Manage: React.FC<{
  game: GameState;
  me: PlayerState;
  prop: PropertyState;
  isWalking: boolean;
  confirmSell: boolean;
  setConfirmSell: (v: boolean) => void;
}> = ({ game, me, prop, isWalking, confirmSell, setConfirmSell }) => {
  const tile = BOARD_TILES[prop.tileIndex];
  const emit = (fn: () => void) => {
    audioManager.playClick();
    fn();
  };
  const isMyTurn = game.players[game.currentPlayerIndex]?.playerId === me.playerId;
  const canAct = isMyTurn && !isWalking && (game.phase === 'ROLLING' || game.phase === 'TURN_ENDED');
  // Building here is legal on this tile's own turn-window, or on any owned
  // property while standing exactly on GO (checked by upgradeOptionFor).
  const upgradeHere = canAct ? upgradeOptionFor(game, me, prop.tileIndex) : null;
  const mortgageBlock = mortgageBlockReason(game, me.playerId, prop.tileIndex);
  const lift = unmortgageCost(prop.tileIndex);
  const sellAll = sellToBankValue(prop);

  return (
    <section className="ps-manage">
      <h4>
        <Shield size={15} /> Manage your property
      </h4>

      {upgradeHere && (
        <button
          className={`btn btn-sm btn-block ${upgradeHere.nextLevel === 4 ? 'btn-gold' : 'btn-blue'}`}
          disabled={!upgradeHere.affordable || !!upgradeHere.blocked}
          title={upgradeHere.blocked ?? undefined}
          onClick={() => emit(() => socket.emit('game:build', { tileIndex: prop.tileIndex }))}
        >
          <ArrowUpCircle size={16} /> Upgrade to {LEVEL_NAMES[upgradeHere.nextLevel]} · {money(upgradeHere.cost)}
        </button>
      )}

      {tile.buildCost > 0 && prop.buildLevel > 0 && (
        <div className="ps-sell-down">
          <span className="ps-label">
            <ArrowDownCircle size={15} /> Sell buildings back (half price)
          </span>
          <div className="ps-sell-grid">
            {Array.from({ length: prop.buildLevel }, (_, lvl) => lvl)
              .reverse()
              .map((lvl) => (
                <button
                  key={lvl}
                  className="ps-sell-btn"
                  onClick={() => emit(() => socket.emit('game:sell', { tileIndex: prop.tileIndex, toLevel: lvl }))}
                >
                  <span>to {LEVEL_NAMES[lvl]}</span>
                  <b className="tnum">+{money(buildingRefund(prop.tileIndex, prop.buildLevel - lvl))}</b>
                </button>
              ))}
          </div>
        </div>
      )}

      <div className="ps-row-actions">
        {prop.isMortgaged ? (
          <button
            className="btn btn-secondary btn-sm"
            disabled={me.money < lift}
            title={me.money < lift ? `You need ${money(lift)}` : undefined}
            onClick={() => emit(() => socket.emit('game:mortgage', { tileIndex: prop.tileIndex, mortgage: false }))}
          >
            <Undo2 size={15} /> Lift mortgage · {money(lift)}
          </button>
        ) : (
          <button
            className="btn btn-gold btn-sm"
            disabled={!!mortgageBlock}
            title={mortgageBlock ?? undefined}
            onClick={() => emit(() => socket.emit('game:mortgage', { tileIndex: prop.tileIndex, mortgage: true }))}
          >
            <Landmark size={15} /> Mortgage · +{money(mortgageValue(prop.tileIndex))}
          </button>
        )}
        <button
          className={`btn btn-sm ${confirmSell ? 'btn-danger' : 'btn-danger-soft'}`}
          onClick={() => {
            if (!confirmSell) return setConfirmSell(true);
            emit(() => socket.emit('game:sellProperty', { tileIndex: prop.tileIndex }));
            setConfirmSell(false);
          }}
        >
          <Banknote size={15} /> {confirmSell ? `Tap again: sell for ${money(sellAll)}` : `Sell to Bank · +${money(sellAll)}`}
        </button>
      </div>
      {!prop.isMortgaged && mortgageBlock && <p className="ps-hint">{mortgageBlock}</p>}
      <p className="ps-hint">
        {prop.isMortgaged
          ? 'Mortgaged deeds collect no rent. You can still trade it: the new owner pays 10% interest to the Bank.'
          : 'Only bare land can be mortgaged. Lifting a mortgage costs its value plus 10% interest.'}
      </p>
    </section>
  );
};
