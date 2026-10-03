import { describe, expect, it } from 'vitest';
import { GameEngine } from '../server/game';
import { beats, findSmallestWinningPlay, type Card } from '../server/rules';

const players = [
  { seat: 0, nickname: '甲' },
  { seat: 1, nickname: '乙' },
  { seat: 2, nickname: '丙' },
  { seat: 3, nickname: '丁' },
];

function seededRandom(seed = 42): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function createEngine() {
  const events: Array<{ event: string; payload: any; seat?: number }> = [];
  const engine = new GameEngine(players, 'dahua', {
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
      continue;
    }

    const follow = hand.find((card) => beats(table.cards, [card]));
    if (follow) {
      engine.play(seat, [follow]);
    } else {
      engine.pass(seat);
    }
  }
  expect(safety).toBeGreaterThan(0);
}

function playUntilFirstOut(engine: GameEngine): number {
  let safety = 1000;
  while (engine.phase === 'playing' && engine.getRankings().length === 0 && safety-- > 0) {
    const seat = engine.currentSeat;
    const hand = engine.getHand(seat);
    const table = engine.currentTable;

    if (!table) {
      const lead = engine.isFirstPlay
        ? hand.find((card) => card.r === 0 && card.s === 0)
        : hand[0];
      engine.play(seat, lead ? [lead] : []);
      continue;
    }

    const follow = hand.find((card) => beats(table.cards, [card]));
    if (follow) {
      engine.play(seat, [follow]);
    } else {
      engine.pass(seat);
    }
  }

  expect(safety).toBeGreaterThan(0);
  const finishedSeat = engine.getRankings()[0];
  expect(finishedSeat).toBeDefined();
  if (finishedSeat === undefined) {
    throw new Error('未找到已出完的玩家');
  }
  return finishedSeat;
}

describe('M2 打花对局状态机', () => {
  it('发牌为四家各13张，方块4持有者先手', () => {
    const { engine, events } = createEngine();
    const deals = events.filter((event) => event.event === 'game:deal');
    expect(deals).toHaveLength(4);
    expect(deals.every((event) => event.payload.cards.length === 13)).toBe(true);
    expect(events.findIndex((event) => event.event === 'game:start'))
      .toBeLessThan(events.findIndex((event) => event.event === 'game:deal'));

    const allCards = deals.flatMap((event) => event.payload.cards as Card[]);
    expect(new Set(allCards.map((item) => `${item.r}:${item.s}`)).size).toBe(52);

    const holder = [0, 1, 2, 3].find((seat) => (
      engine.getHand(seat).some((item) => item.r === 0 && item.s === 0)
    ));
    expect(engine.currentSeat).toBe(holder);
  });

  it('拒绝越权、非法首手和领出时 pass', () => {
    const { engine } = createEngine();
    const leader = engine.currentSeat;

    expect(() => engine.play((leader + 1) % 4, [engine.getHand((leader + 1) % 4)[0]]))
      .toThrow('未轮到你出牌');
    expect(() => engine.pass(leader)).toThrow('领出时不能 pass');

    const notDiamondFour = engine.getHand(leader).find((item) => item.r !== 0 || item.s !== 0);
    expect(notDiamondFour).toBeDefined();
    expect(() => engine.play(leader, [notDiamondFour as Card])).toThrow('首手必须包含方块4');

    const otherSeat = (leader + 1) % 4;
    expect(() => engine.play(leader, [engine.getHand(otherSeat)[0]])).toThrow('不能打出不属于自己的牌');
  });

  it('game:turn 携带本轮已出牌，便于重连恢复', () => {
    const { engine, events } = createEngine();
    const leader = engine.currentSeat;
    const diamondFour = engine.getHand(leader).find((card) => card.r === 0 && card.s === 0);
    expect(diamondFour).toBeDefined();

    engine.play(leader, [diamondFour as Card]);

    const turns = events.filter((event) => event.event === 'game:turn');
    const latestTurn = turns.at(-1);
    expect(latestTurn?.payload.roundPlays).toHaveLength(1);
    expect(latestTurn?.payload.roundPlays[0].seat).toBe(leader);
    expect(latestTurn?.payload.cardCounts[leader]).toBe(12);
  });

  it('每家只保留最近动作，新回合开始时只清空行动者的位置', () => {
    const { engine, events } = createEngine();
    const leader = engine.currentSeat;
    const diamondFour = engine.getHand(leader).find((card) => card.r === 0 && card.s === 0);
    engine.play(leader, [diamondFour as Card]);

    const follower = engine.currentSeat;
    const afterLead = events.filter((event) => event.event === 'game:turn').at(-1)?.payload;
    expect(afterLead.tableActions[leader]).toMatchObject({ kind: 'play' });
    expect(afterLead.tableActions[follower]).toBeNull();

    const response = findSmallestWinningPlay(
      engine.getHand(follower),
      engine.currentTable?.cards ?? null,
      false,
    );
    expect(engine.canRespond(follower)).toBe(Boolean(response));
    if (response) {
      engine.play(follower, response);
    } else {
      engine.pass(follower);
    }

    const afterFollow = events.filter((event) => event.event === 'game:turn').at(-1)?.payload;
    expect(afterFollow.tableActions[leader]).toMatchObject({ kind: 'play' });
    expect(afterFollow.tableActions[follower]).toMatchObject({
      kind: response ? 'play' : 'pass',
    });
    expect(afterFollow.tableActions[engine.currentSeat]).toBeNull();
  });

  it('已出完玩家的最后出牌在本墩重置时清空', () => {
    const { engine, events } = createEngine();
    const finishedSeat = playUntilFirstOut(engine);

    for (let index = 0; index < 3; index += 1) {
      engine.pass(engine.currentSeat);
    }

    const latestTurn = events.filter((event) => event.event === 'game:turn').at(-1);
    expect(latestTurn?.payload.tableActions[finishedSeat]).toBeNull();
  });

  it('可完整跑完一局，三圈 pass 会重置领出，结算零和', () => {
    const { engine, events } = createEngine();
    runSingleCardGame(engine);

    expect(events.some((event) => event.event === 'game:round-reset')).toBe(true);
    const over = events.find((event) => event.event === 'game:over');
    expect(over?.payload.rankings).toHaveLength(4);
    expect(new Set(over?.payload.rankings).size).toBe(4);
    expect((over?.payload.scoreChanges as number[]).reduce((sum, value) => sum + value, 0)).toBe(0);
  });
});
