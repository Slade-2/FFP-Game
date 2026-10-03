import type { GameMode } from './game';
import {
  comparePlayStrength,
  detect,
  findAllWinningPlays,
  type Card,
} from './rules';

export interface BotCall {
  r: number;
  s: number;
}

export interface BotTeamReveal {
  callerSeat: number;
  teammateSeat: number;
  selfCall: boolean;
}

const SEATS = [0, 1, 2, 3] as const;
const TEAMMATE_SCORE = 60;
const ENEMY_SCORE = -60;
const STRAIGHT_WINDOW_FIRST = 0; // 4
const STRAIGHT_WINDOW_LAST = 6; // 从 10 起算的 5 连，最大到 A
const BIG_CARD_RANK = 10; // J / Q / K / A / 2 / 3
const LOW_TABLE_RANK = 6; // 10 及以下
const SELF_CALL_RANK_MIN = 2; // 6
const SELF_CALL_RANK_MAX = 6; // 10
const SAFE_CALL_RANK_MIN = 2; // 6
const SAFE_CALL_RANK_MAX = 5; // 9
const SUIT_SEATS = [0, 1, 2, 3] as const;

function copyCards(cards: Card[]): Card[] {
  return cards.map((card) => ({ ...card }));
}

function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => a.r - b.r || a.s - b.s);
}

function groupByRank(cards: Card[]): Map<number, Card[]> {
  const groups = new Map<number, Card[]>();
  for (const card of sortCards(cards)) {
    const group = groups.get(card.r);
    if (group) {
      group.push(card);
    } else {
      groups.set(card.r, [card]);
    }
  }
  return groups;
}

function pushUnique(candidates: Card[][], cards: Card[]): void {
  const key = cards.map((card) => `${card.r}:${card.s}`).sort().join(',');
  if (candidates.some((item) => item.map((card) => `${card.r}:${card.s}`).sort().join(',') === key)) {
    return;
  }
  candidates.push(copyCards(cards));
}

function enumerateLeadCandidates(hand: Card[]): Card[][] {
  const candidates: Card[][] = [];
  const byRank = groupByRank(hand);
  const ranks = [...byRank.keys()].sort((a, b) => a - b);

  for (const card of sortCards(hand)) {
    pushUnique(candidates, [card]);
  }

  for (const rank of ranks) {
    const group = byRank.get(rank) as Card[];
    if (group.length >= 2) {
      pushUnique(candidates, group.slice(0, 2));
    }
    if (group.length >= 3) {
      pushUnique(candidates, group.slice(0, 3));
    }
    if (group.length >= 4) {
      pushUnique(candidates, group.slice(0, 4));
    }
  }

  for (let start = STRAIGHT_WINDOW_FIRST; start <= STRAIGHT_WINDOW_LAST; start += 1) {
    const sequence: Card[] = [];
    for (let rank = start; rank < start + 5; rank += 1) {
      const card = byRank.get(rank)?.[0];
      if (!card) {
        sequence.length = 0;
        break;
      }
      sequence.push(card);
    }
    if (sequence.length === 5) {
      pushUnique(candidates, sequence);
    }
  }

  for (const suit of SUIT_SEATS) {
    const suited = sortCards(hand.filter((card) => card.s === suit));
    if (suited.length < 5) {
      continue;
    }
    pushUnique(candidates, suited.slice(0, 5));
    pushUnique(candidates, suited.slice(suited.length - 5));
  }

  for (const suit of SUIT_SEATS) {
    for (let start = STRAIGHT_WINDOW_FIRST; start <= STRAIGHT_WINDOW_LAST; start += 1) {
      const sequence: Card[] = [];
      for (let rank = start; rank < start + 5; rank += 1) {
        const card = byRank.get(rank)?.find((item) => item.s === suit);
        if (!card) {
          sequence.length = 0;
          break;
        }
        sequence.push(card);
      }
      if (sequence.length === 5) {
        pushUnique(candidates, sequence);
      }
    }
  }

  const tripleRank = ranks.find((rank) => (byRank.get(rank) as Card[]).length >= 3);
  if (tripleRank !== undefined) {
    const pairRank = ranks.find(
      (rank) => rank !== tripleRank && (byRank.get(rank) as Card[]).length >= 2,
    );
    if (pairRank !== undefined) {
      pushUnique(candidates, [
        ...(byRank.get(tripleRank) as Card[]).slice(0, 3),
        ...(byRank.get(pairRank) as Card[]).slice(0, 2),
      ]);
    }
  }

  const quadRank = ranks.find((rank) => (byRank.get(rank) as Card[]).length >= 4);
  if (quadRank !== undefined) {
    const kicker = sortCards(hand).find((card) => card.r !== quadRank);
    if (kicker) {
      pushUnique(candidates, [...(byRank.get(quadRank) as Card[]).slice(0, 4), kicker]);
    }
  }

  return candidates;
}

function isSmallLead(cards: Card[]): boolean {
  const play = detect(cards);
  if (!play) {
    return false;
  }
  if (play.type === 'SINGLE' || play.type === 'PAIR') {
    return play.key.r <= 7;
  }
  return false;
}

function pickLowestStrength(candidates: Card[][]): Card[] {
  return [...candidates].sort(comparePlayStrength)[0];
}

function pickBestLead(candidates: Card[][]): Card[] {
  return [...candidates].sort((left, right) => (
    right.length - left.length || comparePlayStrength(left, right)
  ))[0];
}

/**
 * 每个机器人座位每局一个大脑实例，只消费公开事件与自己的手牌。
 * 大脑不持有 GameEngine 引用，因此不可能读到他人手牌或内部队友字段。
 */
export class BotBrain {
  readonly seat: number;
  readonly mode: GameMode;

  private readonly relations = new Map<number, number>();
  private callerSeat: number | null = null;
  private calledCard: Card | null = null;
  private table: { seat: number; cards: Card[] } | null = null;
  private playCount = 0;

  constructor(seat: number, mode: GameMode) {
    this.seat = seat;
    this.mode = mode;
    for (const other of SEATS) {
      if (other !== seat) {
        this.relations.set(other, mode === 'dahua' ? -100 : 0);
      }
    }
  }

  onCallResult(callerSeat: number, r: number, s: number): void {
    this.callerSeat = callerSeat;
    this.calledCard = { r, s };
    for (const other of SEATS) {
      if (other === this.seat) {
        continue;
      }
      if (this.mode === 'dahua') {
        this.relations.set(other, -100);
      } else if (callerSeat === this.seat) {
        this.relations.set(other, 0);
      } else {
        this.relations.set(other, other === callerSeat ? -100 : 0);
      }
    }
  }

  onTeamReveal(reveal: BotTeamReveal): void {
    if (this.mode !== 'dapengyou') {
      return;
    }
    if (reveal.selfCall) {
      if (reveal.callerSeat === this.seat) {
        for (const other of SEATS) {
          if (other !== this.seat) {
            this.relations.set(other, -100);
          }
        }
      }
      return;
    }
    if (reveal.teammateSeat !== this.seat) {
      return;
    }
    for (const other of SEATS) {
      if (other === this.seat) {
        continue;
      }
      if (other === reveal.callerSeat) {
        this.relations.set(other, 100);
      } else {
        this.relations.set(other, -100);
      }
    }
  }

  onPlay(
    seat: number,
    cards: Card[],
    remaining: number,
    cardCounts: number[],
    wasLead: boolean,
  ): void {
    if (this.calledCard && seat !== this.seat) {
      const playedCalledCard = cards.some(
        (card) => card.r === this.calledCard?.r && card.s === this.calledCard?.s,
      );
      if (playedCalledCard) {
        this.relations.set(seat, this.callerSeat === this.seat ? 100 : -100);
      }
    }

    if (seat !== this.seat) {
      const previous = wasLead ? null : this.table;

      if (previous && this.isTeammate(previous.seat) && remaining !== 0) {
        this.adjustRelation(seat, -15, ENEMY_SCORE);
      }

      if (wasLead && isSmallLead(cards) && this.seatsWithFewCards(cardCounts, 'teammate').length > 0) {
        this.adjustRelation(seat, 15, TEAMMATE_SCORE);
      }

      const previousCount = previous ? cardCounts[previous.seat] ?? 0 : 0;
      if (previous && this.isEnemy(previous.seat) && previousCount > 0 && previousCount <= 2) {
        this.adjustRelation(seat, 10, TEAMMATE_SCORE);
      }
    }

    this.table = { seat, cards: copyCards(cards) };
    this.playCount += 1;
  }

  onRoundReset(): void {
    this.table = null;
  }

  relationWith(seat: number): number {
    return this.relations.get(seat) ?? 0;
  }

  chooseCall(hand: Card[]): BotCall {
    if (this.mode !== 'dapengyou') {
      return this.selfCallTarget(hand) ?? { r: 0, s: 0 };
    }

    const bigCards = hand.filter((card) => card.r >= BIG_CARD_RANK).length;
    const combos = this.countCombos(hand);
    const wantsSelfCall = bigCards >= 5 || (combos >= 2 && bigCards >= 3);
    if (wantsSelfCall) {
      const target = this.selfCallTarget(hand);
      if (target) {
        return target;
      }
    }

    return this.safeCall(hand);
  }

  chooseLead(hand: Card[], cardCounts: number[]): Card[] | null {
    const sortedHand = sortCards(hand);
    if (sortedHand.length === 0) {
      return null;
    }

    const candidates = enumerateLeadCandidates(hand);
    const diamondFour = sortedHand.find((card) => card.r === 0 && card.s === 0);

    if (this.playCount === 0 && diamondFour) {
      const withDiamondFour = candidates.filter(
        (cards) => cards.some((card) => card.r === 0 && card.s === 0),
      );
      if (withDiamondFour.length === 0) {
        return [{ ...diamondFour }];
      }
      return pickBestLead(withDiamondFour);
    }

    const finishers = candidates.filter((cards) => cards.length === sortedHand.length);
    if (finishers.length > 0) {
      return pickLowestStrength(finishers);
    }

    if (this.seatsWithFewCards(cardCounts, 'teammate').length > 0) {
      return [{ ...sortedHand[0] }];
    }

    if (this.seatsWithFewCards(cardCounts, 'enemy').length > 0) {
      const pairs = candidates.filter((cards) => cards.length === 2 && detect(cards)?.type === 'PAIR');
      if (pairs.length > 0) {
        return [...pairs].sort((left, right) => comparePlayStrength(right, left))[0];
      }
      return [{ ...sortedHand[sortedHand.length - 1] }];
    }

    const combinations = candidates.filter((cards) => (
      cards.length > 1 && detect(cards)?.type !== 'STRAIGHT_FLUSH'
    ));
    if (combinations.length > 0) {
      return pickBestLead(combinations);
    }

    return [{ ...sortedHand[0] }];
  }

  chooseResponse(hand: Card[], table: Card[], cardCounts: number[]): Card[] | null {
    const tablePlay = detect(table);
    if (!tablePlay) {
      return null;
    }

    const winners = findAllWinningPlays(hand, table);
    if (winners.length === 0) {
      return null;
    }

    const finishers = winners.filter((cards) => cards.length === hand.length);
    if (finishers.length > 0) {
      return pickLowestStrength(finishers);
    }

    const tableSeat = this.table?.seat;
    if (tableSeat !== undefined && tableSeat !== this.seat && this.isTeammate(tableSeat)) {
      return null;
    }

    if (this.seatsWithFewCards(cardCounts, 'enemy').length > 0) {
      return pickLowestStrength(winners);
    }

    return [...winners].sort((left, right) => {
      const costDiff = this.responseCost(left, hand, tablePlay)
        - this.responseCost(right, hand, tablePlay);
      if (costDiff !== 0) {
        return costDiff;
      }
      return comparePlayStrength(left, right);
    })[0];
  }

  private countCombos(hand: Card[]): number {
    let combos = 0;
    for (const cards of enumerateLeadCandidates(hand)) {
      const play = detect(cards);
      if (!play) {
        continue;
      }
      if (cards.length === 5) {
        combos += 1;
      } else if (play.type === 'FOUR') {
        combos += 1;
      }
    }
    return combos;
  }

  private selfCallTarget(hand: Card[]): BotCall | null {
    const medium = sortCards(hand).filter(
      (card) => card.r >= SELF_CALL_RANK_MIN && card.r <= SELF_CALL_RANK_MAX,
    );
    const fallback = sortCards(hand).filter((card) => card.r <= SELF_CALL_RANK_MAX);
    const target = medium[0] ?? fallback[0];
    return target ? { r: target.r, s: target.s } : null;
  }

  private safeCall(hand: Card[]): BotCall {
    const suitCounts = SUIT_SEATS.map(
      (suit) => hand.filter((card) => card.s === suit).length,
    );
    const candidates = [];
    for (let rank = SAFE_CALL_RANK_MIN; rank <= SAFE_CALL_RANK_MAX; rank += 1) {
      const missingSuits = SUIT_SEATS.filter(
        (suit) => !hand.some((card) => card.r === rank && card.s === suit),
      );
      candidates.push({
        rank,
        held: hand.filter((card) => card.r === rank).length,
        missingSuits,
      });
    }
    candidates.sort((left, right) => left.held - right.held || left.rank - right.rank);

    const best = candidates.find((item) => item.missingSuits.length > 0);
    if (best) {
      const suit = [...best.missingSuits].sort((left, right) => (
        suitCounts[left] - suitCounts[right] || left - right
      ))[0];
      return { r: best.rank, s: suit };
    }

    const shortestSuit = [...SUIT_SEATS].sort((left, right) => (
      suitCounts[left] - suitCounts[right] || left - right
    ))[0];
    return { r: SAFE_CALL_RANK_MIN, s: shortestSuit };
  }

  private responseCost(cards: Card[], hand: Card[], tablePlay: ReturnType<typeof detect>): number {
    const play = detect(cards);
    if (!play || !tablePlay) {
      return 0;
    }

    let cost = 0;
    if (play.type === 'SINGLE') {
      if (this.breaksStructure(hand, cards[0])) {
        cost += 2;
      }
    } else if (play.type === 'PAIR') {
      const rankCount = hand.filter((card) => card.r === cards[0].r).length;
      if (rankCount >= 3) {
        cost += 2;
      }
    }

    if (play.key.r >= BIG_CARD_RANK && tablePlay.key.r <= LOW_TABLE_RANK) {
      cost += 3;
    }
    return cost;
  }

  private breaksStructure(hand: Card[], card: Card): boolean {
    if (hand.filter((item) => item.r === card.r).length >= 2) {
      return true;
    }
    const ranks = new Set(hand.map((item) => item.r));
    for (let start = STRAIGHT_WINDOW_FIRST; start <= STRAIGHT_WINDOW_LAST; start += 1) {
      if (card.r < start || card.r > start + 4) {
        continue;
      }
      let complete = true;
      for (let rank = start; rank < start + 5; rank += 1) {
        if (!ranks.has(rank)) {
          complete = false;
          break;
        }
      }
      if (complete) {
        return true;
      }
    }
    return hand.filter((item) => item.s === card.s).length >= 5;
  }

  private seatsWithFewCards(cardCounts: number[], kind: 'teammate' | 'enemy'): number[] {
    const limit = kind === 'teammate' ? TEAMMATE_SCORE : ENEMY_SCORE;
    return SEATS.filter((seat) => {
      if (seat === this.seat) {
        return false;
      }
      const score = this.relations.get(seat) ?? 0;
      const matches = kind === 'teammate' ? score >= limit : score <= limit;
      const count = cardCounts[seat] ?? 0;
      return matches && count > 0 && count <= 2;
    });
  }

  private isTeammate(seat: number): boolean {
    return (this.relations.get(seat) ?? 0) >= TEAMMATE_SCORE;
  }

  private isEnemy(seat: number): boolean {
    return (this.relations.get(seat) ?? 0) <= ENEMY_SCORE;
  }

  private adjustRelation(seat: number, delta: number, boundary: number): void {
    const current = this.relations.get(seat) ?? 0;
    if (delta > 0 && current >= boundary) {
      return;
    }
    if (delta < 0 && current <= boundary) {
      return;
    }
    const next = delta > 0
      ? Math.min(boundary, current + delta)
      : Math.max(boundary, current + delta);
    this.relations.set(seat, next);
  }
}
