import React, { useEffect, useState } from 'react';
import { ArrowUpCircle, Castle, Hammer } from 'lucide-react';
import { socket } from '../../net/socket.js';
import { audioManager } from '../../sound/audioManager.js';
import { Modal } from '../common/Modal.js';
import { LEVEL_NAMES, money } from '../theme.js';
import { useTurn } from './useTurn.js';

// Landing exactly on GO is a building spree: every property you own, not
// just the one you're standing on, can be upgraded from one modal.
export const GoBuildModal: React.FC = () => {
  const turn = useTurn();
  const [dismissedTurn, setDismissedTurn] = useState<number | null>(null);

  const game = turn?.game;
  const options = turn?.goBuildOptions ?? [];
  const show = !!turn?.isMyTurn && game?.phase === 'TURN_ENDED' && options.length > 0;

  useEffect(() => {
    if (!show) setDismissedTurn(null);
  }, [show]);

  if (!turn || !game || !show || dismissedTurn === game.turnNumber) return null;

  const build = (tileIndex: number) => {
    audioManager.playClick();
    socket.emit('game:build', { tileIndex });
  };

  return (
    <Modal width={440} label="Build anywhere" onClose={() => setDismissedTurn(game.turnNumber)}>
      <div className="modal-pad">
        <div className="fb-head">
          <span className="fb-icon">
            <Hammer size={22} />
          </span>
          <div>
            <h2>Landed on GO!</h2>
            <p>Building spree: upgrade any property you own.</p>
          </div>
        </div>

        <div className="go-build-list">
          {options.map((opt) => (
            <button
              key={opt.prop.tileIndex}
              className={`btn btn-lg btn-block go-build-row ${opt.nextLevel === 4 ? 'btn-purple landmark' : 'btn-blue'}`}
              onClick={() => build(opt.prop.tileIndex)}
              disabled={!opt.affordable || !!opt.blocked}
              title={opt.blocked ?? undefined}
            >
              {opt.nextLevel === 4 ? <Castle size={20} /> : <ArrowUpCircle size={20} />}
              <span className="btn-stack">
                <span>
                  {opt.tile.name} &rarr; {LEVEL_NAMES[opt.nextLevel]}
                </span>
                <small className="tnum">{opt.blocked || money(opt.cost)}</small>
              </span>
            </button>
          ))}
        </div>

        <button className="btn btn-secondary btn-block" onClick={() => setDismissedTurn(game.turnNumber)}>
          Done building
        </button>
      </div>
    </Modal>
  );
};
