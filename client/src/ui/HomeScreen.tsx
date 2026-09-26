import React, { useRef, useState } from 'react';
import { useRoomEntry } from './home/useRoomEntry.js';
import { ResumeCard } from './session/Resume.js';
import { AccountChip } from './session/AccountChip.js';
import { LeaderboardButton } from './session/Leaderboard.js';
import {
  ArrowRight,
  Car,
  Crown,
  History,
  KeyRound,
  LogIn,
  Plus,
  User
} from 'lucide-react';
import { Logo, Sky } from './common/Sky.js';
import { useInstall } from '../hooks/useInstall.js';
import { Download, Share } from 'lucide-react';

import { Die3D, RULE_CARDS } from './home/homeParts.js';
import { MobileHome } from './home/MobileHome.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

type Mode = 'create' | 'join';

// Phones get the game-style main menu; larger screens the full page.
export const HomeScreen: React.FC = () => (useIsMobile() ? <MobileHome /> : <DesktopHome />);

const DesktopHome: React.FC = () => {
  const { name, setName, busy, create: handleCreate, join } = useRoomEntry();
  const [joinCode, setJoinCode] = useState('');
  const [mode, setMode] = useState<Mode>('create');
  const [codeFocus, setCodeFocus] = useState(false);
  const [openCard, setOpenCard] = useState<number | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const install = useInstall();
  const [iosHelp, setIosHelp] = useState(false);

  const handleJoin = () => join(joinCode);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'create') handleCreate();
    else handleJoin();
  };

  const greeting = name.trim() ? `Hi ${name.trim()}! Ready to get rich?` : 'Hey there! What should we call you?';

  return (
    <div className="menu-screen home-screen">
      <Sky town />

      <div className="home-layout">
        <section className="home-hero">
          <div className="hero-title">
            <Logo />
            <span className="hero-tag">
              <Crown size={15} /> World cities edition
            </span>
          </div>
          <p className="hero-sub">
            Roll, buy and build your way across <b>8 countries</b> with up to <b>6 friends</b>. Real time, right in your
            browser.
          </p>

          <div className="hero-toys">
            <Die3D className="d1" />
            <Die3D className="d2" />
            <span className="toy-bill b1">$500</span>
            <span className="toy-bill b2">$100</span>
            <span className="toy-coin">$</span>
          </div>

          <div className={`rule-fan ${openCard !== null ? 'has-open' : ''}`} role="list" aria-label="House rules">
            {RULE_CARDS.map((c, i) => (
              <button
                type="button"
                role="listitem"
                key={c.title}
                className={`rule-card tone-${c.tone} ${openCard === i ? 'open' : ''}`}
                style={{ '--i': i - (RULE_CARDS.length - 1) / 2 } as React.CSSProperties}
                onClick={() => setOpenCard((o) => (o === i ? null : i))}
              >
                <span className="rule-card-top">
                  <c.icon size={22} strokeWidth={2.4} />
                </span>
                <strong>{c.title}</strong>
                <span className="rule-card-text">{c.text}</span>
                <span className="rule-card-foot">TMpoly</span>
              </button>
            ))}
          </div>
        </section>

        <section className="home-panel">
          <AccountChip />
          <form className="deed-form" onSubmit={submit}>
            <header className={`deed-head ${mode}`}>
              <small>Title deed</small>
              <h2>{mode === 'create' ? 'Host a table' : 'Join a table'}</h2>
            </header>

            <div className="deed-body">
              <ResumeCard />
              <div className="mascot-row" aria-live="polite">
                <span className="mascot">
                  <Car size={26} strokeWidth={2.4} />
                </span>
                <span className="mascot-bubble" key={greeting}>
                  {greeting}
                </span>
              </div>

              <label className="field">
                <span className="field-label">Your name</span>
                <span className="input-wrap">
                  <User size={19} />
                  <input
                    className="input"
                    type="text"
                    name="player-name"
                    placeholder="e.g. Alice"
                    autoComplete="nickname"
                    maxLength={15}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </span>
              </label>

              <div className="mode-tickets" role="tablist" aria-label="Host or join">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'create'}
                  className={`ticket create ${mode === 'create' ? 'active' : ''}`}
                  onClick={() => setMode('create')}
                >
                  <span className="ticket-icon">
                    <Plus size={20} strokeWidth={3} />
                  </span>
                  <span className="ticket-copy">
                    <b>New table</b>
                    <small>Get a code to share</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'join'}
                  className={`ticket join ${mode === 'join' ? 'active' : ''}`}
                  onClick={() => {
                    setMode('join');
                    setTimeout(() => codeRef.current?.focus(), 50);
                  }}
                >
                  <span className="ticket-icon">
                    <KeyRound size={19} strokeWidth={2.6} />
                  </span>
                  <span className="ticket-copy">
                    <b>Have a code</b>
                    <small>Join your friends</small>
                  </span>
                </button>
              </div>

              {mode === 'join' && (
                <label className="field code-field">
                  <span className="field-label">Room code</span>
                  <span className="code-boxes" onClick={() => codeRef.current?.focus()}>
                    {Array.from({ length: 6 }, (_, i) => (
                      <span
                        key={i}
                        className={`code-box ${joinCode[i] ? 'filled' : ''} ${
                          codeFocus && i === Math.min(joinCode.length, 5) ? 'caret' : ''
                        }`}
                      >
                        {joinCode[i] ?? ''}
                      </span>
                    ))}
                    <input
                      ref={codeRef}
                      className="code-input"
                      type="text"
                      name="room-code"
                      aria-label="Room code"
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={6}
                      value={joinCode}
                      onFocus={() => setCodeFocus(true)}
                      onBlur={() => setCodeFocus(false)}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                    />
                  </span>
                </label>
              )}

              <button
                type="submit"
                className={`btn btn-primary btn-xl btn-block btn-go ${mode === 'create' ? 'btn-create' : 'btn-join'}`}
                disabled={busy}
              >
                {mode === 'create' ? <Plus size={22} strokeWidth={3} /> : <LogIn size={22} strokeWidth={3} />}
                <span>{busy ? (mode === 'create' ? 'Setting the table…' : 'Joining…') : mode === 'create' ? 'Create room' : 'Join room'}</span>
                {!busy && <ArrowRight size={20} strokeWidth={3} className="btn-trail" />}
              </button>

              {install.canPrompt && (
                <button type="button" className="btn btn-gold btn-block btn-install" onClick={() => install.install()}>
                  <Download size={18} strokeWidth={2.6} /> Install app
                </button>
              )}
              {install.showIosHelp && (
                <button type="button" className="btn btn-secondary btn-block btn-install" onClick={() => setIosHelp((v) => !v)}>
                  <Share size={17} strokeWidth={2.6} /> Install on iPhone
                </button>
              )}
              {iosHelp && (
                <p className="ios-help">
                  Tap <Share size={14} /> <strong>Share</strong> in Safari, then <strong>Add to Home Screen</strong>. It opens full screen like a real app.
                </p>
              )}

              <p className="panel-hint">
                <History size={14} />
                <span>Your seat is saved. Reload any time to rejoin.</span>
              </p>
            </div>
          </form>
          <LeaderboardButton className="home-lb-btn" />
        </section>
      </div>
    </div>
  );
};
