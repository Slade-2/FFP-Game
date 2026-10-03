import { describe, expect, it } from 'vitest';
import { GameEngine } from '../server/game';
import { beats, type Card } from '../server/rules';

const players = [
  { seat: 0, nickname: '甲' },
  { seat: 1, nickname: '乙' },
  { seat: 2, nickname: '丙' },
  { seat: 3, nickname: '丁' },
];

function seededRandom(seed = 77): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function createEngine() {
  const events: Array<{ event: string; payload: any; seat?: number }> = [];
  const engine = new GameEngine(players, 'dapengyou', {
    rng: seededRandom(),
    emit: (event, payload, seat) => events.push({ event, payload, seat }),
  });
  engine.start();
  return { engine, events };
}

function runSingleCardGame(engine: GameEngine): void {
  let safety = 1000;
  while (engine.phase !== 'over' && safety-- > 0) {
    const seat = engine.currentSeat;
    const hand = engine.getHand(seat);
    const table = engine.currentTable;
    if (!table) {
      const lead = engine.isFirstPlay
        ? hand.find((card) => card.r === 0 && card.s === 0)
        : hand[0];
      engine.play(seat, lead ? [lead] : []);
    } else {
      const follow = hand.find((card) => beats(table.cards, [card]));
      if (follow) {
        engine.play(seat, [follow]);
      } else {
        engine.pass(seat);
      }
    }
  }
  expect(safety).toBeGreaterThan(0);
}

describe('M4 打朋友叫牌与结算', () => {
  it('叫到自己的牌进入 1v3，公开报文不含队友或独打标记', () => {
    const { engine, events } = createEngine();
    const callerSeat = engine.currentSeat;
    const ownCallable = engine.getHand(callerSeat).find((card) => card.r <= 6);
    expect(ownCallable).toBeDefined();

    expect(events.some((event) => (
      event.event === 'game:call-request' && event.seat === callerSeat
    ))).toBe(true);
    engine.call(callerSeat, (ownCallable as Card).r, (ownCallable as Card).s);

    const result = events.find((event) => event.event === 'game:call-result');
    expect(result?.seat).toBeUndefined();
    expect(Object.keys(result?.payload ?? {}).sort()).toEqual(['callerSeat', 'r', 's']);
    expect(JSON.stringify(result?.payload)).not.toMatch(/team|teammate|solo/i);
    const reveal = events.find((event) => event.event === 'game:team-reveal');
    expect(reveal?.seat).toBe(callerSeat);
    expect(reveal?.payload).toMatchObject({
      callerSeat,
      teammateSeat: callerSeat,
      selfCall: true,
    });
  });

  it('叫到对手的牌进入 2v2，任何公开报文都不泄露队友身份', () => {
    const { engine, events } = createEngine();
    const callerSeat = engine.currentSeat;
    const target = [0, 1, 2, 3]
      .filter((seat) => seat !== callerSeat)
      .flatMap((seat) => engine.getHand(seat).map((card) => ({ seat, card })))
      .find(({ card }) => card.r <= 6);
    expect(target).toBeDefined();

    engine.call(callerSeat, (target?.card as Card).r, (target?.card as Card).s);
    const publicEvents = events.filter((event) => event.seat === undefined);
    expect(JSON.stringify(publicEvents)).not.toMatch(/team|teammate/i);
    const reveal = events.find((event) => event.event === 'game:team-reveal');
    expect(reveal?.seat).toBe(target?.seat);
    expect(reveal?.payload).toMatchObject({
      callerSeat,
      teammateSeat: target?.seat,
      selfCall: false,
    });
  });

  it('1v3 中叫牌人先出完立即按 +12 结算', () => {
    const { engine, events } = createEngine();
    const callerSeat = engine.currentSeat;
    const ownCallable = engine.getHand(callerSeat).find((card) => card.r <= 6) as Card;
    engine.call(callerSeat, ownCallable.r, ownCallable.s);
    runSingleCardGame(engine);

    const over = events.find((event) => event.event === 'game:over');
    const changes = over?.payload.scoreChanges as number[];
    expect(changes).toHaveLength(4);
    expect(Math.abs(changes[callerSeat])).toBe(12);
    expect(changes.reduce((sum, value) => sum + value, 0)).toBe(0);
  });
});
