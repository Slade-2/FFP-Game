import { describe, expect, it } from 'vitest';
import { scoreDahua, scoreDapengyou, scoreSolo, type SeatOrder } from '../server/scoring';

describe('打花结算', () => {
  it('按第1至第4名返回 +4 / +2 / -2 / -4', () => {
    const order: SeatOrder = [2, 0, 3, 1];
    expect(scoreDahua(order)).toEqual([2, -4, 4, -2]);
  });
});

describe('打朋友 2v2 结算', () => {
  it('覆盖六种名次组合', () => {
    expect(scoreDapengyou([0, 1, 2, 3], 0, 1)).toEqual([4, 4, -4, -4]);
    expect(scoreDapengyou([0, 1, 2, 3], 0, 2)).toEqual([2, -2, 2, -2]);
    expect(scoreDapengyou([0, 1, 2, 3], 0, 3)).toEqual([0, 0, 0, 0]);
    expect(scoreDapengyou([2, 0, 1, 3], 0, 1)).toEqual([0, 0, 0, 0]);
    expect(scoreDapengyou([1, 2, 3, 0], 0, 2)).toEqual([-2, 2, -2, 2]);
    expect(scoreDapengyou([2, 3, 0, 1], 0, 1)).toEqual([-4, -4, 4, 4]);
  });
});

describe('打朋友 1v3 结算', () => {
  it('叫牌人先出完则 1v3 胜利', () => {
    expect(scoreSolo(0, true)).toEqual([12, -4, -4, -4]);
  });

  it('任一对手先出完则叫牌人落败', () => {
    expect(scoreSolo(0, false)).toEqual([-12, 4, 4, 4]);
    expect(scoreSolo(2, false)).toEqual([4, 4, -12, 4]);
  });
});
