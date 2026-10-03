import type { Card } from './types';

export const RANK_LABELS = ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '3'];
export const SUIT_LABELS = ['♦', '♣', '♥', '♠'];
export const SUIT_NAMES = ['方块', '梅花', '红桃', '黑桃'];
export const CARD_BACK_FILE = '/cards/blueBack.svg';

const RANK_FILE_NAMES = [
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'Jack',
  'Queen',
  'King',
  'Ace',
  '2',
  '3',
];
const SUIT_FILE_NAMES = ['diamond', 'club', 'heart', 'spade'];

export function cardToFile(rank: number, suit: number): string {
  return `/cards/${SUIT_FILE_NAMES[suit]}${RANK_FILE_NAMES[rank]}.svg`;
}

export function isRed(card: Card): boolean {
  return card.s === 0 || card.s === 2;
}

export function cardName(card: Card): string {
  return `${SUIT_NAMES[card.s]}${RANK_LABELS[card.r]}`;
}

export function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => b.r - a.r || b.s - a.s);
}
