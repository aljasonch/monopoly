import React from 'react';
import { socket, clearSession } from '../net/socket.js';
import { useGameStore } from '../store/gameStore.js';
import { TokenType, PlayerColor, ForceBuyMode, PROTOCOL_VERSION } from '@monopoly/shared';
import { Check, ChevronLeft, Copy, Play, Share2, Shuffle, Swords, Timer, Trophy, Users, Palette, Shapes } from 'lucide-react';
import { LeaderboardButton } from './session/Leaderboard.js';
import { TOKENS, COLORS } from './lobbyConstants.js';
import { LobbySeats } from './LobbySeats.js';
import { MobileLobby } from './lobby/MobileLobby.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { Logo, Sky } from './common/Sky.js';

export const LobbyScreen: React.FC = () => {
  const roomState = useGameStore((s) => s.roomState);
  const myPlayerId = useGameStore((s) => s.myPlayerId);
  const resetAll = useGameStore((s) => s.resetAll);
  const addToast = useGameStore((s) => s.addToast);

  const isMobile = useIsMobile();

  if (!roomState) return null;
  // Rooms from an older server (or saved before these settings existed) may
  // not carry them: show the defaults instead of an empty selector.
  const settings = {
    ...roomState.settings,
    forceBuyMode: roomState.settings.forceBuyMode ?? ('developed' as ForceBuyMode),
    randomEvents: roomState.settings.randomEvents ?? true
  };
  const mySeat = roomState.seats.find((s) => s.playerId === myPlayerId);
  const isHost = mySeat?.isHost ?? false;
  const others = roomState.seats.filter((s) => s.playerId !== myPlayerId);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const notReady = roomState.seats.filter((s) => !s.isReady && !s.isHost).length;
  const canStart = roomState.seats.length >= 2 && notReady === 0;
  const startHint =
    roomState.seats.length < 2
      ? 'Invite at least one more player to start.'
      : notReady > 0
        ? `Waiting for ${notReady} player${notReady > 1 ? 's' : ''} to ready up.`
        : 'Everyone is ready. Start when you like.';

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(roomState.roomId).then(
      () => addToast('Room code copied', 'success'),
      () => addToast(`Room code: ${roomState.roomId}`, 'info')
    );
  };

  const handleShare = () => {
    navigator
      .share({
        title: 'TMpoly',
        text: `Join my TMpoly game. Room code: ${roomState.roomId}`,
        url: window.location.origin
      })
      .catch(() => {});
  };

  const handleSelectToken = (token: TokenType) => {
    if (!mySeat) return;
    socket.emit('room:selectToken', { tokenType: token, color: mySeat.color });
  };

  const handleSelectColor = (color: PlayerColor) => {
    if (!mySeat) return;
    socket.emit('room:selectToken', { tokenType: mySeat.tokenType, color });
  };

  const handleToggleReady = () => {
    if (!mySeat) return;
    socket.emit('room:ready', { ready: !mySeat.isReady });
  };

  const handleToggleSpecialVictory = () => {
    if (!isHost) return;
    socket.emit('room:toggleSpecialVictory', { enabled: !roomState.settings.specialVictory });
  };

  const handleStartGame = () => {
    if (!isHost) return;
    socket.emit('room:start');
  };

  const handleTurnTimer = (seconds: number) => {
    if (!isHost) return;
    socket.emit('room:setTurnTimer', { seconds });
  };

  const handleForceBuyMode = (mode: ForceBuyMode) => {
    if (!isHost) return;
    socket.emit('room:setForceBuyMode', { mode });
  };

  const handleToggleRandomEvents = () => {
    if (!isHost) return;
    socket.emit('room:setRandomEvents', { enabled: !settings.randomEvents });
  };

  const handleKick = (playerId: string) => {
    socket.emit('room:kick', { playerId });
  };

  const handleLeave = () => {
    socket.emit('room:leave');
    clearSession();
    resetAll();
  };

  const outdated = (roomState.protocol ?? 0) < PROTOCOL_VERSION ? <ServerOutdated /> : null;

  if (isMobile) {
    return (
      <>
      {outdated}
      <MobileLobby
        room={{ ...roomState, settings }}
        me={mySeat}
        isHost={isHost}
        canStart={canStart}
        startHint={startHint}
        actions={{
          copyCode: handleCopyCode,
          share: canShare ? handleShare : null,
          selectToken: handleSelectToken,
          selectColor: handleSelectColor,
          toggleReady: handleToggleReady,
          start: handleStartGame,
          leave: handleLeave,
          kick: handleKick,
          toggleSpecialVictory: handleToggleSpecialVictory,
          setTurnTimer: handleTurnTimer,
          setForceBuyMode: handleForceBuyMode,
          toggleRandomEvents: handleToggleRandomEvents
        }}
      />
      </>
    );
  }

  return (
    <div className="menu-screen lobby-screen">
      <Sky />
      {outdated}

      <header className="lobby-appbar">
        <button className="btn btn-ghost btn-sm btn-leave" onClick={handleLeave}>
          <ChevronLeft size={18} />
          <span>Leave</span>
        </button>
        <Logo size="sm" />
        <span className="lobby-appbar-spacer">
          <LeaderboardButton className="btn-sm" />
        </span>
      </header>

      <div className="lobby-layout">
        <div className="lobby-main">
          <section className="card paper room-card">
            <div className="room-code-block">
              <span className="section-title">Room code</span>
              <button className="code-display" onClick={handleCopyCode} title="Copy room code">
                <h2>{roomState.roomId}</h2>
              </button>
              <p className="room-hint">Friends join from the home screen with this code.</p>
            </div>
            <div className="room-actions">
              <button className="btn btn-gold" onClick={handleCopyCode}>
                <Copy size={16} /> Copy
              </button>
              {canShare && (
                <button className="btn btn-blue" onClick={handleShare}>
                  <Share2 size={16} /> Share
                </button>
              )}
            </div>
          </section>

          <section className="card paper">
            <div className="card-head">
              <span className="section-title">
                <Users size={14} /> Players
              </span>
              <span className="seat-count tnum">
                {roomState.seats.length}
                <span>/{roomState.settings.maxPlayers || 6}</span>
              </span>
            </div>
            <LobbySeats
              seats={roomState.seats}
              myPlayerId={myPlayerId}
              maxPlayers={roomState.settings.maxPlayers || 6}
              onKick={isHost ? handleKick : undefined}
            />
          </section>
        </div>

        <div className="lobby-side">
          {mySeat && (
            <section className="card paper">
              <div className="card-head">
                <span className="section-title">
                  <Shapes size={14} /> Your token
                </span>
              </div>
              <div className="token-grid">
                {TOKENS.map((t) => {
                  const takenBy = others.find((s) => s.tokenType === t.type);
                  const active = mySeat.tokenType === t.type;
                  return (
                    <button
                      key={t.type}
                      className={`token-option ${active ? 'active' : ''}`}
                      onClick={() => handleSelectToken(t.type)}
                      disabled={!!takenBy}
                      title={takenBy ? `Taken by ${takenBy.displayName}` : t.label}
                    >
                      <t.icon size={24} />
                      <span>{t.label}</span>
                      {takenBy && <span className="token-taken">{takenBy.displayName}</span>}
                    </button>
                  );
                })}
              </div>

              <div className="card-head" style={{ marginTop: 18 }}>
                <span className="section-title">
                  <Palette size={14} /> Color
                </span>
              </div>
              <div className="color-row">
                {COLORS.map((c) => {
                  const takenBy = others.find((s) => s.color === c.color);
                  const active = mySeat.color === c.color;
                  return (
                    <button
                      key={c.color}
                      className={`color-swatch ${active ? 'active' : ''}`}
                      style={{ '--c': c.hex } as React.CSSProperties}
                      onClick={() => handleSelectColor(c.color)}
                      disabled={!!takenBy}
                      aria-label={takenBy ? `${c.color}, taken by ${takenBy.displayName}` : c.color}
                    >
                      {active && <Check size={16} strokeWidth={3} />}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <section className="card paper">
            <div className="setting-row">
              <span className="setting-icon">
                <Trophy size={18} />
              </span>
              <div className="setting-copy">
                <strong>Special victories</strong>
                <span>Win instantly with 3 full color sets or every property on one side.</span>
              </div>
              <button
                className={`switch ${roomState.settings.specialVictory ? 'on' : ''}`}
                onClick={handleToggleSpecialVictory}
                disabled={!isHost}
                role="switch"
                aria-checked={roomState.settings.specialVictory}
                title={isHost ? 'Toggle special victories' : 'Only the host can change this'}
              />
            </div>
            <div className="setting-row">
              <span className="setting-icon">
                <Timer size={18} />
              </span>
              <div className="setting-copy">
                <strong>Turn timer</strong>
                <span>Time per decision before the game plays it for you.</span>
              </div>
            </div>
            <div className="segmented small timer-choice" role="radiogroup" aria-label="Turn timer">
              {[0, 60, 90, 120].map((sec) => (
                <button
                  key={sec}
                  role="radio"
                  aria-checked={roomState.settings.turnTimeoutSec === sec}
                  className={roomState.settings.turnTimeoutSec === sec ? 'active' : ''}
                  onClick={() => handleTurnTimer(sec)}
                  disabled={!isHost}
                  title={isHost ? undefined : 'Only the host can change this'}
                >
                  {sec === 0 ? 'Off' : `${sec}s`}
                </button>
              ))}
            </div>

            <div className="setting-row">
              <span className="setting-icon">
                <Swords size={18} />
              </span>
              <div className="setting-copy">
                <strong>Force-buy</strong>
                <span>Land on a rival's deed and buy it from them at double price.</span>
              </div>
            </div>
            <div className="segmented small" role="radiogroup" aria-label="Force-buy mode">
              {(
                [
                  ['off', 'Off'],
                  ['developed', 'Built only'],
                  ['any', 'Any deed']
                ] as [ForceBuyMode, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  role="radio"
                  aria-checked={settings.forceBuyMode === mode}
                  className={settings.forceBuyMode === mode ? 'active' : ''}
                  onClick={() => handleForceBuyMode(mode)}
                  disabled={!isHost}
                  title={isHost ? undefined : 'Only the host can change this'}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="setting-row">
              <span className="setting-icon">
                <Shuffle size={18} />
              </span>
              <div className="setting-copy">
                <strong>Random events</strong>
                <span>Occasional board-wide surprises: bank bonuses, market crashes, surprise auctions.</span>
              </div>
              <button
                className={`switch ${settings.randomEvents ? 'on' : ''}`}
                onClick={handleToggleRandomEvents}
                disabled={!isHost}
                role="switch"
                aria-checked={settings.randomEvents}
                title={isHost ? 'Toggle random events' : 'Only the host can change this'}
              />
            </div>
          </section>


          <div className="lobby-actions">
            {isHost ? (
              <button className="btn btn-primary btn-xl btn-block btn-start" onClick={handleStartGame} disabled={!canStart}>
                <Play size={20} fill="currentColor" />
                <span>Start game</span>
              </button>
            ) : (
              <button
                className={`btn btn-xl btn-block btn-ready ${mySeat?.isReady ? 'btn-secondary is-ready' : 'btn-success'}`}
                onClick={handleToggleReady}
              >
                <Check size={20} strokeWidth={3} />
                <span>{mySeat?.isReady ? "I'm ready (tap to undo)" : 'Ready up'}</span>
              </button>
            )}
            <p className="lobby-hint">{isHost ? startHint : mySeat?.isReady ? 'Waiting for the host to start.' : 'Pick your token, then ready up.'}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

// The server runs older code than this page: new lobby settings would be
// ignored, so say so plainly (the fix is rebuilding + restarting it).
const ServerOutdated: React.FC = () => (
  <div className="server-outdated" role="alert">
    <b>The game server needs an update.</b> Some settings (force-buy, random events) will not work until the host
    rebuilds and restarts it (<code>npm run build</code>, then restart).
  </div>
);
