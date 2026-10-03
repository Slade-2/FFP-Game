export interface Card {
  r: number;
  s: number;
}

export type PlayType =
  | 'SINGLE'
  | 'PAIR'
  | 'TRIPLE'
  | 'FULL_HOUSE'
  | 'FOUR'
  | 'FOUR_WITH_ONE'
  | 'STRAIGHT'
  | 'FLUSH'
  | 'STRAIGHT_FLUSH';

export interface Play {
  type: PlayType;
  cards: Card[];
  key: {
    r: number;
    s?: number;
    maxSuit?: number;
  };
}

const TYPE_RANK: Partial<Record<PlayType, number>> = {
  FLUSH: 0,
  STRAIGHT: 1,
  FULL_HOUSE: 2,
  FOUR_WITH_ONE: 3,
  STRAIGHT_FLUSH: 4,
};

const LEAD_TYPE_RANK: Record<PlayType, number> = {
  SINGLE: 0,
  PAIR: 1,
  TRIPLE: 2,
  FOUR: 3,
  FLUSH: 0,
  STRAIGHT: 1,
  FULL_HOUSE: 2,
  FOUR_WITH_ONE: 3,
  STRAIGHT_FLUSH: 4,
};

function isCard(card: Card): boolean {
  return Number.isInteger(card.r)
    && Number.isInteger(card.s)
    && card.r >= 0
    && card.r <= 12
    && card.s >= 0
    && card.s <= 3;
}

function hasDuplicateCards(cards: Card[]): boolean {
  return new Set(cards.map((card) => `${card.r}:${card.s}`)).size !== cards.length;
}

function maxCard(cards: Card[]): Card {
  return [...cards].sort((a, b) => b.r - a.r || b.s - a.s)[0];
}

function isStraight(cards: Card[]): boolean {
  const ranks = [...new Set(cards.map((card) => card.r))].sort((a, b) => a - b);
  return ranks.length === 5
    && ranks[0] >= 0
    && ranks[4] <= 10
    && ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1);
}

function countRanks(cards: Card[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const card of cards) {
    counts.set(card.r, (counts.get(card.r) ?? 0) + 1);
  }
  return counts;
}

function rankWithCount(cards: Card[], count: number): number | undefined {
  for (const [rank, rankCount] of countRanks(cards)) {
    if (rankCount === count) {
      return rank;
    }
  }
  return undefined;
}

export function detect(cards: Card[]): Play | null {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > 5) {
    return null;
  }
  if (!cards.every(isCard) || hasDuplicateCards(cards)) {
    return null;
  }

  const [first] = cards;

  if (cards.length === 1) {
    return { type: 'SINGLE', cards: [...cards], key: { r: first.r, s: first.s } };
  }

  const counts = countRanks(cards);

  if (cards.length === 2 && counts.size === 1) {
    return {
      type: 'PAIR',
      cards: [...cards],
      key: { r: first.r, maxSuit: Math.max(...cards.map((card) => card.s)) },
    };
  }

  if (cards.length === 3 && counts.size === 1) {
    return { type: 'TRIPLE', cards: [...cards], key: { r: first.r } };
  }

  if (cards.length === 4 && counts.size === 1) {
    return { type: 'FOUR', cards: [...cards], key: { r: first.r } };
  }

  if (cards.length === 5) {
    const rankCounts = [...counts.values()].sort((a, b) => a - b);
    const isFullHouse = rankCounts.length === 2 && rankCounts[0] === 2 && rankCounts[1] === 3;
    if (isFullHouse) {
      const tripleRank = rankWithCount(cards, 3) as number;
      return { type: 'FULL_HOUSE', cards: [...cards], key: { r: tripleRank } };
    }

    const isFourWithOne = rankCounts.length === 2 && rankCounts[0] === 1 && rankCounts[1] === 4;
    if (isFourWithOne) {
      const fourRank = rankWithCount(cards, 4) as number;
      return { type: 'FOUR_WITH_ONE', cards: [...cards], key: { r: fourRank } };
    }

    const sameSuit = cards.every((card) => card.s === first.s);
    const straight = isStraight(cards);
    const high = maxCard(cards);

    if (sameSuit && straight) {
      return {
        type: 'STRAIGHT_FLUSH',
        cards: [...cards],
        key: { r: high.r, s: high.s },
      };
    }

    if (straight) {
      return { type: 'STRAIGHT', cards: [...cards], key: { r: high.r, s: high.s } };
    }

    if (sameSuit) {
      return { type: 'FLUSH', cards: [...cards], key: { r: high.r, s: high.s } };
    }
  }

  return null;
}

function compareKeys(
  previous: Play,
  next: Play,
  mode: 'single' | 'pair' | 'rank' | 'five',
): boolean {
  if (mode === 'single') {
    return (previous.key.s === next.key.s && next.key.r > previous.key.r)
      || (previous.key.r === next.key.r && (next.key.s as number) > (previous.key.s as number));
  }

  if (mode === 'pair') {
    return next.key.r > previous.key.r
      || (next.key.r === previous.key.r
        && (next.key.maxSuit as number) > (previous.key.maxSuit as number));
  }

  if (mode === 'rank') {
    return next.key.r > previous.key.r;
  }

  return next.key.r > previous.key.r
    || (next.key.r === previous.key.r && (next.key.s ?? -1) > (previous.key.s ?? -1));
}

export function beats(previousCards: Card[], nextCards: Card[]): boolean {
  const previous = detect(previousCards);
  const next = detect(nextCards);
  if (!previous || !next) {
    return false;
  }

  if (previous.type === 'SINGLE' && next.type === 'SINGLE') {
    return compareKeys(previous, next, 'single');
  }

  if (previous.type === 'PAIR' && next.type === 'PAIR') {
    return compareKeys(previous, next, 'pair');
  }

  if (
    previous.type === next.type
    && (previous.type === 'TRIPLE' || previous.type === 'FOUR')
  ) {
    return compareKeys(previous, next, 'rank');
  }

  const previousRank = TYPE_RANK[previous.type];
  const nextRank = TYPE_RANK[next.type];
  if (previousRank === undefined || nextRank === undefined) {
    return false;
  }

  if (previousRank !== nextRank) {
    return nextRank > previousRank;
  }

  if (previous.type === 'FULL_HOUSE' || previous.type === 'FOUR_WITH_ONE') {
    return compareKeys(previous, next, 'rank');
  }

  return compareKeys(previous, next, 'five');
}

export function findSmallestWinningPlay(
  hand: Card[],
  tableCards: Card[] | null,
  mustIncludeDiamondFour = false,
): Card[] | null {
  const sortedHand = [...hand].sort((a, b) => a.r - b.r || a.s - b.s);

  if (!tableCards) {
    if (mustIncludeDiamondFour) {
      const diamondFour = sortedHand.find((card) => card.r === 0 && card.s === 0);
      return diamondFour ? [{ ...diamondFour }] : null;
    }
    return sortedHand[0] ? [{ ...sortedHand[0] }] : null;
  }

  if (!detect(tableCards)) {
    return null;
  }

  const candidates: Card[][] = [];
  const picked: Card[] = [];
  const collect = (start: number, targetSize: number): void => {
    if (picked.length === targetSize) {
      if (beats(tableCards, picked)) {
        candidates.push(picked.map((card) => ({ ...card })));
      }
      return;
    }
    for (let index = start; index < sortedHand.length; index += 1) {
      picked.push(sortedHand[index]);
      collect(index + 1, targetSize);
      picked.pop();
    }
  };

  for (let size = 1; size <= Math.min(5, sortedHand.length); size += 1) {
    collect(0, size);
  }

  candidates.sort((left, right) => {
    const leftPlay = detect(left) as Play;
    const rightPlay = detect(right) as Play;
    const leftKey = [
      LEAD_TYPE_RANK[leftPlay.type],
      leftPlay.cards.length,
      leftPlay.key.r,
      leftPlay.key.s ?? leftPlay.key.maxSuit ?? -1,
    ];
    const rightKey = [
      LEAD_TYPE_RANK[rightPlay.type],
      rightPlay.cards.length,
      rightPlay.key.r,
      rightPlay.key.s ?? rightPlay.key.maxSuit ?? -1,
    ];
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] !== rightKey[index]) {
        return leftKey[index] - rightKey[index];
      }
    }
    return 0;
  });

  return candidates[0] ?? null;
}
