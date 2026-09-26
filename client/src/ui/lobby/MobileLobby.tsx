import React from 'react';
import { ForceBuyMode, PlayerColor, RoomState, Seat, TokenType } from '@monopoly/shared';
import { Check, ChevronLeft, Copy, Crown, Lock, Play, Share2, Shuffle, Swords, Timer, Trophy, UserPlus, X } from 'lucide-react';
import { Logo, Sky } from '../common/Sky.js';
import { PlayerAvatar } from '../common/PlayerAvatar.js';
import { TOKENS, COLORS } from '../lobbyConstants.js';
import { useGameStore } from '../../store/gameStore.js';
import { audioManager } from '../../sound/audioManager.js';

export interface LobbyActions {
  copyCode: () => void;
  share: (() => void) | null;
  selectToken: (t: TokenType) => void;
  selectColor: (c: PlayerColor) => void;
  toggleReady: () => void;
  start: () => void;
  leave: () => void;
  kick: (playerId: string) => void;
  toggleSpecialVictory: () => void;
  setTurnTimer: (sec: number) => void;
  setForceBuyMode: (mode: ForceBuyMode) => void;
  toggleRandomEvents: () => void;
}

export const FORCE_BUY_LABEL: Record<ForceBuyMode, string> = { off: 'Off', developed: 'Built only', any: 'Any deed' };

// Phone lobby: everything on about one screen. The seats sit in one row
// like chairs around the table, your look is two single rows, and the rules
// are compact rows (read-only chips for everyone but the host).
export const MobileLobby: React.FC<{
  room: RoomState;
  me: Seat | undefined;
  isHost: boolean;
  canStart: boolean;
  startHint: string;
  actions: LobbyActions;
}> = ({ room, me, isHost, canStart, startHint, actions }) => {
  const myPlayerId = useGameStore((s) => s.myPlayerId);
  const max = room.settings.maxPlayers || 6;
  const s = room.settings;
  const others = room.seats.filter((x) => x.playerId !== myPlayerId);
  const myToken = TOKENS.find((t) => t.type === me?.tokenType);

  return (
    <div className="menu-screen lobby-screen m-lobby">
      <Sky />

      <header className="m-lobby-bar">
        <button className="icon-btn" onClick={actions.leave} aria-label="Leave room" title="Leave room">
          <ChevronLeft size={20} strokeWidth={3} />
        </button>
        <Logo size="sm" />
        <button
          className="icon-btn m-lobby-trophy"
          onClick={() => {
            audioManager.playClick();
            useGameStore.getState().setLeaderboardOpen(true);
          }}
          aria-label="Leaderboard"
          title="Leaderboard"
        >
          <Trophy size={19} strokeWidth={2.6} />
        </button>
      </header>

      <main className="m-lobby-body">
        {/* Room code + the table */}
        <section className="m-card m-table">
          <div className="m-code-row">
            <button className="m-code" onClick={actions.copyCode} title="Copy room code">
              <small>Room code</small>
              <b className="tnum">{room.roomId}</b>
            </button>
            <button className="icon-btn m-code-btn gold" onClick={actions.copyCode} aria-label="Copy code">
              <Copy size={18} />
            </button>
            {actions.share && (
              <button className="icon-btn m-code-btn blue" onClick={actions.share} aria-label="Share invite">
                <Share2 size={18} />
              </button>
            )}
          </div>

          <div className="m-seats-head">
            <span>Players</span>
            <b className="tnum">
              {room.seats.length}/{max}
            </b>
          </div>
          <ul className="m-seats">
            {Array.from({ length: max }, (_, i) => {
              const seat = room.seats[i];
              if (!seat) {
                return (
                  <li key={`e${i}`} className="m-seat empty" title="Open seat">
                    <span className="m-seat-empty">
                      <UserPlus size={16} />
                    </span>
                    <small>Open</small>
                  </li>
                );
              }
              const mine = seat.playerId === myPlayerId;
              const ready = seat.isHost || seat.isReady;
              return (
                <li key={seat.playerId} className={`m-seat ${mine ? 'me' : ''} ${seat.isConnected ? '' : 'offline'}`}>
                  <span className="m-seat-avatar">
                    <PlayerAvatar token={seat.tokenType} color={seat.color} size={46} online={seat.isConnected} />
                    {seat.isHost ? (
                      <span className="m-seat-badge host" aria-label="Host">
                        <Crown size={11} strokeWidth={3} />
                      </span>
                    ) : ready ? (
                      <span className="m-seat-badge ready" aria-label="Ready">
                        <Check size={11} strokeWidth={3.5} />
                      </span>
                    ) : null}
                    {isHost && !mine && (
                      <button className="m-seat-kick" onClick={() => actions.kick(seat.playerId)} aria-label={`Remove ${seat.displayName}`}>
                        <X size={11} strokeWidth={3.5} />
                      </button>
                    )}
                  </span>
                  <small className="truncate">{mine ? 'You' : seat.displayName}</small>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Your look */}
        {me && (
          <section className="m-card">
            <div className="m-card-title">
              Your token <b>{myToken?.label}</b>
            </div>
            <div className="m-token-row">
              {TOKENS.map((t) => {
                const takenBy = others.find((x) => x.tokenType === t.type);
                const active = me.tokenType === t.type;
                return (
                  <button
                    key={t.type}
                    className={`m-token ${active ? 'active' : ''}`}
                    onClick={() => actions.selectToken(t.type)}
                    disabled={!!takenBy}
                    aria-label={takenBy ? `${t.label}, taken by ${takenBy.displayName}` : t.label}
                    title={takenBy ? `Taken by ${takenBy.displayName}` : t.label}
                  >
                    <t.icon size={22} />
                    {takenBy && (
                      <span className="m-taken">
                        <Lock size={9} strokeWidth={3} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="m-card-title">Color</div>
            <div className="m-color-row">
              {COLORS.map((c) => {
                const takenBy = others.find((x) => x.color === c.color);
                const active = me.color === c.color;
                return (
                  <button
                    key={c.color}
                    className={`m-color ${active ? 'active' : ''}`}
                    style={{ '--c': c.hex } as React.CSSProperties}
                    onClick={() => actions.selectColor(c.color)}
                    disabled={!!takenBy}
                    aria-label={takenBy ? `${c.color}, taken by ${takenBy.displayName}` : c.color}
                  >
                    {active && <Check size={15} strokeWidth={3.5} />}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Rules */}
        <section className="m-card m-rules">
          <div className="m-card-title">
            Game rules {!isHost && <span className="m-host-note">Set by the host</span>}
          </div>

          <RuleRow icon={<Trophy size={16} />} title="Special victories" sub="3 full sets or a whole side wins">
            <button
              className={`switch ${s.specialVictory ? 'on' : ''}`}
              onClick={actions.toggleSpecialVictory}
              disabled={!isHost}
              role="switch"
              aria-checked={s.specialVictory}
              aria-label="Special victories"
            />
          </RuleRow>

          <RuleRow icon={<Shuffle size={16} />} title="Random events" sub="Bonuses, crashes, surprise auctions">
            <button
              className={`switch ${s.randomEvents ? 'on' : ''}`}
              onClick={actions.toggleRandomEvents}
              disabled={!isHost}
              role="switch"
              aria-checked={s.randomEvents}
              aria-label="Random events"
            />
          </RuleRow>

          <RuleRow icon={<Timer size={16} />} title="Turn timer" sub="Then the game plays for you" stacked>
            <div className="m-seg" role="radiogroup" aria-label="Turn timer">
              {[0, 60, 90, 120].map((sec) => (
                <button
                  key={sec}
                  role="radio"
                  aria-checked={s.turnTimeoutSec === sec}
                  className={s.turnTimeoutSec === sec ? 'active' : ''}
                  onClick={() => actions.setTurnTimer(sec)}
                  disabled={!isHost}
                >
                  {sec === 0 ? 'Off' : `${sec}s`}
                </button>
              ))}
            </div>
          </RuleRow>

          <RuleRow icon={<Swords size={16} />} title="Force-buy" sub="Buy a rival's city at double price" stacked>
            <div className="m-seg" role="radiogroup" aria-label="Force-buy">
              {(['off', 'developed', 'any'] as ForceBuyMode[]).map((mode) => (
                <button
                  key={mode}
                  role="radio"
                  aria-checked={s.forceBuyMode === mode}
                  className={s.forceBuyMode === mode ? 'active' : ''}
                  onClick={() => actions.setForceBuyMode(mode)}
                  disabled={!isHost}
                >
                  {FORCE_BUY_LABEL[mode]}
                </button>
              ))}
            </div>
          </RuleRow>
        </section>
      </main>

      <footer className="m-lobby-foot">
        <p className="lobby-hint">{isHost ? startHint : me?.isReady ? 'Waiting for the host to start.' : 'Pick your look, then ready up.'}</p>
        {isHost ? (
          <button className="btn btn-primary btn-xl btn-block btn-start" onClick={actions.start} disabled={!canStart}>
            <Play size={20} fill="currentColor" />
            <span>Start game</span>
          </button>
        ) : (
          <button
            className={`btn btn-xl btn-block btn-ready ${me?.isReady ? 'btn-secondary is-ready' : 'btn-success'}`}
            onClick={actions.toggleReady}
          >
            <Check size={20} strokeWidth={3} />
            <span>{me?.isReady ? "I'm ready (tap to undo)" : 'Ready up'}</span>
          </button>
        )}
      </footer>
    </div>
  );
};

const RuleRow: React.FC<{ icon: React.ReactNode; title: string; sub: string; stacked?: boolean; children: React.ReactNode }> = ({
  icon,
  title,
  sub,
  stacked,
  children
}) => (
  <div className={`m-rule ${stacked ? 'stacked' : ''}`}>
    <span className="m-rule-ic">{icon}</span>
    <span className="m-rule-text">
      <b>{title}</b>
      <small>{sub}</small>
    </span>
    {children}
  </div>
);
