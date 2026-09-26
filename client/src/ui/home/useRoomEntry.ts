import { useEffect, useState } from 'react';
import { socket, saveSession, loadSession, loadRecentSessions, saveLastName, loadLastName } from '../../net/socket.js';
import { useAccount } from '../../net/account.js';
import { useGameStore } from '../../store/gameStore.js';

/** Player name + create / join a room (shared by the phone and desktop home). */
export function useRoomEntry() {
  const saved = loadSession() ?? loadRecentSessions()[0] ?? null;
  const accountName = useAccount((s) => (s.anonymous ? null : s.name));
  const [name, setNameState] = useState(saved?.name || loadLastName());
  const [busy, setBusy] = useState(false);
  const addToast = useGameStore((s) => s.addToast);

  const setName = (v: string) => {
    setNameState(v);
    saveLastName(v.trim());
  };

  // Prefill from a Google account once it is known.
  useEffect(() => {
    if (accountName && !name) setName(accountName.slice(0, 15));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountName]);

  const create = () => {
    if (!name.trim()) return addToast('Enter your name first', 'warning');
    setBusy(true);
    socket.emit('room:create', { name: name.trim() }, (res) => {
      setBusy(false);
      if (!res.ok || !res.roomId || !res.playerId || !res.token) {
        addToast(res.error || 'Failed to create room', 'danger');
      } else {
        useGameStore.getState().setMyPlayerId(res.playerId);
        saveSession({ roomId: res.roomId, playerId: res.playerId, token: res.token, name: name.trim() });
      }
    });
  };

  const join = (rawCode: string) => {
    if (!name.trim()) return addToast('Enter your name first', 'warning');
    const code = rawCode.trim().toUpperCase();
    if (code.length < 6) return addToast('Enter the 6-character room code', 'warning');
    setBusy(true);
    // A seat this browser already holds in that room is reclaimed with its token.
    const mine = loadRecentSessions().find((r) => r.roomId === code);
    socket.emit('room:join', { roomId: code, name: name.trim(), token: mine?.token }, (res) => {
      setBusy(false);
      if (!res.ok || !res.playerId || !res.token) {
        addToast(res.error || 'Failed to join room', 'danger');
      } else {
        useGameStore.getState().setMyPlayerId(res.playerId);
        saveSession({ roomId: code, playerId: res.playerId, token: res.token, name: name.trim() });
      }
    });
  };

  return { name, setName, busy, create, join };
}
