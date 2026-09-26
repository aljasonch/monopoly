import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MonopolyGameEngine } from '../src/engine/game.js';
import { CardDraw, CHANCE_CARDS, CHEST_CARDS, Seat } from '@monopoly/shared';

describe('Monopoly Game Engine (LINE Get Rich rules)', () => {
  let seats: Seat[];

  beforeEach(() => {
    seats = [
      {
        seatIndex: 0,
        playerId: 'p1',
        displayName: 'Alice',
        color: 'red',
        tokenType: 'car',
        isReady: true,
        isConnected: true,
        isHost: true
      },
      {
        seatIndex: 1,
        playerId: 'p2',
        displayName: 'Bob',
        color: 'blue',
        tokenType: 'hat',
        isReady: true,
        isConnected: true,
        isHost: false
      }
    ];
  });

  it('initializes game state correctly', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    expect(engine.state.players.length).toBe(2);
    expect(engine.state.players[0].money).toBe(1500);
    expect(engine.state.phase).toBe('ROLLING');
    expect(engine.state.turnNumber).toBe(1);
    expect(Object.keys(engine.state.properties).length).toBe(40);
  });

  it('triggers buy offer when landing on unowned property (no auto-buy)', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.rollDice(1, 2);

    expect(engine.state.players[0].position).toBe(3);
    expect(engine.state.phase).toBe('BUY_OFFER');
    expect(engine.state.buyOffer).not.toBeNull();
    expect(engine.state.buyOffer?.tileIndex).toBe(3);
    expect(engine.state.buyOffer?.price).toBe(60);
    expect(engine.state.properties[3].ownerId).toBeNull();

    // Player accepts the offer:
    engine.respondToBuyOffer(true);
    expect(engine.state.properties[3].ownerId).toBe('p1');
    expect(engine.state.players[0].money).toBe(1500 - 60);
    expect(engine.state.properties[3].buildLevel).toBe(0);
    expect(engine.state.phase).toBe('TURN_ENDED');
  });

  it('declining a property sends it to a Bank auction; no bids keeps it with the Bank', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.rollDice(1, 2);

    expect(engine.state.phase).toBe('BUY_OFFER');
    engine.respondToBuyOffer(false);

    expect(engine.state.phase).toBe('AUCTION');
    expect(engine.state.auction?.tileIndex).toBe(3);
    engine.finishAuction();
    expect(engine.state.properties[3].ownerId).toBeNull();
    expect(engine.state.players[0].money).toBe(1500);
    expect(engine.state.phase).toBe('TURN_ENDED');
  });

  it('landing on a property you cannot afford leaves it unowned (no forced auction)', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.players[0].money = 10;
    engine.rollDice(1, 2);

    expect(engine.state.buyOffer).toBeNull();
    expect(engine.state.phase).toBe('TURN_ENDED');
    expect(engine.state.properties[3].ownerId).toBeNull();
    expect(engine.state.players[0].money).toBe(10);
  });

  it('triggers force-buy offer when landing on opponent developed property', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[3].ownerId = 'p2';
    engine.state.properties[3].buildLevel = 1;

    engine.rollDice(1, 2);

    expect(engine.state.phase).toBe('FORCE_BUY_OFFER');
    expect(engine.state.forceBuyOffer).not.toBeNull();
    expect(engine.state.forceBuyOffer?.tileIndex).toBe(3);
    expect(engine.state.forceBuyOffer?.targetPlayerId).toBe('p2');
    expect(engine.state.forceBuyOffer?.buyerPlayerId).toBe('p1');
    expect(engine.state.forceBuyOffer?.price).toBe(220); // (60 + 50)*2
  });

  it('charges rent immediately on landing, then the takeover price on top when force-buying', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[3].ownerId = 'p2';
    engine.state.properties[3].buildLevel = 1; // rent 20, takeover (60 + 50)*2 = 220

    engine.rollDice(1, 2); // lands on tile 3

    // Rent is already paid the moment the token lands, before any force-buy
    // decision is made.
    expect(engine.state.phase).toBe('FORCE_BUY_OFFER');
    expect(engine.state.players[0].money).toBe(1500 - 20);
    expect(engine.state.players[1].money).toBe(1500 + 20);

    engine.respondToForceBuy(true);

    // Accepting costs the takeover price on top of the rent already paid.
    expect(engine.state.players[0].money).toBe(1500 - 20 - 220);
    expect(engine.state.players[1].money).toBe(1500 + 20 + 220);
  });

  it('declining a force-buy offer costs nothing further -- rent was already paid', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[3].ownerId = 'p2';
    engine.state.properties[3].buildLevel = 1;

    engine.rollDice(1, 2);
    expect(engine.state.players[0].money).toBe(1500 - 20);

    engine.respondToForceBuy(false);

    expect(engine.state.properties[3].ownerId).toBe('p2');
    expect(engine.state.players[0].money).toBe(1500 - 20);
    expect(engine.state.players[1].money).toBe(1500 + 20);
    expect(engine.state.phase).toBe('TURN_ENDED');
  });

  it('force-buy mode "off" turns landing on a developed rival deed into plain rent', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true, forceBuyMode: 'off' });
    engine.state.properties[3].ownerId = 'p2';
    engine.state.properties[3].buildLevel = 1;

    engine.rollDice(1, 2);

    expect(engine.state.phase).toBe('TURN_ENDED');
    expect(engine.state.forceBuyOffer).toBeNull();
    expect(engine.state.players[1].money).toBeGreaterThan(1500); // p2 collected rent
  });

  it('force-buy mode "any" allows forcing raw, unbuilt land too', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true, forceBuyMode: 'any' });
    engine.state.properties[3].ownerId = 'p2'; // raw land, buildLevel 0

    engine.rollDice(1, 2);

    expect(engine.state.phase).toBe('FORCE_BUY_OFFER');
    expect(engine.state.forceBuyOffer?.price).toBe(120); // 60 * 2, no building cost
  });

  it('executes forced sale when buyer accepts: keeps build level, locks landmark', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[3].ownerId = 'p2';
    engine.state.properties[3].buildLevel = 2;

    engine.rollDice(1, 2);
    expect(engine.state.phase).toBe('FORCE_BUY_OFFER');

    const aliceMoney = engine.state.players[0].money;
    const bobMoney = engine.state.players[1].money;
    const price = engine.state.forceBuyOffer!.price;

    engine.respondToForceBuy(true);

    expect(engine.state.properties[3].ownerId).toBe('p1');
    expect(engine.state.properties[3].buildLevel).toBe(2);
    expect(engine.state.properties[3].forceBought).toBe(true);
    expect(engine.state.players[0].money).toBe(aliceMoney - price);
    expect(engine.state.players[1].money).toBe(bobMoney + price);
    expect(engine.state.phase).toBe('TURN_ENDED');
  });

  it('prevents upgrading to Landmark if property was force-bought', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[3].ownerId = 'p1';
    engine.state.properties[3].buildLevel = 2;
    engine.state.properties[3].forceBought = true;
    engine.state.players[0].position = 3;

    engine.build(3);
    expect(engine.state.properties[3].buildLevel).toBe(3);

    expect(() => engine.build(3)).toThrow(/Landmark locked/i);
    expect(engine.state.properties[3].buildLevel).toBe(3);
  });

  it('landmarks (level 4) cannot be force-bought by opponents', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[39].ownerId = 'p2';
    engine.state.properties[39].buildLevel = 4;

    engine.state.players[0].position = 35;
    engine.rollDice(2, 2);

    expect(engine.state.phase).not.toBe('FORCE_BUY_OFFER');
    expect(engine.state.forceBuyOffer).toBeNull();
  });

  it('triggers Triple Victory when a player owns 3 complete color sets', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    // Brown
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[3].ownerId = 'p1';
    // Dark Blue
    engine.state.properties[37].ownerId = 'p1';
    engine.state.properties[39].ownerId = 'p1';
    // Pink
    engine.state.properties[11].ownerId = 'p1';
    engine.state.properties[13].ownerId = 'p1';
    engine.state.properties[14].ownerId = 'p1';

    const hasWon = engine.checkAndApplyVictory();
    expect(hasWon).toBe(true);
    expect(engine.state.winnerId).toBe('p1');
    expect(engine.state.victoryType).toBe('triple_victory');
    expect(engine.state.phase).toBe('GAME_OVER');
  });

  it('triggers Line Victory when a player owns all properties on Side 1', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    [1, 3, 5, 6, 8, 9].forEach((idx) => {
      engine.state.properties[idx].ownerId = 'p1';
    });

    const hasWon = engine.checkAndApplyVictory();
    expect(hasWon).toBe(true);
    expect(engine.state.winnerId).toBe('p1');
    expect(engine.state.victoryType).toBe('line_victory');
    expect(engine.state.phase).toBe('GAME_OVER');
  });

  it('enters DEBT (not instant bankruptcy) when player cannot pay rent, then bankruptcy transfers properties', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.properties[37].ownerId = 'p2';
    engine.state.properties[37].buildLevel = 3;

    engine.state.players[0].money = 200;
    engine.state.players[0].position = 35;

    engine.rollDice(1, 1);

    expect(engine.state.players[0].isBankrupt).toBe(false);
    expect(engine.state.phase).toBe('DEBT');
    expect(engine.state.debt).not.toBeNull();
    expect(engine.state.debt?.creditorId).toBe('p2');

    engine.declareBankruptcy();

    expect(engine.state.players[0].isBankrupt).toBe(true);
    expect(engine.state.winnerId).toBe('p2');
    expect(engine.state.victoryType).toBe('bankruptcy');
    expect(engine.state.phase).toBe('GAME_OVER');
  });

  it('only allows upgrading the property the player stands on', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[3].ownerId = 'p1';
    engine.state.players[0].position = 1;
    engine.state.players[0].lapsCompleted = 1;

    expect(() => engine.build(3)).toThrow(/must stand on/i);
    expect(engine.state.properties[3].buildLevel).toBe(0);

    engine.build(1);
    expect(engine.state.properties[1].buildLevel).toBe(1);
  });

  it('landing exactly on GO allows building on any owned property', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[3].ownerId = 'p1';
    engine.state.players[0].position = 0; // standing on GO, not on either deed
    engine.state.players[0].lapsCompleted = 1;

    engine.build(3);
    expect(engine.state.properties[3].buildLevel).toBe(1);
    engine.build(1);
    expect(engine.state.properties[1].buildLevel).toBe(1);
  });

  it('caps voluntary mortgages at one per round, resetting when the player passes GO', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[3].ownerId = 'p1';

    engine.mortgage(1, true);
    expect(engine.state.properties[1].isMortgaged).toBe(true);
    expect(() => engine.mortgage(3, true)).toThrow(/one? property per round|1 property per round/i);
    expect(engine.state.properties[3].isMortgaged).toBe(false);

    // Passing GO resets the quota.
    engine.state.players[0].position = 35;
    engine.rollDice(2, 3); // 35 + 5 = 40 % 40 = 0
    expect(engine.state.players[0].lapsCompleted).toBe(1);

    engine.mortgage(3, true);
    expect(engine.state.properties[3].isMortgaged).toBe(true);
  });

  it('does not count debt-forced mortgages against the voluntary quota', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    const p1 = engine.state.players[0];
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[3].ownerId = 'p1';
    engine.state.debt = { amount: 500, creditorId: null, reason: 'test debt' };
    engine.state.phase = 'DEBT';
    p1.money = 10;

    engine.mortgage(1, true); // forced: raising cash for own debt
    expect(engine.state.properties[1].isMortgaged).toBe(true);
    expect(p1.mortgagesThisRound).toBe(0);

    // A further, voluntary mortgage this same round should still work.
    engine.state.debt = null;
    engine.state.phase = 'TURN_ENDED';
    engine.mortgage(3, true);
    expect(engine.state.properties[3].isMortgaged).toBe(true);
  });

  it('forecloses a mortgage the owner has not lifted after 3 of their own rounds', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    const p1 = engine.state.players[0];
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[1].isMortgaged = true;
    engine.state.properties[1].mortgagedAtLap = 0;

    // Two passes of GO (p1's own turns; force it back to p1's turn each time
    // so this only tests p1's own lap count): not stale yet.
    for (let i = 0; i < 2; i++) {
      engine.state.currentPlayerIndex = 0;
      engine.state.phase = 'ROLLING';
      engine.state.players[0].position = 35;
      engine.rollDice(2, 3);
    }
    expect(engine.state.properties[1].ownerId).toBe('p1');
    expect(engine.state.phase).not.toBe('AUCTION');

    // Third pass: now stale, the Bank forecloses and opens an auction.
    engine.state.currentPlayerIndex = 0;
    engine.state.phase = 'ROLLING';
    engine.state.players[0].position = 35;
    engine.rollDice(2, 3);
    expect(engine.state.properties[1].ownerId).toBeNull();
    expect(engine.state.properties[1].isMortgaged).toBe(false);
    expect(engine.state.phase).toBe('AUCTION');
    expect(engine.state.auction?.tileIndex).toBe(1);
  });

  it('random board-wide events stay off unless explicitly enabled', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.phase = 'TURN_ENDED';
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0); // would always fire if enabled
    engine.endTurn();
    spy.mockRestore();
    expect(engine.state.phase).not.toBe('AUCTION');
    expect(engine.state.activeEvent).toBeNull();
  });

  it('a random event can auction off an unowned property when enabled', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true, randomEvents: true });
    engine.state.phase = 'TURN_ENDED';
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    engine.endTurn();
    spy.mockRestore();
    expect(engine.state.phase).toBe('AUCTION');
    expect(engine.state.auction?.tileIndex).toBe(1);
    expect(engine.state.auction?.highBid).toBe(60); // opens at the deed price
  });

  it('sells one building level for half the build cost and auto-pays debt when covered', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    // Alice owns Baltic (tile 3, buildCost 50) with a house, stands on it.
    engine.state.properties[3].ownerId = 'p1';
    engine.state.properties[3].buildLevel = 1;
    engine.state.players[0].position = 3;
    // Park Place (tile 37, hotel rent 900) owned by Bob; Alice has $100.
    engine.state.properties[37].ownerId = 'p2';
    engine.state.properties[37].buildLevel = 3;
    engine.state.players[0].money = 100;
    engine.state.players[0].position = 35;

    engine.rollDice(1, 1);
    expect(engine.state.phase).toBe('DEBT');

    // Give Alice enough cash (minus one refund) so selling covers the $1100 debt.
    engine.state.properties[3].buildLevel = 1;
    engine.state.players[0].money = 1080;
    engine.sell(3);

    expect(engine.state.properties[3].buildLevel).toBe(0);
    expect(engine.state.debt).toBeNull();
    expect(engine.state.phase).toBe('TURN_ENDED');
    // 1080 + 25 refund - 1100 debt = 5 left; Bob got 1100.
    expect(engine.state.players[0].money).toBe(5);
    expect(engine.state.players[1].money).toBe(1500 + 1100);
  });

  it('rejects selling when there is nothing to sell', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true });
    engine.state.properties[1].ownerId = 'p1';
    expect(() => engine.sell(1)).toThrow(/no buildings/i);
  });

  it('emits a card draw for the modal when landing on a chest tile', () => {
    const draws: CardDraw[] = [];
    const engine = new MonopolyGameEngine('room123', seats, {
      specialVictory: true,
      onCard: (d) => draws.push(d)
    });
    engine.rollDice(1, 1); // tile 2 = Community Chest

    expect(draws.length).toBe(1);
    expect(draws[0].deck).toBe('chest');
    expect(draws[0].title.length).toBeGreaterThan(0);
    expect(draws[0].drawerId).toBe('p1');
    expect(draws[0].text.length).toBeGreaterThan(0);
  });

  it('enters DEBT for unaffordable tax instead of instant bankruptcy', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.players[0].money = 50;
    engine.state.players[0].position = 2; // tile 4 = Income Tax $200

    engine.rollDice(1, 1);

    expect(engine.state.phase).toBe('DEBT');
    expect(engine.state.debt?.amount).toBe(200);
    expect(engine.state.debt?.creditorId).toBeNull();
    expect(engine.state.players[0].isBankrupt).toBe(false);
  });

  it('requires passing GO once before building on raw land', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.players[0].position = 1;
    expect(() => engine.build(1)).toThrow(/pass GO/i);

    // Rolling past GO counts a lap
    engine.state.players[0].position = 38;
    engine.rollDice(2, 1); // lands on 1
    expect(engine.state.players[0].lapsCompleted).toBe(1);
    engine.build(1);
    expect(engine.state.properties[1].buildLevel).toBe(1);
  });

  it('only allows a Landmark once the whole color set is built to Hotels', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    const me = engine.state.players[0];
    me.lapsCompleted = 1;
    me.money = 5000;
    me.position = 1;
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[1].buildLevel = 3;
    engine.state.properties[3].ownerId = 'p1';
    engine.state.properties[3].buildLevel = 2;
    expect(() => engine.build(1)).toThrow(/whole color set/i);

    engine.state.properties[3].buildLevel = 3;
    engine.build(1);
    expect(engine.state.properties[1].buildLevel).toBe(4);
  });

  it('never offers or executes a force-buy on a Landmark', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.properties[6].ownerId = 'p2';
    engine.state.properties[6].buildLevel = 4;
    engine.state.players[0].money = 100000;
    engine.state.players[0].position = 4;
    engine.rollDice(1, 1); // lands on 6
    expect(engine.state.forceBuyOffer).toBeNull();
    expect(engine.state.properties[6].ownerId).toBe('p2');
  });

  it('bankruptcy sells everything to the bank and pays the creditor only the debt', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    const [p1, p2] = engine.state.players;
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[1].buildLevel = 2; // 2 x $25 back
    engine.state.properties[5].ownerId = 'p1'; // railroad, $100 back
    p1.money = 10;
    p2.money = 1000;
    engine.state.phase = 'DEBT';
    engine.state.debt = { amount: 120, creditorId: 'p2', reason: 'rent' };

    engine.declareBankruptcy();

    expect(p1.isBankrupt).toBe(true);
    expect(p2.money).toBe(1120); // owed amount only, not the whole estate
    expect(engine.state.properties[1].ownerId).toBeNull();
    expect(engine.state.properties[1].buildLevel).toBe(0);
    expect(engine.state.properties[5].ownerId).toBeNull();
  });

  it('bankruptcy pays the creditor at most what the liquidation raised', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    const [p1, p2] = engine.state.players;
    p1.money = 40;
    p2.money = 0;
    engine.state.phase = 'DEBT';
    engine.state.debt = { amount: 500, creditorId: 'p2', reason: 'rent' };
    engine.declareBankruptcy();
    expect(p2.money).toBe(40);
  });

  it('bankrupt player is skipped and the turn advances automatically', () => {
    const three = [...seats, { ...seats[1], seatIndex: 2, playerId: 'p3', displayName: 'Cara', color: 'green' as const, tokenType: 'dog' as const }];
    const engine = new MonopolyGameEngine('room123', three, { specialVictory: false });
    engine.state.phase = 'DEBT';
    engine.state.debt = { amount: 5000, creditorId: null, reason: 'tax' };
    engine.declareBankruptcy();
    expect(engine.state.phase).toBe('ROLLING');
    expect(engine.getCurrentPlayer().playerId).toBe('p2');
  });

  it('resolves the destination tile after a Chance "advance to" card', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    (engine as any).chanceDeck = [
      { id: 'x', deck: 'chance', action: { type: 'moveTo', tileIndex: 24, passGoCheck: true, text: 'Fly to London.' } }
    ];
    engine.state.players[0].position = 5;
    engine.rollDice(1, 1); // lands on Chance (7)
    expect(engine.state.players[0].position).toBe(24);
    expect(engine.state.phase).toBe('BUY_OFFER');
    expect(engine.state.buyOffer?.tileIndex).toBe(24);
  });

  it('trades money and unbuilt properties both ways when accepted', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[39].ownerId = 'p2';
    const t = engine.proposeTrade('p1', { toId: 'p2', giveMoney: 100, giveProps: [1], getMoney: 0, getProps: [39] });
    expect(engine.state.trades).toHaveLength(1);
    expect(() => engine.respondToTrade(t.id, 'p1', true)).toThrow(/receiving player/i);

    engine.respondToTrade(t.id, 'p2', true);
    expect(engine.state.properties[1].ownerId).toBe('p2');
    expect(engine.state.properties[39].ownerId).toBe('p1');
    expect(engine.state.players[0].money).toBe(1400);
    expect(engine.state.players[1].money).toBe(1600);
    expect(engine.state.trades).toHaveLength(0);
  });

  it('trades built properties with their buildings; rejects unaffordable cash; supports decline / cancel', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[1].buildLevel = 2;
    const built = engine.proposeTrade('p1', { toId: 'p2', giveMoney: 0, giveProps: [1], getMoney: 50, getProps: [] });
    engine.respondToTrade(built.id, 'p2', true);
    expect(engine.state.properties[1].ownerId).toBe('p2');
    expect(engine.state.properties[1].buildLevel).toBe(2);
    engine.state.players[0].money = 1500;
    engine.state.players[1].money = 1500;
    expect(() => engine.proposeTrade('p1', { toId: 'p2', giveMoney: 99999, giveProps: [], getMoney: 0, getProps: [] })).toThrow(/does not have/);

    const t1 = engine.proposeTrade('p1', { toId: 'p2', giveMoney: 10, giveProps: [], getMoney: 0, getProps: [] });
    engine.respondToTrade(t1.id, 'p2', false);
    expect(engine.state.players[1].money).toBe(1500);

    const t2 = engine.proposeTrade('p1', { toId: 'p2', giveMoney: 10, giveProps: [], getMoney: 0, getProps: [] });
    engine.cancelTrade(t2.id, 'p1');
    expect(engine.state.trades).toHaveLength(0);
  });

  it('a trade that gives the debtor enough cash settles their debt', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.phase = 'DEBT';
    engine.state.players[0].money = 0;
    engine.state.properties[39].ownerId = 'p1';
    engine.state.debt = { amount: 200, creditorId: null, reason: 'tax' };
    const t = engine.proposeTrade('p1', { toId: 'p2', giveMoney: 0, giveProps: [39], getMoney: 300, getProps: [] });
    engine.respondToTrade(t.id, 'p2', true);
    expect(engine.state.debt).toBeNull();
    expect(engine.state.phase).toBe('TURN_ENDED');
    expect(engine.state.players[0].money).toBe(100);
  });

  it('auction: bidding opens at the deed price; highest bidder pays the Bank and takes the deed', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.rollDice(1, 2);
    engine.respondToBuyOffer(false);

    // Tile 3 (Penang) lists for $60: the auction can never sell it cheaper.
    expect(engine.state.auction?.highBid).toBe(60);
    expect(() => engine.placeBid('p2', 5)).toThrow(/at least \$70/);
    engine.placeBid('p2', 70);
    expect(() => engine.placeBid('p1', 75)).toThrow(/at least \$80/);
    engine.placeBid('p1', 80);
    engine.placeBid('p2', 95);
    expect(() => engine.placeBid('p1', 99999)).toThrow(/only have/);
    engine.finishAuction();

    expect(engine.state.properties[3].ownerId).toBe('p2');
    expect(engine.state.players[1].money).toBe(1405);
    expect(engine.state.phase).toBe('TURN_ENDED');
    const txn = engine.state.bank.ledger.at(-1)!;
    expect(txn).toMatchObject({ fromId: 'p2', toId: null, amount: 95 });
  });

  it('the Bank has a limited supply of houses and hotels', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    const me = engine.state.players[0];
    me.lapsCompleted = 1;
    me.money = 5000;
    me.position = 1;
    engine.state.properties[1].ownerId = 'p1';

    engine.state.bank.houses = 0;
    expect(() => engine.build(1)).toThrow(/no houses/i);

    engine.state.bank.houses = 2;
    engine.build(1); // house
    engine.build(1); // building (2 houses on the tile)
    expect(engine.state.bank.houses).toBe(0);
    engine.state.bank.hotels = 0;
    expect(() => engine.build(1)).toThrow(/no hotels/i);
    engine.state.bank.hotels = 1;
    engine.build(1); // hotel: the 2 houses go back to the Bank
    expect(engine.state.bank.houses).toBe(2);
    expect(engine.state.bank.hotels).toBe(0);
  });

  it('selling a hotel during a housing shortage sells the property down to land', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[1].buildLevel = 3;
    engine.state.bank.hotels = 11;
    engine.state.bank.houses = 1;
    const before = engine.state.players[0].money;
    engine.sell(1);
    expect(engine.state.properties[1].buildLevel).toBe(0);
    expect(engine.state.players[0].money).toBe(before + 25 * 3);
    expect(engine.state.bank.hotels).toBe(12);
    expect(engine.state.bank.houses).toBe(1);
  });

  it('keeps a bank statement of money movements', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.players[0].position = 38;
    engine.rollDice(2, 1); // passes GO, lands on 1 (buy offer)
    engine.respondToBuyOffer(true);
    const ledger = engine.state.bank.ledger;
    expect(ledger.some((t) => t.reason === 'GO salary' && t.toId === 'p1' && t.amount === 200)).toBe(true);
    expect(ledger.some((t) => t.reason.startsWith('Bought') && t.fromId === 'p1' && t.amount === 60)).toBe(true);
  });

  it('bankruptcy returns building pieces to the Bank', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[1].buildLevel = 2;
    engine.state.properties[3].ownerId = 'p1';
    engine.state.properties[3].buildLevel = 4;
    engine.state.bank.houses = 30;
    engine.state.bank.hotels = 11;
    engine.state.phase = 'DEBT';
    engine.state.debt = { amount: 9999, creditorId: null, reason: 'tax' };
    engine.declareBankruptcy();
    expect(engine.state.bank.houses).toBe(32);
    expect(engine.state.bank.hotels).toBe(12);
  });

  it('counter-offers go back and forth and can be accepted', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    engine.state.properties[1].ownerId = 'p1';
    engine.state.properties[39].ownerId = 'p2';
    const first = engine.proposeTrade('p1', { toId: 'p2', giveMoney: 100, giveProps: [1], getMoney: 0, getProps: [39] });
    expect(first.round).toBe(1);
    expect(() => engine.counterTrade(first.id, 'p1', { toId: 'p2', giveMoney: 0, giveProps: [], getMoney: 0, getProps: [] })).toThrow(/receiving player/);
    // Unchanged terms are refused.
    expect(() =>
      engine.counterTrade(first.id, 'p2', { toId: 'p1', giveMoney: 0, giveProps: [39], getMoney: 100, getProps: [1] })
    ).toThrow(/Change something/);

    // Bob wants $300 instead of $100.
    const counter = engine.counterTrade(first.id, 'p2', {
      toId: 'p1',
      giveMoney: 0,
      giveProps: [39],
      getMoney: 300,
      getProps: [1],
      message: 'Make it 300'
    });
    expect(engine.state.trades).toHaveLength(1);
    expect(counter).toMatchObject({ fromId: 'p2', toId: 'p1', round: 2, getMoney: 300, message: 'Make it 300' });
    expect(counter.history?.[0]).toMatchObject({ fromId: 'p1', giveMoney: 100 });
    expect(engine.state.trades.some((t) => t.id === first.id)).toBe(false);

    engine.respondToTrade(counter.id, 'p1', true);
    expect(engine.state.properties[39].ownerId).toBe('p1');
    expect(engine.state.properties[1].ownerId).toBe('p2');
    expect(engine.state.players[0].money).toBe(1200);
    expect(engine.state.players[1].money).toBe(1800);
  });

  it('a negotiation stops after 10 rounds', () => {
    const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
    let t = engine.proposeTrade('p1', { toId: 'p2', giveMoney: 1, giveProps: [], getMoney: 0, getProps: [] });
    for (let r = 2; r <= 10; r++) {
      const by = t.toId;
      t = engine.counterTrade(t.id, by, { toId: t.fromId, giveMoney: r, giveProps: [], getMoney: 0, getProps: [] });
    }
    expect(t.round).toBe(10);
    expect(() => engine.counterTrade(t.id, t.toId, { toId: t.fromId, giveMoney: 99, giveProps: [], getMoney: 0, getProps: [] })).toThrow(
      /long enough/
    );
  });

  describe('selling and mortgages (classic rules)', () => {
    it('any player can sell buildings at any time, straight down to a chosen level', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      // Bob (not the current player) owns Baltic (buildCost 50) with a Hotel.
      engine.state.properties[3].ownerId = 'p2';
      engine.state.properties[3].buildLevel = 3;
      engine.sell(3, 'p2', 1);
      expect(engine.state.properties[3].buildLevel).toBe(1);
      expect(engine.state.players[1].money).toBe(1500 + 25 * 2);
      expect(() => engine.sell(3, 'p1')).toThrow(/do not own/i);
    });

    it('sells a whole deed back to the Bank (buildings half + land at mortgage value)', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[3].ownerId = 'p1';
      engine.state.properties[3].buildLevel = 2;
      engine.state.bank.houses = 30;
      engine.sellProperty(3, 'p1');
      expect(engine.state.properties[3].ownerId).toBeNull();
      expect(engine.state.properties[3].buildLevel).toBe(0);
      expect(engine.state.players[0].money).toBe(1500 + 50 + 30);
      expect(engine.state.bank.houses).toBe(32);

      // A mortgaged deed just cancels the loan.
      engine.state.properties[1].ownerId = 'p1';
      engine.state.properties[1].isMortgaged = true;
      engine.sellProperty(1, 'p1');
      expect(engine.state.properties[1].ownerId).toBeNull();
      expect(engine.state.properties[1].isMortgaged).toBe(false);
      expect(engine.state.players[0].money).toBe(1580);
    });

    it('mortgages only bare land: no buildings anywhere in the color set', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[1].ownerId = 'p1';
      engine.state.properties[3].ownerId = 'p1';
      engine.state.properties[3].buildLevel = 1;
      expect(() => engine.mortgage(1, true, 'p1')).toThrow(/Sell the buildings in this color set/);
      engine.sell(3, 'p1');
      engine.mortgage(1, true, 'p1');
      expect(engine.state.properties[1].isMortgaged).toBe(true);
      expect(engine.state.players[0].money).toBe(1500 + 25 + 30);
    });

    it('lifting a mortgage costs the value plus 10% interest', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[39].ownerId = 'p1'; // price 400 -> mortgage 200
      engine.mortgage(39, true, 'p1');
      expect(engine.state.players[0].money).toBe(1700);
      engine.mortgage(39, false, 'p1');
      expect(engine.state.players[0].money).toBe(1700 - 220);
      expect(engine.state.properties[39].isMortgaged).toBe(false);
    });

    it('no rent on a mortgaged deed; the rest of a full set still pays double', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[1].ownerId = 'p2';
      engine.state.properties[3].ownerId = 'p2';
      engine.state.properties[1].isMortgaged = true;
      engine.rollDice(1, 2); // Alice lands on 3
      expect(engine.state.players[0].money).toBe(1500 - 4 * 2);
    });

    it('cannot build in a color set while any of its deeds is mortgaged', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[1].ownerId = 'p1';
      engine.state.properties[3].ownerId = 'p1';
      engine.state.properties[1].isMortgaged = true;
      engine.state.players[0].position = 3;
      engine.state.players[0].lapsCompleted = 1;
      expect(() => engine.build(3)).toThrow(/Lift the mortgage on/);
    });

    it('mortgaged deeds can be traded; the receiver pays 10% interest and it stays mortgaged', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[39].ownerId = 'p1';
      engine.state.properties[39].isMortgaged = true;
      const t = engine.proposeTrade('p1', { toId: 'p2', giveMoney: 0, giveProps: [39], getMoney: 100, getProps: [] });
      engine.respondToTrade(t.id, 'p2', true);
      expect(engine.state.properties[39].ownerId).toBe('p2');
      expect(engine.state.properties[39].isMortgaged).toBe(true);
      expect(engine.state.players[1].money).toBe(1500 - 100 - 20);
      expect(engine.state.players[0].money).toBe(1600);
    });
  });

  describe('surrender, turn timer and persistence', () => {
    const three = () => [
      ...seats,
      { ...seats[1], seatIndex: 2, playerId: 'p3', displayName: 'Cara', color: 'green' as const, tokenType: 'dog' as const, isHost: false }
    ];
    afterEach(() => {
      vi.useRealTimers();
    });

    it('surrender on your own turn returns everything to the Bank and passes the turn', () => {
      const engine = new MonopolyGameEngine('room123', three(), { specialVictory: false });
      engine.state.properties[1].ownerId = 'p1';
      engine.state.properties[1].buildLevel = 2;
      engine.state.bank.houses = 30;
      engine.surrender('p1');
      const alice = engine.state.players[0];
      expect(alice.isBankrupt).toBe(true);
      expect(alice.surrendered).toBe(true);
      expect(engine.state.properties[1].ownerId).toBeNull();
      expect(engine.state.bank.houses).toBe(32);
      expect(engine.getCurrentPlayer().playerId).toBe('p2');
      expect(engine.state.phase).toBe('ROLLING');
    });

    it('surrender off-turn keeps the turn; the last one standing wins', () => {
      const engine = new MonopolyGameEngine('room123', three(), { specialVictory: false });
      engine.surrender('p3');
      expect(engine.getCurrentPlayer().playerId).toBe('p1');
      expect(engine.state.phase).toBe('ROLLING');
      engine.surrender('p1');
      expect(engine.state.phase).toBe('GAME_OVER');
      expect(engine.state.winnerId).toBe('p2');
      expect(() => engine.surrender('p2')).toThrow(/game is over/i);
    });

    it('surrendering in debt pays the creditor from the sale', () => {
      const engine = new MonopolyGameEngine('room123', three(), { specialVictory: false });
      engine.state.phase = 'DEBT';
      engine.state.debt = { amount: 400, creditorId: 'p2', reason: 'rent' };
      engine.state.players[0].money = 100;
      engine.state.properties[39].ownerId = 'p1'; // mortgage value 200
      engine.surrender('p1');
      expect(engine.state.players[1].money).toBe(1500 + 300);
      expect(engine.state.debt).toBeNull();
      expect(engine.getCurrentPlayer().playerId).toBe('p2');
    });

    it('the turn timer plays the turn when it runs out', () => {
      vi.useFakeTimers();
      const dice: number[] = [];
      const engine = new MonopolyGameEngine('room123', seats, {
        specialVictory: false,
        turnTimerSec: 30,
        onDice: (d) => dice.push(d.d1 + d.d2)
      });
      engine.checkAndApplyVictory();
      (engine as unknown as { notify: () => void }).notify();
      expect(engine.state.turnDeadline).toBeGreaterThan(Date.now());
      vi.advanceTimersByTime(30_000);
      expect(dice).toHaveLength(1);
      expect(engine.state.players[0].timeouts).toBe(1);
      engine.markActive('p1');
      expect(engine.state.players[0].timeouts).toBe(0);
    });

    it('an offline player is auto-played on a short clock and removed after 3 missed turns', () => {
      vi.useFakeTimers();
      const engine = new MonopolyGameEngine('room123', three(), { specialVictory: false });
      engine.setConnected('p1', false);
      expect(engine.state.turnDeadline).not.toBeNull();
      const alice = engine.state.players[0];
      // Keep it Alice's turn: the auto-played decisions all belong to her.
      for (let i = 0; i < 3 && !alice.isBankrupt; i++) {
        engine.state.currentPlayerIndex = 0;
        engine.state.phase = 'TURN_ENDED';
        engine.state.doubles = false;
        (engine as unknown as { turnKey: string }).turnKey = '';
        (engine as unknown as { notify: () => void }).notify();
        vi.advanceTimersByTime(20_000);
      }
      expect(alice.isBankrupt).toBe(true);
      expect(alice.surrendered).toBe(true);
    });

    it('snapshot / restore rebuilds the same game (decks included)', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: true, turnTimerSec: 60 });
      engine.rollDice(1, 2);
      engine.respondToBuyOffer(true);
      const snap = JSON.parse(JSON.stringify(engine.snapshot()));
      engine.dispose();
      const back = MonopolyGameEngine.restore(snap);
      expect(back.state.properties[3].ownerId).toBe('p1');
      expect(back.state.players.every((p) => !p.isConnected)).toBe(true);
      expect(back.snapshot().chance).toEqual(snap.chance);
      expect(back.options.turnTimerSec).toBe(60);
      back.dispose();
    });
  });

  describe('original Chance / Community Chest cards', () => {
    const card = (list: typeof CHANCE_CARDS, id: string) => list.find((c) => c.id === id)!;
    const rig = (engine: MonopolyGameEngine, deck: 'chance' | 'chest', id: string) => {
      const list = deck === 'chance' ? CHANCE_CARDS : CHEST_CARDS;
      (engine as any)[deck === 'chance' ? 'chanceDeck' : 'chestDeck'] = [card(list, id), ...list.filter((c) => c.id !== id)];
    };

    it('has the 16 + 16 classic cards', () => {
      expect(CHANCE_CARDS).toHaveLength(16);
      expect(CHEST_CARDS).toHaveLength(16);
    });

    it('nearest airport: moves forward (collecting GO) and pays double rent', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[5].ownerId = 'p2';
      rig(engine, 'chance', 'ch_airport1');
      engine.state.players[0].position = 34;
      engine.rollDice(1, 1); // 36 = Chance -> nearest airport = 5 (passes GO)
      const [p1, p2] = engine.state.players;
      expect(p1.position).toBe(5);
      expect(p1.money).toBe(1500 + 200 - 50);
      expect(p2.money).toBe(1550);
      expect(engine.state.lastMove?.passedGo).toBe(true);
    });

    it('nearest utility owned by another player: pays 10x a fresh roll', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[12].ownerId = 'p2';
      rig(engine, 'chance', 'ch_utility');
      engine.state.players[0].position = 5;
      engine.rollDice(1, 1); // 7 = Chance -> 12
      const paid = 1500 - engine.state.players[0].money;
      expect(engine.state.players[0].position).toBe(12);
      expect(paid).toBeGreaterThanOrEqual(20);
      expect(paid).toBeLessThanOrEqual(120);
      expect(paid % 10).toBe(0);
    });

    it('go back 3 spaces resolves the new tile and does not pay GO', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      rig(engine, 'chance', 'ch_back3');
      engine.state.players[0].position = 5;
      engine.rollDice(1, 1); // 7 -> back to 4 = Income Tax $200
      expect(engine.state.players[0].position).toBe(4);
      expect(engine.state.players[0].money).toBe(1300);
    });

    it('repairs charge per house and per hotel', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      engine.state.properties[1].ownerId = 'p1';
      engine.state.properties[1].buildLevel = 2; // 2 houses
      engine.state.properties[3].ownerId = 'p1';
      engine.state.properties[3].buildLevel = 3; // 1 hotel
      rig(engine, 'chest', 'cc_street');
      engine.rollDice(1, 1); // 2 = Community Chest
      expect(engine.state.players[0].money).toBe(1500 - (2 * 40 + 115));
    });

    it('chairman pays every player; if unaffordable the debt is split between them', () => {
      const three = [...seats, { ...seats[1], seatIndex: 2, playerId: 'p3', displayName: 'Cara', color: 'green' as const, tokenType: 'dog' as const }];
      const engine = new MonopolyGameEngine('room123', three, { specialVictory: false });
      rig(engine, 'chance', 'ch_chairman');
      engine.state.players[0].position = 5;
      engine.state.players[0].money = 60;
      engine.rollDice(1, 1);
      expect(engine.state.phase).toBe('DEBT');
      expect(engine.state.debt?.amount).toBe(100);
      engine.state.players[0].money = 150;
      engine.state.properties[39].ownerId = 'p1';
      engine.mortgage(39, true); // raises cash -> debt auto-pays, split 50/50
      expect(engine.state.debt).toBeNull();
      expect(engine.state.players[1].money).toBe(1550);
      expect(engine.state.players[2].money).toBe(1550);
    });

    it('Get Out of Jail Free is kept until used, then goes back under its deck', () => {
      const engine = new MonopolyGameEngine('room123', seats, { specialVictory: false });
      rig(engine, 'chest', 'cc_jailfree');
      engine.rollDice(1, 1);
      const p1 = engine.state.players[0];
      expect(p1.jailCards).toBe(1);
      expect((engine as any).chestDeck.some((c: any) => c.id === 'cc_jailfree')).toBe(false);
      p1.inJail = true;
      engine.state.phase = 'ROLLING';
      engine.useJailCard();
      expect(p1.jailCards).toBe(0);
      expect((engine as any).chestDeck.at(-1).id).toBe('cc_jailfree');
    });
  });
});
