import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useGameStore } from '../../store/gameStore.js';

// A random board event is a big deal, not a quiet corner toast: shown
// centered and held on screen long enough to actually read.
const HOLD_MS = 5200;

export const EventBanner: React.FC = () => {
  const event = useGameStore((s) => s.eventBanner);
  const [shownId, setShownId] = useState<number | null>(null);
  const seenAtMount = useRef(event?.id);

  useEffect(() => {
    if (!event || event.id === seenAtMount.current) return;
    setShownId(event.id);
    const t = setTimeout(() => setShownId((v) => (v === event.id ? null : v)), HOLD_MS);
    return () => clearTimeout(t);
  }, [event]);

  if (!event || shownId !== event.id) return null;
  const text = event.text.replace(/^Random event!\s*/i, '');

  return (
    <div className={`event-banner ${event.type}`} key={event.id} role="alert" aria-live="assertive">
      <div className="event-banner-card">
        <span className="event-banner-icon">
          <Sparkles size={26} />
        </span>
        <div className="event-banner-copy">
          <span className="event-banner-title">Random Event!</span>
          <span className="event-banner-text">{text}</span>
        </div>
      </div>
    </div>
  );
};
