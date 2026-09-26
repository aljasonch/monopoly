import React, { useRef, useState } from 'react';
import { ResumableGame } from '@monopoly/shared';
import {
  BookOpen,
  ChevronRight,
  ClipboardPaste,
  Crown,
  Download,
  Globe2,
  KeyRound,
  LogIn,
  PenLine,
  Play,
  Plus,
  Share,
  Trophy,
  Users,
  X,
  Zap
} from 'lucide-react';
import { Logo, Sky } from '../common/Sky.js';
import { Modal } from '../common/Modal.js';
import { MuteButton } from '../game/TurnHeader.js';
import { AccountChip } from '../session/AccountChip.js';
import { resumeGame, useResumable } from '../session/Resume.js';
import { firebaseEnabled, useAccount } from '../../net/account.js';
import { forgetRecent } from '../../net/socket.js';
import { useGameStore } from '../../store/gameStore.js';
import { audioManager } from '../../sound/audioManager.js';
import { useInstall } from '../../hooks/useInstall.js';
import { Die3D, RULE_CARDS } from './homeParts.js';
import { useRoomEntry } from './useRoomEntry.js';

type Sheet = 'join' | 'rules' | 'account' | 'install' | null;

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/**
 * Phone main menu, laid out like a mobile game: profile HUD on top, the
 * title "stage" in the middle and every action in the thumb zone below.
 */
export const MobileHome: React.FC = () => {
  const entry = useRoomEntry();
  const [sheet, setSheet] = useState<Sheet>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const install = useInstall();
  const acct = useAccount();
  const [games, dismiss] = useResumable();
  const game = games[0];

  const open = (s: Sheet) => {
    audioManager.playClick();
    setSheet(s);
  };

  // Every action needs a name: nudge the player to the nameplate first.
  const needName = () => {
    if (entry.name.trim()) return false;
    nameRef.current?.focus();
    useGameStore.getState().addToast('Pick a player name first', 'warning');
    return true;
  };

  const showAccount = firebaseEnabled && acct.status !== 'off';
  const signedIn = showAccount && !acct.anonymous && acct.status === 'ready';

  return (
    <div className="menu-screen mhome">
      <Sky />
      <div className="mhome-rays" aria-hidden="true" />

      <header className="mhome-hud">
        <button
          type="button"
          className="mhome-profile"
          onClick={() => (showAccount ? open('account') : nameRef.current?.focus())}
          aria-label="Your profile"
        >
          <span className="mhome-avatar">
            {signedIn && acct.photo ? (
              <img src={acct.photo} alt="" referrerPolicy="no-referrer" />
            ) : (
              initials(entry.name) || <Users size={18} strokeWidth={2.6} />
            )}
          </span>
          <span className="mhome-profile-text">
            <b className="truncate">{entry.name.trim() || 'New player'}</b>
            <small>{signedIn ? 'Account' : showAccount ? 'Guest · tap to sign in' : 'Guest'}</small>
          </span>
        </button>
        <div className="mhome-hud-btns">
          <button
            type="button"
            className="icon-btn mhome-hud-btn gold"
            aria-label="Leaderboard"
            onClick={() => {
              audioManager.playClick();
              useGameStore.getState().setLeaderboardOpen(true);
            }}
          >
            <Trophy size={19} strokeWidth={2.6} />
          </button>
          <MuteButton />
        </div>
      </header>

      <main className="mhome-stage">
        <div className="mhome-title">
          <Logo />
          <span className="mhome-ribbon">
            <Crown size={13} strokeWidth={2.8} /> World Cities Edition
          </span>
        </div>

        <div className="mhome-toys" aria-hidden="true">
          <span className="mhome-glow" />
          <Die3D className="d1" />
          <Die3D className="d2" />
          <span className="mhome-coin c1">$</span>
          <span className="mhome-coin c2">$</span>
          <span className="mhome-bill">$500</span>
        </div>

        <ul className="mhome-facts">
          <li>
            <Globe2 size={14} strokeWidth={2.8} /> 8 countries
          </li>
          <li>
            <Users size={14} strokeWidth={2.8} /> 2–6 players
          </li>
          <li>
            <Zap size={14} strokeWidth={2.8} /> Live
          </li>
        </ul>
      </main>

      <section className="mhome-dock">
        {game && (
          <ResumeBanner
            game={game}
            onForget={() => {
              forgetRecent(game.roomId, game.playerId);
              dismiss(game.roomId);
            }}
            onFail={() => dismiss(game.roomId)}
          />
        )}

        <label className="mhome-name">
          <span className="mhome-name-tag">Player</span>
          <input
            ref={nameRef}
            type="text"
            name="player-name"
            placeholder="Your name"
            autoComplete="nickname"
            enterKeyHint="done"
            maxLength={15}
            value={entry.name}
            onChange={(e) => entry.setName(e.target.value)}
          />
          <PenLine size={17} strokeWidth={2.6} className="mhome-name-pen" />
        </label>

        <button
          type="button"
          className="mhome-cta red btn-create"
          disabled={entry.busy}
          onClick={() => {
            if (needName()) return;
            audioManager.playClick();
            entry.create();
          }}
        >
          <span className="mhome-cta-icon">
            <Plus size={26} strokeWidth={3.4} />
          </span>
          <span className="mhome-cta-copy">
            <b>{entry.busy ? 'Setting the table…' : 'Create table'}</b>
            <small>Host a game and share the code</small>
          </span>
          <ChevronRight size={24} strokeWidth={3.2} className="mhome-cta-trail" />
        </button>

        <button
          type="button"
          className="mhome-cta blue btn-open-join"
          onClick={() => {
            if (needName()) return;
            open('join');
          }}
        >
          <span className="mhome-cta-icon">
            <KeyRound size={22} strokeWidth={3} />
          </span>
          <span className="mhome-cta-copy">
            <b>Join with code</b>
            <small>Got a code from a friend?</small>
          </span>
          <ChevronRight size={24} strokeWidth={3.2} className="mhome-cta-trail" />
        </button>

        <nav className="mhome-tabs">
          <button type="button" onClick={() => open('rules')}>
            <BookOpen size={18} strokeWidth={2.6} /> How to play
          </button>
          {install.canPrompt ? (
            <button type="button" onClick={() => install.install()}>
              <Download size={18} strokeWidth={2.6} /> Install
            </button>
          ) : install.showIosHelp ? (
            <button type="button" onClick={() => open('install')}>
              <Share size={18} strokeWidth={2.6} /> Install
            </button>
          ) : showAccount && !signedIn ? (
            <button type="button" onClick={() => open('account')}>
              <LogIn size={18} strokeWidth={2.6} /> Sign in
            </button>
          ) : null}
        </nav>
      </section>

      {sheet === 'join' && <JoinSheet entry={entry} onClose={() => setSheet(null)} />}
      {sheet === 'rules' && <RulesSheet onClose={() => setSheet(null)} />}
      {sheet === 'account' && (
        <Modal onClose={() => setSheet(null)} label="Account" className="msheet">
          <SheetHead title="Your profile" onClose={() => setSheet(null)} />
          <div className="msheet-body">
            <AccountChip />
            <p className="msheet-note">
              Guests play right away. Sign in with Google to keep your wins and best score on the leaderboard across
              devices.
            </p>
          </div>
        </Modal>
      )}
      {sheet === 'install' && (
        <Modal onClose={() => setSheet(null)} label="Install" className="msheet">
          <SheetHead title="Install TMpoly" onClose={() => setSheet(null)} />
          <div className="msheet-body">
            <p className="msheet-note">
              Tap <Share size={14} /> <strong>Share</strong> in Safari, then <strong>Add to Home Screen</strong>. It
              opens full screen, like a real app.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
};

const SheetHead: React.FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <div className="msheet-head">
    <h2>{title}</h2>
    <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
      <X size={18} />
    </button>
  </div>
);

const ResumeBanner: React.FC<{ game: ResumableGame; onForget: () => void; onFail: () => void }> = ({
  game,
  onForget,
  onFail
}) => {
  const [busy, setBusy] = useState(false);
  const others = game.players.filter((p) => p !== game.myName);
  return (
    <div className="mhome-resume" role="region" aria-label="Game in progress">
      <span className="mhome-resume-pulse" aria-hidden="true" />
      <span className="mhome-resume-info">
        <b>{game.status === 'waiting' ? 'In the lobby' : `Turn ${game.turnNumber ?? 1}`}</b>
        <small className="truncate">
          <em className="tnum">{game.roomId}</em>
          with {others.join(', ') || 'nobody yet'}
        </small>
      </span>
      <button
        type="button"
        className="mhome-resume-go"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          resumeGame(game, (error) => {
            setBusy(false);
            if (error) {
              useGameStore.getState().addToast(error, 'warning');
              onFail();
            }
          });
        }}
      >
        <Play size={14} fill="currentColor" /> {busy ? '…' : 'Resume'}
      </button>
      <button type="button" className="mhome-resume-x" aria-label="Forget this game" onClick={onForget}>
        <X size={14} strokeWidth={3} />
      </button>
    </div>
  );
};

const JoinSheet: React.FC<{ entry: ReturnType<typeof useRoomEntry>; onClose: () => void }> = ({ entry, onClose }) => {
  const [code, setCode] = useState('');
  const [focus, setFocus] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const clean = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!entry.busy) entry.join(code);
  };

  return (
    <Modal onClose={onClose} label="Join a table" className="msheet">
      <SheetHead title="Join a table" onClose={onClose} />
      <form className="msheet-body" onSubmit={submit}>
        <p className="msheet-note">Enter the 6-character code your host shared.</p>
        <span className="code-boxes" onClick={() => ref.current?.focus()}>
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={`code-box ${code[i] ? 'filled' : ''} ${focus && i === Math.min(code.length, 5) ? 'caret' : ''}`}
            >
              {code[i] ?? ''}
            </span>
          ))}
          <input
            ref={ref}
            autoFocus
            className="code-input"
            type="text"
            name="room-code"
            aria-label="Room code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={6}
            value={code}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onChange={(e) => setCode(clean(e.target.value))}
          />
        </span>
        {canPaste && (
          <button
            type="button"
            className="msheet-paste"
            onClick={() =>
              navigator.clipboard
                .readText()
                .then((t) => setCode(clean(t)))
                .catch(() => ref.current?.focus())
            }
          >
            <ClipboardPaste size={16} strokeWidth={2.6} /> Paste code
          </button>
        )}
        <button type="submit" className="mhome-cta blue btn-join slim" disabled={entry.busy || code.length < 6}>
          <span className="mhome-cta-copy">
            <b>{entry.busy ? 'Joining…' : 'Join table'}</b>
          </span>
          <ChevronRight size={24} strokeWidth={3.2} className="mhome-cta-trail" />
        </button>
      </form>
    </Modal>
  );
};

const RulesSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <Modal onClose={onClose} label="How to play" className="msheet">
    <SheetHead title="How to play" onClose={onClose} />
    <div className="msheet-body">
      <ol className="msheet-steps">
        <li>
          <b>Roll</b> and move around the world.
        </li>
        <li>
          <b>Buy</b> cities, then build up to a landmark.
        </li>
        <li>
          <b>Collect rent</b> and bankrupt your rivals.
        </li>
      </ol>
      <ul className="msheet-rules">
        {RULE_CARDS.map((c) => (
          <li key={c.title} className={`tone-${c.tone}`}>
            <span className="msheet-rule-icon">
              <c.icon size={20} strokeWidth={2.4} />
            </span>
            <span>
              <b>{c.title}</b>
              <small>{c.text}</small>
            </span>
          </li>
        ))}
      </ul>
    </div>
  </Modal>
);
