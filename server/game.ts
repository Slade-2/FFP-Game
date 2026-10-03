import {
  beats,
  detect,
  findSmallestWinningPlay,
  type Card,
  type Play,
  type PlayType,
} from './rules';
import { scoreDahua, scoreDapengyou, scoreSolo } from './scoring';

export type GameMode = 'dahua' | 'dapengyou';
export type GamePhase = 'calling' | 'playing' | 'over';

export interface GamePlayer {
  seat: number;
  nickname: string;
}

export interface TablePlay {
  seat: number;
  cards: Card[];
  type: PlayType;
}

export interface TableAction {
  seat: number;
  kind: 'play' | 'pass';
  cards: Card[];
  type: PlayType | null;
}

export interface GameResult {
  rankings: number[];
  scoreChanges: number[];
}

export type GameEmitter = (
  event: string,
  payload: Record<string, unknown>,
  seat?: number,
) => void;

interface GameEngineOptions {
  rng?: () => number;
  emit?: GameEmitter;
}

const SUIT_COUNT = 4;
const RANK_COUNT = 13;
const HAND_SIZE = 13;

export class GameEngine {
  readonly mode: GameMode;

  phase: GamePhase = 'playing';
  currentSeat = 0;
  currentTable: TablePlay | null = null;
  isFirstPlay = true;
  result: GameResult | null = null;

  private readonly players: GamePlayer[];
  private readonly rng: () => number;
  private readonly emitEvent: GameEmitter;
  private readonly hands: Card[][] = [[], [], [], []];
  private readonly playing = new Set([0, 1, 2, 3]);
  private readonly rankings: number[] = [];
  private readonly tableActions: Array<TableAction | null> = [null, null, null, null];
  private roundPlays: TablePlay[] = [];
  private passCount = 0;
  private lastPlaySeat: number | null = null;
  private callerSeat: number | null = null;
  private teammateSeat: number | null = null;
  private selfCall = false;

  constructor(
    players: GamePlayer[],
    mode: GameMode,
    options: GameEngineOptions = {},
  ) {
    if (players.length !== 4) {
      throw new Error('对局必须正好四人');
    }
    const seats = players.map((player) => player.seat).sort((a, b) => a - b);
    if (seats.join(',') !== '0,1,2,3') {
      throw new Error('座位必须为 0~3');
    }
    this.players = players;
    this.mode = mode;
    this.rng = options.rng ?? Math.random;
    this.emitEvent = options.emit ?? (() => undefined);
  }

  start(): void {
    const deck = this.createDeck();
    this.shuffle(deck);
    for (let seat = 0; seat < 4; seat += 1) {
      this.hands[seat] = deck
        .slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE)
        .sort((a, b) => a.r - b.r || a.s - b.s);
      this.tableActions[seat] = null;
    }

    this.currentSeat = this.findDiamondFourHolder();
    this.emit('game:start', { mode: this.mode });
    for (let seat = 0; seat < 4; seat += 1) {
      this.emit('game:deal', { cards: this.getHand(seat) }, seat);
    }

    if (this.mode === 'dapengyou') {
      this.phase = 'calling';
      this.emit('game:call-request', {}, this.currentSeat);
      return;
    }

    this.emitTurn();
  }

  getHand(seat: number): Card[] {
    return this.hands[seat].map((card) => ({ ...card }));
  }

  getRankings(): number[] {
    return [...this.rankings];
  }

  getCardCounts(): number[] {
    return this.hands.map((hand) => hand.length);
  }

  canRespond(seat: number): boolean {
    this.assertCanAct(seat);
    if (!this.currentTable) {
      return true;
    }
    return findSmallestWinningPlay(
      this.hands[seat],
      this.currentTable.cards,
      this.isFirstPlay,
    ) !== null;
  }

  play(seat: number, cards: Card[]): void {
    this.assertCanAct(seat);
    if (!Array.isArray(cards) || cards.length === 0) {
      throw new Error('请选择要出的牌');
    }
    if (new Set(cards.map((card) => `${card.r}:${card.s}`)).size !== cards.length) {
      throw new Error('不能重复选择同一张牌');
    }
    this.assertOwnsCards(seat, cards);

    const play = detect(cards);
    if (!play) {
      throw new Error('不是合法牌型');
    }

    if (!this.currentTable) {
      if (this.isFirstPlay && !cards.some((card) => card.r === 0 && card.s === 0)) {
        throw new Error('首手必须包含方块4');
      }
    } else if (!beats(this.currentTable.cards, cards)) {
      throw new Error('所出牌型无法管住当前桌牌');
    }

    this.removeFromHand(seat, cards);
    this.currentTable = { seat, cards: cards.map((card) => ({ ...card })), type: play.type };
    this.roundPlays.push(this.currentTable);
    this.tableActions[seat] = {
      seat,
      kind: 'play',
      cards: cards.map((card) => ({ ...card })),
      type: play.type,
    };
    this.lastPlaySeat = seat;
    this.passCount = 0;
    this.isFirstPlay = false;

    this.emit('game:play', {
      seat,
      cards: cards.map((card) => ({ ...card })),
      type: play.type,
      remaining: this.hands[seat].length,
    });

    if (this.hands[seat].length === 0) {
      this.finishSeat(seat);
      if (this.phase === 'over') {
        return;
      }
    }

    this.currentSeat = this.nextActiveSeat(seat);
    this.emitTurn();
  }

  pass(seat: number): void {
    this.assertCanAct(seat);
    if (!this.currentTable) {
      throw new Error('领出时不能 pass');
    }

    this.passCount += 1;
    this.tableActions[seat] = {
      seat,
      kind: 'pass',
      cards: [],
      type: null,
    };
    this.emit('game:pass', { seat });

    if (this.lastPlaySeat === null) {
      throw new Error('对局状态异常：缺少最后出牌者');
    }

    const requiredPasses = this.playing.has(this.lastPlaySeat)
      ? this.playing.size - 1
      : this.playing.size;
    if (this.passCount === requiredPasses) {
      if (!this.playing.has(this.lastPlaySeat)) {
        this.tableActions[this.lastPlaySeat] = null;
      }
      this.currentSeat = this.playing.has(this.lastPlaySeat)
        ? this.lastPlaySeat
        : this.nextActiveSeat(this.lastPlaySeat);
      this.currentTable = null;
      this.roundPlays = [];
      this.passCount = 0;
      this.emit('game:round-reset', { seat: this.currentSeat });
      this.emitTurn();
      return;
    }

    this.currentSeat = this.nextActiveSeat(seat);
    this.emitTurn();
  }

  call(seat: number, rank: number, suit: number): void {
    if (this.mode !== 'dapengyou') {
      throw new Error('当前玩法无需叫牌');
    }
    if (this.phase !== 'calling') {
      throw new Error('当前不在叫牌阶段');
    }
    if (seat !== this.currentSeat) {
      throw new Error('未轮到你叫牌');
    }
    if (!Number.isInteger(rank) || rank < 0 || rank > 6) {
      throw new Error('只能叫 4~10 的点数');
    }
    if (!Number.isInteger(suit) || suit < 0 || suit > 3) {
      throw new Error('花色无效');
    }

    const card: Card = { r: rank, s: suit };
    const holder = this.hands.findIndex((hand) => (
      hand.some((item) => item.r === card.r && item.s === card.s)
    ));
    if (holder < 0) {
      throw new Error('叫牌目标不存在');
    }

    this.callerSeat = seat;
    this.teammateSeat = holder;
    this.selfCall = holder === seat;
    this.phase = 'playing';
    this.emit('game:call-result', { callerSeat: seat, r: rank, s: suit });
    this.emit('game:team-reveal', {
      callerSeat: seat,
      teammateSeat: holder,
      selfCall: this.selfCall,
    }, this.selfCall ? seat : holder);
    this.emitTurn();
  }

  private assertCanAct(seat: number): void {
    if (this.phase !== 'playing') {
      throw new Error('对局已结束');
    }
    if (seat !== this.currentSeat) {
      throw new Error('未轮到你出牌');
    }
    if (!this.playing.has(seat)) {
      throw new Error('你已经出完牌');
    }
  }

  private createDeck(): Card[] {
    const deck: Card[] = [];
    for (let rank = 0; rank < RANK_COUNT; rank += 1) {
      for (let suit = 0; suit < SUIT_COUNT; suit += 1) {
        deck.push({ r: rank, s: suit });
      }
    }
    return deck;
  }

  private shuffle(deck: Card[]): void {
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const target = Math.floor(this.rng() * (index + 1));
      [deck[index], deck[target]] = [deck[target], deck[index]];
    }
  }

  private findDiamondFourHolder(): number {
    const holder = this.hands.findIndex((hand) => (
      hand.some((card) => card.r === 0 && card.s === 0)
    ));
    if (holder < 0) {
      throw new Error('发牌异常：找不到方块4');
    }
    return holder;
  }

  private removeFromHand(seat: number, cards: Card[]): void {
    for (const card of cards) {
      const index = this.hands[seat].findIndex((item) => item.r === card.r && item.s === card.s);
      if (index < 0) {
        throw new Error('不能打出不属于自己的牌');
      }
      this.hands[seat].splice(index, 1);
    }
  }

  private assertOwnsCards(seat: number, cards: Card[]): void {
    for (const card of cards) {
      if (!this.hands[seat].some((item) => item.r === card.r && item.s === card.s)) {
        throw new Error('不能打出不属于自己的牌');
      }
    }
  }

  private finishSeat(seat: number): void {
    this.playing.delete(seat);
    this.rankings.push(seat);
    this.emit('game:rank', {
      seat,
      nickname: this.playerName(seat),
      rank: this.rankings.length,
    });

    if (this.mode === 'dapengyou' && this.selfCall) {
      if (this.callerSeat === null) {
        throw new Error('对局状态异常：缺少叫牌人');
      }
      const callerWon = seat === this.callerSeat;
      const rankings = this.buildSoloResultRankings(seat, this.callerSeat);
      this.complete(rankings, scoreSolo(this.callerSeat, callerWon));
      return;
    }

    if (this.rankings.length === 3) {
      const lastSeat = [...this.playing][0];
      if (lastSeat !== undefined) {
        this.rankings.push(lastSeat);
      }
      if (this.mode === 'dapengyou') {
        if (this.callerSeat === null || this.teammateSeat === null) {
          throw new Error('对局状态异常：缺少队伍信息');
        }
        this.complete(
          [...this.rankings],
          scoreDapengyou(this.rankings, this.callerSeat, this.teammateSeat),
        );
        return;
      }
      this.complete([...this.rankings], scoreDahua(this.rankings));
    }
  }

  private complete(rankings: number[], scoreChanges: number[]): void {
    this.phase = 'over';
    this.currentTable = null;
    this.result = {
      rankings,
      scoreChanges,
    };
    this.emit('game:over', {
      rankings,
      scoreChanges,
    });
  }

  private buildSoloResultRankings(winnerSeat: number, callerSeat: number): number[] {
    const rankings = [winnerSeat];
    if (winnerSeat !== callerSeat) {
      rankings.push(callerSeat);
    }
    for (const seat of [0, 1, 2, 3]) {
      if (!rankings.includes(seat)) {
        rankings.push(seat);
      }
    }
    return rankings;
  }

  private nextActiveSeat(from: number): number {
    for (let offset = 1; offset <= 4; offset += 1) {
      const seat = (from + offset) % 4;
      if (this.playing.has(seat)) {
        return seat;
      }
    }
    throw new Error('对局状态异常：没有可行动玩家');
  }

  private emitTurn(): void {
    this.tableActions[this.currentSeat] = null;
    this.emit('game:turn', {
      seat: this.currentSeat,
      table: this.currentTable,
      roundPlays: this.roundPlays,
      tableActions: this.tableActions,
      cardCounts: this.getCardCounts(),
      isLead: this.currentTable === null,
      mustIncludeDiamondFour: this.isFirstPlay,
    });
  }

  private playerName(seat: number): string {
    return this.players.find((player) => player.seat === seat)?.nickname ?? `座位${seat + 1}`;
  }

  private emit(event: string, payload: Record<string, unknown>, seat?: number): void {
    this.emitEvent(event, payload, seat);
  }
}
