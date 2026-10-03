export type GameMode = 'dahua' | 'dapengyou';

export interface Card {
  r: number;
  s: number;
}

export interface PublicPlayer {
  seat: number;
  nickname: string;
  ready: boolean;
  connected: boolean;
  score: number;
  isBot?: boolean;
}

export interface RoomState {
  roomId: string;
  mode: GameMode;
  kind: 'normal' | 'test';
  testing?: boolean;
  hostSeat: number;
  phase: 'waiting' | 'calling' | 'playing' | 'over';
  players: PublicPlayer[];
}

export interface TablePlay {
  seat: number;
  cards: Card[];
  type: string;
}

export interface TableAction {
  seat: number;
  kind: 'play' | 'pass';
  cards: Card[];
  type: string | null;
}

export interface ScoreTotal {
  seat: number;
  nickname: string;
  score: number;
}

export interface GameOver {
  rankings: number[];
  scoreChanges?: number[];
  totals?: ScoreTotal[];
  yourSeat?: number;
  yourScoreChange?: number;
  yourTotal?: number;
}

export interface LeaderboardPlayer {
  token: string;
  nickname: string;
  score: number;
}

export interface RematchState {
  votes: number[];
  count: number;
  total: number;
  expiresAt: number | null;
}

export interface MatchHistoryPlayer {
  seat: number;
  nickname: string;
  rank: number;
  scoreChange: number;
}

export interface MatchHistory {
  id: number;
  roomId: string;
  mode: GameMode;
  createdAt: string;
  rank: number;
  scoreChange: number;
  rankings: number[];
  scoreChanges: number[];
  players: MatchHistoryPlayer[];
}
