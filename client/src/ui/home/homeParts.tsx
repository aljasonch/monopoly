import React from 'react';
import { Banknote, Castle, Handshake, Swords, Trophy } from 'lucide-react';
import { PipDie } from '../PipDie.js';

// House rules, dealt like a hand of Chance cards.
export const RULE_CARDS = [
  { icon: Swords, title: 'Force buy', text: 'Snatch a rival’s built city for double its value.', tone: 'red' },
  { icon: Castle, title: 'Landmarks', text: 'Build house, building, hotel, then an untouchable landmark.', tone: 'orange' },
  { icon: Trophy, title: 'Instant wins', text: 'Own three full countries or a whole side of the board.', tone: 'gold' },
  { icon: Handshake, title: 'Wheel & deal', text: 'Trade cash and cities with anyone, any time.', tone: 'blue' },
  { icon: Banknote, title: 'Never broke', text: 'Sell, mortgage or trade your way out of debt.', tone: 'green' }
] as const;

// A CSS 3D die: faces 1..6, tumbles now and then (pure transforms).
export const Die3D: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`die3d ${className}`} aria-hidden="true">
    <div className="die3d-cube">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <span key={n} className={`die3d-face f${n}`}>
          <PipDie value={n} size={58} />
        </span>
      ))}
    </div>
  </div>
);

