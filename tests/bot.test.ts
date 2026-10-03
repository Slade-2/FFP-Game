import { describe, expect, it } from 'vitest';
import { BotBrain } from '../server/bot';
import { beats, type Card } from '../server/rules';

// r: 0=4 … 10=A、11=2、12=3；s: 0=方块 < 1=梅花 < 2=红桃 < 3=黑桃
function card(r: number, s: number): Card {
  return { r, s };
}

function key(cards: Card[]): string[] {
  return cards.map((item) => `${item.r}:${item.s}`).sort();
}

describe('BotBrain 打花/打朋友机器人智能', () => {
  it('有对子时领出优先对子而非单张', () => {
    const brain = new BotBrain(0, 'dahua');
    const hand = [card(1, 0), card(4, 1), card(4, 2), card(9, 1), card(12, 3)];

    const lead = brain.chooseLead(hand, [5, 13, 13, 13]);

    expect(lead).not.toBeNull();
    expect(key(lead as Card[])).toEqual(['4:1', '4:2']);
  });

  it('首手必含方块4', () => {
    const brain = new BotBrain(0, 'dahua');
    const hand = [card(0, 0), card(0, 1), card(5, 2), card(9, 0), card(12, 1)];

    const lead = brain.chooseLead(hand, [5, 13, 13, 13]);

    expect(lead).not.toBeNull();
    expect(lead?.some((item) => item.r === 0 && item.s === 0)).toBe(true);
    expect(lead).toHaveLength(2);
  });

  it('桌牌是确定队友时选择 pass', () => {
    const brain = new BotBrain(0, 'dapengyou');
    const counts = [13, 13, 10, 13];
    brain.onCallResult(0, 2, 1);
    brain.onPlay(2, [card(2, 1)], 10, counts, true);
    expect(brain.relationWith(2)).toBe(100);

    const hand = [card(3, 0), card(5, 1), card(7, 0), card(10, 0), card(12, 2)];

    expect(brain.chooseResponse(hand, [card(2, 1)], counts)).toBeNull();
  });

  it('有能一手出完的合法管牌时直接出', () => {
    const brain = new BotBrain(1, 'dahua');
    const hand = [card(2, 0), card(2, 1)];
    const table = [card(1, 0), card(1, 3)];

    const response = brain.chooseResponse(hand, table, [3, 2, 3, 3]);

    expect(response).not.toBeNull();
    expect(key(response as Card[])).toEqual(['2:0', '2:1']);
  });

  it('确定敌人剩 2 张且管得住时出牌堵住', () => {
    const brain = new BotBrain(1, 'dapengyou');
    brain.onCallResult(0, 5, 0);
    expect(brain.relationWith(0)).toBe(-100);
    const counts = [2, 13, 13, 13];
    brain.onPlay(0, [card(5, 0)], 2, counts, true);

    const hand = [card(6, 0), card(9, 1), card(11, 0), card(12, 0)];
    const response = brain.chooseResponse(hand, [card(5, 0)], counts);

    expect(response).not.toBeNull();
    expect(beats([card(5, 0)], response as Card[])).toBe(true);
    expect(response).toHaveLength(1);
    expect((response as Card[])[0].r).toBe(6);
  });

  it('弱手牌不自叫，叫的点数自己没有', () => {
    const brain = new BotBrain(3, 'dapengyou');
    const hand = [card(0, 0), card(0, 1), card(1, 0), card(1, 1), card(10, 0), card(12, 0)];

    const call = brain.chooseCall(hand);

    expect(call.r).toBeGreaterThanOrEqual(2);
    expect(call.r).toBeLessThanOrEqual(5);
    expect(hand.some((item) => item.r === call.r)).toBe(false);
    expect(hand.some((item) => item.r === call.r && item.s === call.s)).toBe(false);
  });

  it('强手牌自叫时叫自己持有的中等牌', () => {
    const brain = new BotBrain(1, 'dapengyou');
    const hand = [
      card(2, 0), card(6, 1), card(10, 0), card(10, 2),
      card(11, 1), card(11, 3), card(12, 0), card(12, 2),
    ];

    const call = brain.chooseCall(hand);

    expect(hand.some((item) => item.r === call.r && item.s === call.s)).toBe(true);
  });

  it('有人打出被叫牌时把他锁定为队友 +100', () => {
    const brain = new BotBrain(0, 'dapengyou');
    brain.onCallResult(0, 2, 1);
    expect(brain.relationWith(3)).toBe(0);

    brain.onPlay(3, [card(2, 1)], 7, [13, 13, 13, 7], true);

    expect(brain.relationWith(3)).toBe(100);
  });

  it('被叫者收到身份揭示后把叫牌人记为队友、另两家记为敌人', () => {
    const brain = new BotBrain(2, 'dapengyou');
    brain.onCallResult(0, 2, 1);
    brain.onTeamReveal({ callerSeat: 0, teammateSeat: 2, selfCall: false });

    expect(brain.relationWith(0)).toBe(100);
    expect(brain.relationWith(1)).toBe(-100);
    expect(brain.relationWith(3)).toBe(-100);
  });

  it('管一次队友的牌且未出完只扣 15 分，不断交', () => {
    const brain = new BotBrain(0, 'dapengyou');
    const counts = [13, 13, 10, 13];
    brain.onCallResult(0, 2, 1);
    brain.onPlay(2, [card(2, 1)], 10, counts, true);
    expect(brain.relationWith(2)).toBe(100);

    brain.onPlay(2, [card(5, 0)], 10, counts, true);
    brain.onPlay(1, [card(6, 0)], 13, counts, false);

    expect(brain.relationWith(1)).toBe(-15);
    expect(brain.relationWith(1)).toBeGreaterThan(-60);
  });

  it('管队友的牌但直接出完时不扣分', () => {
    const brain = new BotBrain(0, 'dapengyou');
    const counts = [13, 0, 10, 13];
    brain.onCallResult(0, 2, 1);
    brain.onPlay(2, [card(2, 1)], 10, [13, 13, 10, 13], true);
    brain.onPlay(2, [card(5, 0)], 10, [13, 13, 10, 13], true);

    brain.onPlay(1, [card(6, 0)], 0, counts, false);

    expect(brain.relationWith(1)).toBe(0);
  });

  it('确定队友剩 2 张时领最小单张喂牌', () => {
    const brain = new BotBrain(0, 'dapengyou');
    brain.onCallResult(0, 2, 1);
    brain.onPlay(3, [card(2, 1)], 2, [9, 13, 13, 2], true);
    expect(brain.relationWith(3)).toBe(100);

    const hand = [card(1, 0), card(4, 1), card(9, 0)];
    const lead = brain.chooseLead(hand, [9, 13, 13, 2]);

    expect(key(lead as Card[])).toEqual(['1:0']);
  });

  it('确定敌人剩 2 张时领最大对子堵牌', () => {
    const brain = new BotBrain(0, 'dahua');
    const hand = [card(1, 0), card(4, 1), card(4, 2), card(9, 0)];

    const lead = brain.chooseLead(hand, [4, 2, 13, 13]);

    expect(key(lead as Card[])).toEqual(['4:1', '4:2']);
  });

  it('默认不领同花顺，留作控制牌', () => {
    const brain = new BotBrain(0, 'dahua');
    const hand = [
      card(1, 0), card(2, 0), card(3, 0), card(4, 0), card(5, 0),
      card(9, 1), card(9, 2),
    ];

    const lead = brain.chooseLead(hand, [7, 13, 13, 13]);

    expect(key(lead as Card[])).toEqual(['9:1', '9:2']);
  });
});
