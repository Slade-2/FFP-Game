import { describe, expect, it } from 'vitest';
import { beats, detect, findSmallestWinningPlay, type Card } from '../server/rules';

const card = (r: number, s: number): Card => ({ r, s });

describe('牌型识别', () => {
  it('识别基础牌型', () => {
    expect(detect([card(0, 0)])?.type).toBe('SINGLE');
    expect(detect([card(0, 0), card(0, 2)])?.type).toBe('PAIR');
    expect(detect([card(0, 0), card(0, 1), card(0, 3)])?.type).toBe('TRIPLE');
    expect(detect([card(0, 0), card(0, 1), card(0, 2), card(12, 0), card(12, 3)])?.type)
      .toBe('FULL_HOUSE');
    expect(detect([card(3, 0), card(3, 1), card(3, 2), card(3, 3)])?.type).toBe('FOUR');
    expect(detect([card(3, 0), card(3, 1), card(3, 2), card(3, 3), card(12, 0)])?.type)
      .toBe('FOUR_WITH_ONE');
  });

  it('识别顺子、同花和同花顺，并优先识别同花顺', () => {
    expect(detect([card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(4, 0)])?.type)
      .toBe('STRAIGHT');
    expect(detect([card(0, 0), card(2, 0), card(5, 0), card(9, 0), card(10, 0)])?.type)
      .toBe('FLUSH');
    expect(detect([card(0, 0), card(1, 0), card(2, 0), card(3, 0), card(4, 0)])?.type)
      .toBe('STRAIGHT_FLUSH');
  });

  it('仅允许 4~A 连续五张构成顺子', () => {
    expect(detect([card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(4, 0)])).not.toBeNull();
    expect(detect([card(6, 0), card(7, 1), card(8, 2), card(9, 3), card(10, 0)])).not.toBeNull();
    expect(detect([card(10, 0), card(11, 1), card(12, 2), card(0, 3), card(1, 0)])).toBeNull();
    expect(detect([card(11, 0), card(12, 1), card(0, 2), card(1, 3), card(2, 0)])).toBeNull();
    expect(detect([card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(11, 0)])).toBeNull();
    expect(detect([card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(11, 0)])).toBeNull();
    expect(detect([card(0, 0), card(6, 1), card(7, 2), card(8, 3), card(9, 0)])).toBeNull();
  });

  it('拒绝非法张数、重复牌和无效编码', () => {
    expect(detect([])).toBeNull();
    expect(detect([card(0, 0), card(0, 0)])).toBeNull();
    expect(detect([card(0, 0), card(1, 0), card(2, 0), card(3, 0), card(4, 0), card(5, 0)]))
      .toBeNull();
    expect(detect([card(-1, 0)])).toBeNull();
    expect(detect([card(13, 0)])).toBeNull();
    expect(detect([card(0, 4)])).toBeNull();
  });
});

describe('提示候选', () => {
  it('领出返回最小单张，首手优先方块4', () => {
    const hand = [card(3, 2), card(0, 0), card(1, 1)];

    expect(findSmallestWinningPlay(hand, null)).toEqual([card(0, 0)]);
    expect(findSmallestWinningPlay(hand, null, true)).toEqual([card(0, 0)]);
  });

  it('跟牌返回刚好能管住的最小牌型', () => {
    const hand = [card(2, 0), card(2, 1), card(3, 0), card(7, 0)];

    expect(findSmallestWinningPlay(hand, [card(1, 0)])).toEqual([card(2, 0)]);
    expect(findSmallestWinningPlay(hand, [card(0, 0), card(0, 1)]))
      .toEqual([card(2, 0), card(2, 1)]);
  });
});

describe('牌型大小比较', () => {
  it('单张仅允许同花色大点数或同点数大花色', () => {
    const diamondFour = [card(0, 0)];
    expect(beats(diamondFour, [card(0, 1)])).toBe(true);
    expect(beats(diamondFour, [card(0, 2)])).toBe(true);
    expect(beats(diamondFour, [card(1, 0)])).toBe(true);
    expect(beats(diamondFour, [card(1, 1)])).toBe(false);
    expect(beats(diamondFour, [card(0, 0)])).toBe(false);
  });

  it('对子先比点数，同点比最大花色', () => {
    expect(beats([card(0, 0), card(0, 1)], [card(1, 0), card(1, 1)])).toBe(true);
    expect(beats([card(0, 0), card(0, 1)], [card(0, 1), card(0, 2)])).toBe(true);
    expect(beats([card(0, 0), card(0, 2)], [card(0, 0), card(0, 1)])).toBe(false);
  });

  it('三张与四张只看点数，且不可跨牌型', () => {
    expect(beats([card(2, 0), card(2, 1), card(2, 2)], [card(3, 0), card(3, 1), card(3, 2)]))
      .toBe(true);
    expect(beats([card(2, 0), card(2, 1), card(2, 2)], [card(3, 0), card(3, 1), card(3, 2), card(3, 3)]))
      .toBe(false);
    expect(beats(
      [card(2, 0), card(2, 1), card(2, 2), card(2, 3)],
      [card(3, 0), card(3, 1), card(3, 2), card(3, 3)],
    )).toBe(true);
  });

  it('五张牌型按等级跨级比较', () => {
    const flush = [card(0, 0), card(2, 0), card(5, 0), card(9, 0), card(10, 0)];
    const straight = [card(0, 1), card(1, 2), card(2, 3), card(3, 0), card(4, 1)];
    const fullHouse = [card(0, 0), card(0, 1), card(0, 2), card(12, 0), card(12, 1)];
    const fourWithOne = [card(0, 0), card(0, 1), card(0, 2), card(0, 3), card(1, 0)];
    const straightFlush = [card(0, 3), card(1, 3), card(2, 3), card(3, 3), card(4, 3)];

    expect(beats(flush, straight)).toBe(true);
    expect(beats(straight, flush)).toBe(false);
    expect(beats(straight, fullHouse)).toBe(true);
    expect(beats(fullHouse, fourWithOne)).toBe(true);
    expect(beats(fourWithOne, straightFlush)).toBe(true);
    expect(beats(straightFlush, fourWithOne)).toBe(false);
  });

  it('同级五张牌型按最大牌比较，三带二和四带一按主牌点数比较', () => {
    expect(beats(
      [card(0, 1), card(1, 0), card(2, 0), card(3, 0), card(4, 0)],
      [card(1, 0), card(2, 0), card(3, 0), card(4, 0), card(5, 0)],
    )).toBe(true);
    expect(beats(
      [card(0, 0), card(0, 1), card(0, 2), card(12, 0), card(12, 1)],
      [card(1, 0), card(1, 1), card(1, 2), card(0, 0), card(0, 1)],
    )).toBe(true);
    expect(beats(
      [card(0, 0), card(0, 1), card(0, 2), card(0, 3), card(12, 0)],
      [card(1, 0), card(1, 1), card(1, 2), card(1, 3), card(0, 0)],
    )).toBe(true);
  });
});
