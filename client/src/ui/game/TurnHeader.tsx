import React, { useEffect, useRef, useState } from 'react';
import { Gauge, Maximize2, Minimize2, Music, Sparkles, Volume1, Volume2, VolumeX } from 'lucide-react';
import { GraphicsPref, usePerfStore, useTier } from '../../store/perfStore.js';
import { audioManager } from '../../sound/audioManager.js';
import { PipDie } from '../PipDie.js';
import { PlayerAvatar } from '../common/PlayerAvatar.js';
import { PHASE_LABEL, playerHex } from '../theme.js';
import { TurnInfo } from './useTurn.js';
import { useGameStore } from '../../store/gameStore.js';

export const TurnIdentity: React.FC<{ turn: TurnInfo; size?: number }> = ({ turn, size = 34 }) => {
  const { current, isMyTurn, game } = turn;
  return (
    <div className={`turn-identity ${isMyTurn ? 'mine' : ''}`} style={{ '--c': playerHex(current.color) } as React.CSSProperties}>
      <PlayerAvatar token={current.tokenType} color={current.color} size={size} ring />
      <div className="turn-copy">
        <span className="turn-title">{isMyTurn ? 'Your turn!' : `${current.name}'s turn`}</span>
        <span className="turn-sub">
          Turn {game.turnNumber} · {PHASE_LABEL[game.phase]}
        </span>
        {game.activeEvent && (
          <span className="badge gold event-badge" title={`Active until turn ${game.activeEvent.expiresAtTurn}`}>
            {game.activeEvent.label}
          </span>
        )}
      </div>
    </div>
  );
};

// Matches the 3D dice: tumble (0.75 s) + settle (0.25 s).
export const DICE_ANIM_MS = 1000;

// The HUD readout shuffles while the 3D dice tumble and only shows the result
// once they have landed, so both always show the same faces.
export const DiceReadout: React.FC<{ d1: number; d2: number; size?: number }> = ({ d1, d2, size = 22 }) => {
  const diceRoll = useGameStore((s) => s.diceRoll);
  const hasRolled = useGameStore((s) => s.diceRoll !== null || s.gameState?.lastMove != null);
  const [shuffle, setShuffle] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (!diceRoll) return;
    const face = () => 1 + Math.floor(Math.random() * 6);
    setShuffle([face(), face()]);
    const spin = setInterval(() => setShuffle([face(), face()]), 110);
    const done = setTimeout(() => {
      clearInterval(spin);
      setShuffle(null);
    }, DICE_ANIM_MS);
    return () => {
      clearInterval(spin);
      clearTimeout(done);
    };
  }, [diceRoll]);

  const [a, b] = shuffle ?? [d1, d2];
  return (
    <div className={`dice-readout ${shuffle ? 'rolling' : ''} ${hasRolled ? '' : 'idle'}`} aria-label={shuffle ? 'Rolling dice' : `Dice ${d1} and ${d2}`}>
      <PipDie value={a} size={size} />
      <PipDie value={b} size={size} />
      {hasRolled && !shuffle && <span className="dice-sum tnum">{d1 + d2}</span>}
      {hasRolled && !shuffle && d1 === d2 && <span className="badge gold dbl">Doubles</span>}
    </div>
  );
};

// Speaker button: opens a small panel with Music / Effects volume sliders
// and a mute switch (settings are saved on this device).
export const MuteButton: React.FC = () => {
  const [muted, setMuted] = useState(audioManager.isMuted());
  const [vol, setVol] = useState(audioManager.getVolumes());
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => audioManager.subscribe(setMuted), []);
  useEffect(() => audioManager.subscribeVolume(() => setVol(audioManager.getVolumes())), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const quiet = muted || (vol.music === 0 && vol.sfx === 0);
  return (
    <div className="sound-wrap" ref={wrap}>
      <button
        className={`icon-btn btn-audio-toggle ${quiet ? 'muted' : ''} ${open ? 'active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Sound settings"
        aria-expanded={open}
        title="Sound"
      >
        {quiet ? <VolumeX size={19} /> : vol.music + vol.sfx < 0.8 ? <Volume1 size={19} /> : <Volume2 size={19} />}
      </button>
      {open && (
        <div className="sound-pop" role="dialog" aria-label="Sound settings">
          <VolumeRow
            icon={<Music size={16} />}
            label="Music"
            value={vol.music}
            disabled={muted}
            onChange={(v) => audioManager.setMusicVolume(v)}
          />
          <VolumeRow
            icon={<Sparkles size={16} />}
            label="Effects"
            value={vol.sfx}
            disabled={muted}
            onChange={(v) => audioManager.setSfxVolume(v)}
            onCommit={() => audioManager.playCoin()}
          />
          <button className={`sound-mute ${muted ? 'on' : ''}`} onClick={() => audioManager.toggleMute()}>
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            {muted ? 'Sound is off, tap to turn on' : 'Mute all sound'}
          </button>
        </div>
      )}
    </div>
  );
};

const VolumeRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  onCommit?: () => void;
}> = ({ icon, label, value, disabled, onChange, onCommit }) => (
  <label className={`vol-row ${disabled ? 'disabled' : ''}`}>
    <span className="vol-label">
      {icon} {label}
    </span>
    <input
      type="range"
      min={0}
      max={100}
      step={5}
      value={Math.round(value * 100)}
      disabled={disabled}
      style={{ '--p': `${Math.round(value * 100)}%` } as React.CSSProperties}
      onChange={(e) => onChange(Number(e.target.value) / 100)}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
      aria-label={`${label} volume`}
    />
    <span className="vol-val tnum">{Math.round(value * 100)}</span>
  </label>
);

export const FullscreenButton: React.FC = () => {
  const [full, setFull] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  if (!document.documentElement.requestFullscreen) return null;
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  return (
    <button className="icon-btn" onClick={toggle} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'}>
      {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
    </button>
  );
};

const NEXT: Record<GraphicsPref, GraphicsPref> = { auto: 'low', low: 'high', high: 'auto' };
const PREF_LABEL: Record<GraphicsPref, string> = { auto: 'Auto', low: 'Smooth', high: 'Pretty' };

// Graphics quality: Auto (adapts to the device), Smooth (fastest), Pretty.
export const GraphicsButton: React.FC = () => {
  const pref = usePerfStore((s) => s.pref);
  const setPref = usePerfStore((s) => s.setPref);
  const tier = useTier();
  const title = `Graphics: ${PREF_LABEL[pref]}${pref === 'auto' ? ` (${tier})` : ''}. Click to change.`;
  return (
    <button className={`icon-btn gfx-btn gfx-${pref}`} onClick={() => setPref(NEXT[pref])} aria-label={title} title={title}>
      <Gauge size={18} />
      <span className="gfx-tag">{PREF_LABEL[pref]}</span>
    </button>
  );
};
