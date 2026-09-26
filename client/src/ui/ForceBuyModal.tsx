import React from 'react';
import { socket } from '../net/socket.js';
import { useGameStore } from '../store/gameStore.js';
import { BOARD_TILES, FORCE_BUY_TIMER_MS } from '@monopoly/shared';
import { ArrowRight, Lock, Zap } from 'lucide-react';
import { audioManager } from '../sound/audioManager.js';
import { Modal } from './common/Modal.js';
import { PlayerAvatar } from './common/PlayerAvatar.js';
import { useCountdown } from './game/useCountdown.js';
import { GROUP_HEX, LEVEL_NAMES, money, rentLabel } from './theme.js';

const RING = 2 * Math.PI * 20;

// Only the landing player decides; the owner is warned in the action panel.
export const ForceBuyModal: React.FC = () => {
  const offer = useGameStore((s) => s.forceBuyOffer);
  const gameState = useGameStore((s) => s.gameState);
  const myPlayerId = useGameStore((s) => s.myPlayerId);
  const isWalking = useGameStore((s) => s.isWalking);
  // One thing at a time: a Chance/Chest card is read first.
  const cardOpen = useGameStore((s) => s.cardDraw !== null);
  const left = useCountdown(offer?.expiresAt);

  if (!offer || !gameState || isWalking || cardOpen || offer.buyerPlayerId !== myPlayerId) return null;

  const tile = BOARD_TILES[offer.tileIndex];
  const prop = gameState.properties[offer.tileIndex];
  const buyer = gameState.players.find((p) => p.playerId === offer.buyerPlayerId);
  const owner = gameState.players.find((p) => p.playerId === offer.targetPlayerId);
  if (!tile || !buyer || !owner) return null;
  const canAfford = buyer.money >= offer.price;
  const progress = Math.min(1, (left * 1000) / FORCE_BUY_TIMER_MS);

  const respond = (accept: boolean) => {
    if (accept) audioManager.playBuy();
    else audioManager.playClick();
    socket.emit('game:forceBuyResponse', { accept });
  };

  return (
    <Modal width={420} label="Force buy offer">
      <div className="modal-pad force-buy">
        <div className="fb-head">
          <span className="fb-icon">
            <Zap size={22} fill="currentColor" />
          </span>
          <div>
            <h2>Force buy?</h2>
            <p>Rent's already paid. Take the property too, at double its value on top -- the owner can’t refuse.</p>
          </div>
          <svg className={`fb-timer ${left <= 5 ? 'urgent' : ''}`} viewBox="0 0 48 48" aria-label={`${left} seconds left`}>
            <circle cx="24" cy="24" r="20" className="track" />
            <circle cx="24" cy="24" r="20" className="bar" strokeDasharray={RING} strokeDashoffset={RING * (1 - progress)} />
            <text x="24" y="29" textAnchor="middle">
              {left}
            </text>
          </svg>
        </div>

        <div className="fb-property" style={{ '--g': GROUP_HEX[tile.group] } as React.CSSProperties}>
          <span className="fb-band" />
          <div>
            <strong>{tile.name}</strong>
            <span>
              {LEVEL_NAMES[offer.currentBuildLevel]} · Rent {prop ? rentLabel(gameState, prop) : ''}
            </span>
          </div>
        </div>

        <div className="fb-transfer">
          <div className="fb-party">
            <PlayerAvatar token={owner.tokenType} color={owner.color} size={40} />
            <span>{owner.name}</span>
            <small>Owner</small>
          </div>
          <div className="fb-arrow">
            <span className="tnum">{money(offer.price)}</span>
            <ArrowRight size={20} />
          </div>
          <div className="fb-party">
            <PlayerAvatar token={buyer.tokenType} color={buyer.color} size={40} />
            <span>You</span>
            <small className="tnum">{money(buyer.money)} cash</small>
          </div>
        </div>

        <div className="callout">
          <Lock size={15} />
          <span>Keeps its {LEVEL_NAMES[offer.currentBuildLevel].toLowerCase()} level but can never become a Landmark.</span>
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary btn-lg btn-decline" onClick={() => respond(false)}>
            No thanks
          </button>
          <button className="btn btn-gold btn-lg btn-force-buy" onClick={() => respond(true)} disabled={!canAfford}>
            <Zap size={17} fill="currentColor" /> Buy for <span className="tnum">{money(offer.price)}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
};
