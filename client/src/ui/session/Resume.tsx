import React, { useEffect, useState } from 'react';
import { ResumableGame } from '@monopoly/shared';
import { History, Play, X } from 'lucide-react';
import { socket, loadRecentSessions, adoptSession, forgetRecent, saveSession } from '../../net/socket.js';
import { useGameStore } from '../../store/gameStore.js';
import { useAccount } from '../../net/account.js';
import { audioManager } from '../../sound/audioManager.js';

/** Games this browser (or signed-in account) can go back to. */
export function useResumable(): [ResumableGame[], (roomId: string) => void] {
  const [games, setGames] = useState<ResumableGame[]>([]);
  const uid = useAccount((s) => s.uid);

  useEffect(() => {
    let alive = true;
    const ask = () => {
      const sessions = loadRecentSessions().map(({ roomId, playerId, token }) => ({ roomId, playerId, token }));
      socket.emit('session:list', { sessions }, (list) => {
        if (!alive) return;
        // Forget saved seats the server no longer knows (finished / closed).
        const live = new Set(list.map((g) => `${g.roomId}:${g.playerId}`));
        loadRecentSessions()
          .filter((s) => !live.has(`${s.roomId}:${s.playerId}`))
          .forEach((s) => forgetRecent(s.roomId, s.playerId));
        setGames(list);
      });
    };
    if (socket.connected) ask();
    socket.on('connect', ask);
    return () => {
      alive = false;
      socket.off('connect', ask);
    };
  }, [uid]);

  return [games, (roomId) => setGames((g) => g.filter((x) => x.roomId !== roomId))];
}

/** Rejoin a saved seat; `done(error)` reports failure (seat forgotten then). */
export function resumeGame(g: ResumableGame, done: (error?: string) => void): void {
  const saved = loadRecentSessions().find((s) => s.roomId === g.roomId && s.playerId === g.playerId);
  const token = g.token ?? saved?.token;
  audioManager.playClick();
  socket.emit('room:reconnect', { roomId: g.roomId, playerId: g.playerId, token, name: g.myName }, (res) => {
    if (!res.ok) {
      forgetRecent(g.roomId, g.playerId);
      done(res.error || 'That game is no longer available');
      return;
    }
    const session = { roomId: g.roomId, playerId: g.playerId, token: res.token ?? token ?? '', name: g.myName };
    adoptSession(session);
    saveSession(session);
    useGameStore.getState().setMyPlayerId(g.playerId);
    audioManager.playJoin();
    done();
  });
}

export const ResumeCard: React.FC = () => {
  const [games, dismiss] = useResumable();
  const [busy, setBusy] = useState<string | null>(null);
  const addToast = useGameStore((s) => s.addToast);
  if (games.length === 0) return null;

  const resume = (g: ResumableGame) => {
    setBusy(g.roomId);
    resumeGame(g, (error) => {
      setBusy(null);
      if (error) {
        addToast(error, 'warning');
        dismiss(g.roomId);
      }
    });
  };

  return (
    <div className="resume-card" role="region" aria-label="Resume a game">
      <span className="resume-head">
        <History size={15} /> Continue where you left off
      </span>
      {games.slice(0, 3).map((g) => (
        <div key={g.roomId} className="resume-row">
          <span className="resume-code tnum">{g.roomId}</span>
          <span className="resume-info">
            <b>{g.status === 'waiting' ? 'In the lobby' : `Turn ${g.turnNumber ?? 1}`}</b>
            <small className="truncate">
              as {g.myName} · with {g.players.filter((p) => p !== g.myName).join(', ') || 'nobody yet'}
            </small>
          </span>
          <button className="btn btn-success btn-sm btn-resume" onClick={() => resume(g)} disabled={busy !== null}>
            <Play size={14} fill="currentColor" /> {busy === g.roomId ? 'Joining…' : 'Resume'}
          </button>
          <button
            className="icon-btn resume-x"
            aria-label="Forget this game"
            title="Forget this game on this device"
            onClick={() => {
              forgetRecent(g.roomId, g.playerId);
              dismiss(g.roomId);
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};
