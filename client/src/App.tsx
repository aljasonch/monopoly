import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useGameStore, initSocketListeners } from './store/gameStore.js';
import { socket, loadSession, clearSession, saveSession, loadRecentSessions, adoptSession } from './net/socket.js';
import { HomeScreen } from './ui/HomeScreen.js';
import { LobbyScreen } from './ui/LobbyScreen.js';
import { GameHUD } from './ui/GameHUD.js';
import { BuyPropertyModal } from './ui/BuyPropertyModal.js';
import { ForceBuyModal } from './ui/ForceBuyModal.js';
import { CardModal } from './ui/CardModal.js';
import { DebtPlanner } from './ui/debt/DebtPlanner.js';
import { PropertySheet } from './ui/property/PropertySheet.js';
import { VictoryOverlay } from './ui/VictoryOverlay.js';
import { ToastContainer } from './ui/ToastContainer.js';
// The 3D engine (three.js + scene) is its own chunk: menus load fast, and the
// lobby preloads it so the board appears instantly when the game starts.
const MonopolyScene = lazy(() => import('./three/Scene.js'));
const preloadScene = () => import('./three/Scene.js');
import { useIsMobile } from './hooks/useIsMobile.js';
import { Logo, Sky } from './ui/common/Sky.js';
import { IncomingTradeModal } from './ui/trade/IncomingTradeModal.js';
import { AuctionModal } from './ui/bank/AuctionModal.js';
import { GoBanner } from './ui/game/GoBanner.js';
import { EventBanner } from './ui/game/EventBanner.js';
import { GoBuildModal } from './ui/game/GoBuildModal.js';
import { RotateOverlay } from './ui/common/RotateOverlay.js';
import { ConnectionBanner, ReplacedOverlay } from './ui/session/SessionOverlays.js';
import { LeaderboardPage } from './ui/session/Leaderboard.js';

export function App() {
  const roomState = useGameStore((s) => s.roomState);
  const [isReconnecting, setIsReconnecting] = useState(() => loadSession() !== null);
  const isMobile = useIsMobile();
  // A finished game stays on screen (board + results) until players leave.
  const inGame = roomState?.status === 'playing' || roomState?.status === 'finished';
  const replaced = useGameStore((s) => s.replaced);
  const reconnectRef = useRef<() => void>(() => undefined);
  const rootClass = `app-root ${isMobile ? 'layout-mobile' : 'layout-desktop'} ${inGame ? 'screen-game' : 'screen-menu'}`;

  useEffect(() => {
    initSocketListeners();

    let cancelled = false;

    const tryReconnect = (force?: unknown) => {
      const session = loadSession();
      // A tab whose seat moved elsewhere only takes it back on "Play here".
      if (useGameStore.getState().replaced && force !== true) return;
      if (!session) {
        if (!cancelled) setIsReconnecting(false);
        return;
      }
      // Every (re)connection re-registers the seat: after a network drop or
      // a server restart the server no longer knows this socket.
      if (!cancelled && !useGameStore.getState().roomState) setIsReconnecting(true);
      socket.emit(
        'room:reconnect',
        { roomId: session.roomId, playerId: session.playerId, token: session.token, name: session.name },
        (res) => {
          if (cancelled) return;
          if (res.ok) {
            useGameStore.getState().setReplaced(false);
            saveSession({ ...session, token: res.token ?? session.token });
          } else {
            // Room closed, seat forfeited, or the token no longer matches.
            clearSession();
            useGameStore.getState().resetAll();
            if (res.error && res.error !== 'Room not found') useGameStore.getState().addToast(res.error, 'warning');
          }
          setIsReconnecting(false);
        }
      );
    };
    reconnectRef.current = () => tryReconnect(true);

    // Rejoin as soon as the connection (and identity) is ready.
    // Browser was closed mid-game: reopening the site goes straight back to
    // the match (lobbies stay on the home screen's Resume card).
    let autoTried = false;
    const autoResume = () => {
      if (autoTried || loadSession() || useGameStore.getState().roomState) return;
      autoTried = true;
      const recent = loadRecentSessions();
      if (!recent.length) return;
      socket.emit(
        'session:list',
        { sessions: recent.map(({ roomId, playerId, token }) => ({ roomId, playerId, token })) },
        (games) => {
          const game = games.find((g) => g.status === 'playing');
          if (!game || cancelled) return;
          const saved = recent.find((r) => r.roomId === game.roomId && r.playerId === game.playerId);
          const token = game.token ?? saved?.token;
          if (!token) return;
          const session = { roomId: game.roomId, playerId: game.playerId, token, name: game.myName };
          adoptSession(session);
          useGameStore.getState().setMyPlayerId(game.playerId);
          setIsReconnecting(true);
          tryReconnect();
        }
      );
    };

    const onConnect = () => {
      tryReconnect();
      autoResume();
    };
    if (socket.connected) onConnect();
    socket.on('connect', onConnect);

    return () => {
      cancelled = true;
      socket.off('connect', onConnect);
    };
  }, []);

  // In a room: fetch the 3D chunk in the background while players get ready.
  useEffect(() => {
    if (roomState) preloadScene();
  }, [roomState]);

  // Keep the saved seat's display name current.
  useEffect(() => {
    if (!roomState) return;
    const session = loadSession();
    const mySeat = roomState.seats.find((s) => s.playerId === useGameStore.getState().myPlayerId);
    if (session && mySeat && session.roomId === roomState.roomId && session.name !== mySeat.displayName) {
      saveSession({ ...session, name: mySeat.displayName });
    }
    setIsReconnecting(false);
  }, [roomState]);

  if (isReconnecting && !roomState) {
    return (
      <div className={rootClass}>
        <div className="menu-screen">
          <Sky />
          <div className="splash">
            <Logo />
            <div className="splash-card paper">
              <div className="spinner" />
              <p>Rejoining your game…</p>
            </div>
          </div>
        </div>
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className={rootClass}>
      {/* 3D Monopoly Canvas (rendered when in playing/finished state) */}
      {inGame && (
        <Suspense fallback={<div className="scene-loading"><div className="spinner" /><p>Setting up the board…</p></div>}>
          <MonopolyScene />
        </Suspense>
      )}

      {/* Screen 1: Home / Room Creation & Joining */}
      {!roomState && <HomeScreen />}

      {/* Screen 2: Waiting Lobby */}
      {roomState && roomState.status === 'waiting' && <LobbyScreen />}

      {/* Screen 3: Game HUD Overlays (when playing) */}
      {inGame && (
        <>
          <GameHUD />
          <ConnectionBanner />
          <GoBanner />
          <EventBanner />
          <BuyPropertyModal />
          <ForceBuyModal />
          <CardModal />
          <PropertySheet />
          <DebtPlanner />
          <IncomingTradeModal />
          <AuctionModal />
          <GoBuildModal />
        </>
      )}

      {!inGame && <LeaderboardPage />}
      {replaced && <ReplacedOverlay onUseHere={() => reconnectRef.current()} />}

      {/* Victory / Game Over Screen */}
      <VictoryOverlay />

      {/* Global Notifications */}
      <ToastContainer />
      <RotateOverlay />
    </div>
  );
}

export default App;
