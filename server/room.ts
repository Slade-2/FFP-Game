import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { BotBrain } from './bot';
import type { GameDatabase } from './db';
import { GameEngine, type GameMode, type GamePlayer } from './game';
import { findSmallestWinningPlay, type Card } from './rules';

export type RoomKind = 'normal' | 'test';

interface RoomMember {
  seat: number;
  nickname: string;
  token: string;
  socketId: string;
  ready: boolean;
  connected: boolean;
  score: number;
  isBot: boolean;
}

interface CreateRoomResult {
  roomId: string;
  playerToken: string;
  seat: number;
}

interface JoinRoomResult {
  roomId: string;
  playerToken: string;
  seat: number;
  reconnected: boolean;
}

interface RoomOptions {
  callTimeoutMs: number;
  playTimeoutMs: number;
  quickPassTimeoutMs: number;
  botActionDelayMs?: number;
  rematchTimeoutMs: number;
}

export class Room {
  readonly id: string;
  readonly mode: GameMode;
  readonly kind: RoomKind;

  private readonly io: Server;
  private readonly database: GameDatabase;
  private readonly options: RoomOptions;
  private readonly members = new Map<number, RoomMember>();
  private readonly botBrains: Map<number, BotBrain>;
  private game: GameEngine | null = null;
  private actionTimer: NodeJS.Timeout | null = null;
  private actionDeadline: Record<string, unknown> | null = null;
  private tableActive = false;
  private lastTurn: Record<string, unknown> | null = null;
  private lastTurnControl: Record<string, unknown> | null = null;
  private lastCallResult: Record<string, unknown> | null = null;
  private lastTeamReveal: {
    targetSeat: number;
    payload: Record<string, unknown>;
  } | null = null;
  private lastGameOver: Record<string, unknown> | null = null;
  private readonly botTimers = new Map<number, NodeJS.Timeout>();
  private readonly rematchVotes = new Set<number>();
  private rematchTimer: NodeJS.Timeout | null = null;
  private rematchExpiresAt: number | null = null;

  constructor(
    io: Server,
    database: GameDatabase,
    id: string,
    mode: GameMode,
    kind: RoomKind,
    options: RoomOptions,
    botBrains: Map<number, BotBrain>,
  ) {
    this.io = io;
    this.database = database;
    this.id = id;
    this.mode = mode;
    this.kind = kind;
    this.options = options;
    this.botBrains = botBrains;
  }

  addMember(socket: Socket, nickname: string, playerToken?: string): JoinRoomResult {
    const reconnecting = playerToken
      ? [...this.members.values()].find((member) => member.token === playerToken)
      : undefined;

    if (reconnecting) {
      reconnecting.nickname = nickname || reconnecting.nickname;
      reconnecting.socketId = socket.id;
      reconnecting.connected = true;
      reconnecting.score = this.database.getOrCreatePlayer(
        reconnecting.token,
        reconnecting.nickname,
      ).score;
      return {
        roomId: this.id,
        playerToken: reconnecting.token,
        seat: reconnecting.seat,
        reconnected: true,
      };
    }

    if (this.game) {
      throw new Error('对局已开始，无法加入');
    }
    if (this.members.size >= 4) {
      throw new Error('房间已满');
    }

    const usedSeats = new Set(this.members.keys());
    const seat = [0, 1, 2, 3].find((candidate) => !usedSeats.has(candidate));
    if (seat === undefined) {
      throw new Error('没有可用座位');
    }

    const token = playerToken ?? randomUUID();
    const stored = this.database.getOrCreatePlayer(
      token,
      nickname.trim().slice(0, 12) || `玩家${seat + 1}`,
    );

    this.members.set(seat, {
      seat,
      nickname: stored.nickname,
      token,
      socketId: socket.id,
      ready: false,
      connected: true,
      score: stored.score,
      isBot: false,
    });

    return {
      roomId: this.id,
      playerToken: this.members.get(seat)?.token as string,
      seat,
      reconnected: false,
    };
  }

  addBot(nickname: string): number {
    if (this.game) {
      throw new Error('对局已开始，无法加入机器人');
    }
    if (this.members.size >= 4) {
      throw new Error('房间已满');
    }

    const usedSeats = new Set(this.members.keys());
    const seat = [0, 1, 2, 3].find((candidate) => !usedSeats.has(candidate));
    if (seat === undefined) {
      throw new Error('没有可用座位');
    }

    this.members.set(seat, {
      seat,
      nickname: nickname.trim().slice(0, 12) || `机器人${seat}`,
      token: `bot:${this.id}:${seat}`,
      socketId: '',
      ready: true,
      connected: true,
      score: 0,
      isBot: true,
    });
    this.broadcastState();
    this.maybeStartGame();
    return seat;
  }

  joinSocket(socket: Socket, seat: number): void {
    socket.join(this.id);
    const member = this.memberAt(seat);
    member.socketId = socket.id;
    member.connected = true;
    this.broadcastState();
    if (this.game) {
      socket.emit('game:deal', { cards: this.game.getHand(seat) });
      if (this.lastCallResult) {
        socket.emit('game:call-result', { ...this.lastCallResult, replay: true });
      }
      if (this.game.phase === 'calling' && this.game.currentSeat === seat) {
        socket.emit('game:call-request', {});
      }
      if (this.game.phase === 'playing' && this.lastTurn) {
        socket.emit('game:turn', this.lastTurn);
        if (this.lastTurnControl) {
          socket.emit('game:turn-control', { ...this.lastTurnControl, replay: true });
        }
      }
      if (this.actionDeadline) {
        socket.emit('game:deadline', this.actionDeadline);
      }
      if (this.game.phase === 'over' && this.lastGameOver) {
        socket.emit('game:over', this.lastGameOver);
        socket.emit('game:rematch-state', this.rematchState());
      }
    }
    if (this.lastTeamReveal?.targetSeat === seat) {
      socket.emit('game:team-reveal', { ...this.lastTeamReveal.payload, replay: true });
    }
  }

  setReady(seat: number, ready?: boolean): void {
    const member = this.memberAt(seat);
    member.ready = ready ?? !member.ready;
    this.broadcastState();
    this.maybeStartGame();
  }

  play(seat: number, cards: Card[]): void {
    this.requireGame().play(seat, cards);
  }

  call(seat: number, rank: number, suit: number): void {
    this.requireGame().call(seat, rank, suit);
  }

  pass(seat: number): void {
    this.requireGame().pass(seat);
  }

  setRematchVote(seat: number, vote?: boolean): Record<string, unknown> {
    const game = this.requireGame();
    if (game.phase !== 'over') {
      throw new Error('本局尚未结束');
    }
    if (this.members.size < 4) {
      throw new Error('房间人数不足，无法再来一局');
    }

    const shouldVote = vote ?? !this.rematchVotes.has(seat);
    if (shouldVote) {
      this.rematchVotes.add(seat);
    } else {
      this.rematchVotes.delete(seat);
    }

    if (this.rematchVotes.size === 0) {
      this.clearRematchTimer();
    } else if (!this.rematchTimer) {
      this.scheduleRematchTimeout();
    }

    const state = this.rematchState();
    this.io.to(this.id).emit('game:rematch-state', state);

    if (this.rematchVotes.size === this.members.size) {
      this.startRematch();
    }
    return state;
  }

  leave(seat: number): void {
    const member = this.memberAt(seat);
    const gamePhase = this.game?.phase;
    if (gamePhase === 'calling' || gamePhase === 'playing') {
      member.connected = false;
      this.broadcastState();
      return;
    }

    if (gamePhase === 'over') {
      this.cancelRematch(`${member.nickname} 离开了房间，再来一局取消`);
    }
    this.members.delete(seat);
    this.broadcastState();
  }

  markDisconnected(socketId: string): void {
    const member = [...this.members.values()].find((item) => item.socketId === socketId);
    if (!member) {
      return;
    }
    member.connected = false;
    if (this.game?.phase === 'over' && !member.isBot) {
      this.cancelRematch(`${member.nickname} 离开了房间，再来一局取消`);
    }
    this.broadcastState();
  }

  getMemberSeat(socketId: string): number | undefined {
    return [...this.members.values()].find((item) => item.socketId === socketId)?.seat;
  }

  close(): void {
    this.clearActionTimer();
    this.clearBotTimers();
    this.clearRematchTimer();
    this.botBrains.clear();
  }

  private startGame(): void {
    if (this.game) {
      return;
    }

    const players: GamePlayer[] = [...this.members.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((member) => ({ seat: member.seat, nickname: member.nickname }));

    this.lastTurn = null;
    this.lastTurnControl = null;
    this.lastCallResult = null;
    this.lastTeamReveal = null;
    this.lastGameOver = null;
    this.tableActive = false;
    this.botBrains.clear();
    for (const member of this.members.values()) {
      if (member.isBot) {
        this.botBrains.set(member.seat, new BotBrain(member.seat, this.mode));
      }
    }
    this.game = new GameEngine(players, this.mode, {
      emit: (event, payload, seat) => {
        this.handleGameEvent(event, payload, seat);
      },
    });
    this.broadcastState();
    this.game.start();
    this.broadcastState();
  }

  private maybeStartGame(): void {
    if (this.members.size === 4 && [...this.members.values()].every((item) => item.ready)) {
      this.startGame();
    }
  }

  private handleGameEvent(
    event: string,
    payload: Record<string, unknown>,
    seat?: number,
  ): void {
    if (event === 'game:over') {
      this.clearActionTimer();
      this.lastTurnControl = null;
      this.clearBotTimers();
      this.applyScores(payload.scoreChanges as number[], payload);
      this.lastGameOver = payload;
      this.botBrains.clear();
      this.broadcastState();
      this.scheduleBotRematchVotes();
    } else if (event === 'game:call-request' && seat !== undefined) {
      if (this.memberAt(seat).isBot) {
        this.scheduleBotCall(seat);
      } else {
        this.scheduleCallTimeout(seat);
      }
    } else if (event === 'game:turn') {
      this.clearActionTimer();
      this.lastTurn = payload;
      const turnSeat = payload.seat as number;
      this.io.to(this.id).emit(event, payload);
      if (this.memberAt(turnSeat).isBot) {
        this.scheduleBotPlay(turnSeat);
      } else {
        const canRespond = this.requireGame().canRespond(turnSeat);
        this.lastTurnControl = { seat: turnSeat, canRespond };
        const target = this.memberAt(turnSeat);
        if (!target.isBot) {
          this.io.to(target.socketId).emit('game:turn-control', this.lastTurnControl);
        }
        this.schedulePlayTimeout(turnSeat, canRespond);
      }
      return;
    } else if (event === 'game:call-result') {
      this.clearActionTimer();
      this.lastCallResult = { ...payload, replay: false };
      this.io.to(this.id).emit(event, this.lastCallResult);
      for (const brain of this.botBrains.values()) {
        brain.onCallResult(payload.callerSeat as number, payload.r as number, payload.s as number);
      }
      return;
    } else if (event === 'game:team-reveal' && seat !== undefined) {
      this.lastTeamReveal = { targetSeat: seat, payload };
      const target = this.memberAt(seat);
      if (!target.isBot) {
        this.io.to(target.socketId).emit(event, payload);
      }
      this.botBrains.get(seat)?.onTeamReveal({
        callerSeat: payload.callerSeat as number,
        teammateSeat: payload.teammateSeat as number,
        selfCall: payload.selfCall === true,
      });
      return;
    } else if (event === 'game:play') {
      this.io.to(this.id).emit(event, payload);
      const wasLead = !this.tableActive;
      this.tableActive = true;
      const cardCounts = this.requireGame().getCardCounts();
      for (const brain of this.botBrains.values()) {
        brain.onPlay(
          payload.seat as number,
          payload.cards as Card[],
          payload.remaining as number,
          cardCounts,
          wasLead,
        );
      }
      return;
    } else if (event === 'game:round-reset') {
      this.tableActive = false;
      this.io.to(this.id).emit(event, payload);
      for (const brain of this.botBrains.values()) {
        brain.onRoundReset();
      }
      return;
    }

    if (seat === undefined) {
      this.io.to(this.id).emit(event, payload);
      return;
    }
    const target = this.memberAt(seat);
    if (target.isBot) {
      return;
    }
    this.io.to(target.socketId).emit(event, payload);
  }

  private scheduleCallTimeout(seat: number): void {
    this.clearActionTimer();
    if (this.options.callTimeoutMs <= 0) {
      return;
    }
    const expiresAt = Date.now() + this.options.callTimeoutMs;
    this.actionDeadline = { seat, kind: 'call', expiresAt };
    this.io.to(this.id).emit('game:deadline', this.actionDeadline);
    this.actionTimer = setTimeout(() => {
      if (!this.game || this.game.phase !== 'calling' || this.game.currentSeat !== seat) {
        return;
      }
      this.game.call(seat, Math.floor(Math.random() * 7), Math.floor(Math.random() * 4));
    }, this.options.callTimeoutMs);
  }

  private scheduleBotCall(seat: number): void {
    this.clearBotTimer(seat);
    this.botTimers.set(seat, setTimeout(() => {
      this.botTimers.delete(seat);
      if (!this.game || this.game.phase !== 'calling' || this.game.currentSeat !== seat) {
        return;
      }
      const brain = this.botBrains.get(seat);
      const call = brain
        ? brain.chooseCall(this.game.getHand(seat))
        : { r: Math.floor(Math.random() * 7), s: Math.floor(Math.random() * 4) };
      this.game.call(seat, call.r, call.s);
    }, this.botDelay()));
  }

  private scheduleBotPlay(seat: number): void {
    this.clearBotTimer(seat);
    this.botTimers.set(seat, setTimeout(() => {
      this.botTimers.delete(seat);
      if (!this.game || this.game.phase !== 'playing' || this.game.currentSeat !== seat) {
        return;
      }

      const game = this.game;
      const hand = game.getHand(seat);
      const cardCounts = game.getCardCounts();
      const table = game.currentTable?.cards ?? null;
      const brain = this.botBrains.get(seat);
      const cards = brain
        ? (table
          ? brain.chooseResponse(hand, table, cardCounts)
          : brain.chooseLead(hand, cardCounts))
        : findSmallestWinningPlay(hand, table, game.isFirstPlay && table === null);
      if (cards) {
        game.play(seat, cards);
      } else if (game.currentTable) {
        game.pass(seat);
      }
    }, this.botDelay()));
  }

  private schedulePlayTimeout(seat: number, canRespond: boolean): void {
    this.clearActionTimer();
    const timeoutMs = canRespond
      ? this.options.playTimeoutMs
      : this.options.quickPassTimeoutMs;
    if (timeoutMs <= 0) {
      return;
    }
    const expiresAt = Date.now() + timeoutMs;
    this.actionDeadline = {
      seat,
      kind: 'play',
      expiresAt,
      quickPass: !canRespond,
    };
    this.io.to(this.id).emit('game:deadline', this.actionDeadline);
    this.actionTimer = setTimeout(() => {
      if (!this.game || this.game.phase !== 'playing' || this.game.currentSeat !== seat) {
        return;
      }
      this.autoPlay(seat);
    }, timeoutMs);
  }

  private autoPlay(seat: number): void {
    if (!this.game) {
      return;
    }
    const hand = this.game.getHand(seat);
    if (hand.length === 0) {
      return;
    }

    if (!this.game.currentTable) {
      const card = this.game.isFirstPlay
        ? hand.find((item) => item.r === 0 && item.s === 0)
        : hand[0];
      if (card) {
        this.game.play(seat, [card]);
      }
      return;
    }

    this.game.pass(seat);
  }

  private scheduleBotRematchVotes(): void {
    if (this.kind !== 'test') {
      return;
    }
    for (const member of this.members.values()) {
      if (!member.isBot) {
        continue;
      }
      const delay = this.options.botActionDelayMs ?? 500;
      this.botTimers.set(member.seat, setTimeout(() => {
        this.botTimers.delete(member.seat);
        if (this.game?.phase !== 'over' || !this.members.has(member.seat)) {
          return;
        }
        this.setRematchVote(member.seat, true);
      }, delay));
    }
  }

  private scheduleRematchTimeout(): void {
    this.clearRematchTimer();
    this.rematchExpiresAt = Date.now() + this.options.rematchTimeoutMs;
    this.io.to(this.id).emit('game:rematch-state', this.rematchState());
    this.rematchTimer = setTimeout(() => {
      this.cancelRematch('30 秒内未全部确认，再来一局已取消');
    }, this.options.rematchTimeoutMs);
  }

  private clearRematchTimer(): void {
    if (this.rematchTimer) {
      clearTimeout(this.rematchTimer);
      this.rematchTimer = null;
    }
    this.rematchExpiresAt = null;
  }

  private cancelRematch(message: string): void {
    this.clearRematchTimer();
    this.rematchVotes.clear();
    this.io.to(this.id).emit('game:rematch-state', this.rematchState());
    this.io.to(this.id).emit('game:rematch-cancelled', { message });
  }

  private startRematch(): void {
    this.clearActionTimer();
    this.clearBotTimers();
    this.clearRematchTimer();
    this.rematchVotes.clear();
    this.game = null;
    this.startGame();
  }

  private rematchState(): Record<string, unknown> {
    return {
      votes: [...this.rematchVotes].sort((a, b) => a - b),
      count: this.rematchVotes.size,
      total: this.members.size,
      expiresAt: this.rematchExpiresAt,
    };
  }

  private clearActionTimer(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.actionDeadline = null;
  }

  private botDelay(): number {
    return this.options.botActionDelayMs
      ?? 1000 + Math.floor(Math.random() * 1000);
  }

  private clearBotTimer(seat: number): void {
    const timer = this.botTimers.get(seat);
    if (timer) {
      clearTimeout(timer);
      this.botTimers.delete(seat);
    }
  }

  private clearBotTimers(): void {
    for (const timer of this.botTimers.values()) {
      clearTimeout(timer);
    }
    this.botTimers.clear();
  }

  private applyScores(changes: number[], payload: Record<string, unknown>): void {
    const players = [...this.members.values()].sort((a, b) => a.seat - b.seat);
    if (this.kind === 'test' || players.some((member) => member.isBot)) {
      payload.totals = players.map((member) => ({
        seat: member.seat,
        nickname: member.nickname,
        score: member.score,
      }));
      return;
    }

    const totals = this.database.recordMatch({
      roomId: this.id,
      mode: this.mode,
      rankings: payload.rankings as number[],
      scoreChanges: changes,
      players: players.map((member) => ({
        seat: member.seat,
        token: member.token,
        nickname: member.nickname,
        score: member.score,
      })),
    });
    for (const member of players) {
      member.score = totals.find((item) => item.token === member.token)?.score ?? member.score;
    }
    payload.totals = players.map((member) => ({
      seat: member.seat,
      nickname: member.nickname,
      score: member.score,
    }));
  }

  private broadcastState(): void {
    this.io.to(this.id).emit('room:state', this.publicState());
  }

  private publicState(): Record<string, unknown> {
    return {
      roomId: this.id,
      mode: this.mode,
      kind: this.kind,
      testing: this.kind === 'test',
      hostSeat: 0,
      phase: this.game?.phase ?? 'waiting',
      players: [...this.members.values()]
        .sort((a, b) => a.seat - b.seat)
        .map((member) => ({
          seat: member.seat,
          nickname: member.nickname,
          ready: member.ready,
          connected: member.connected,
          score: member.score,
          isBot: member.isBot,
        })),
    };
  }

  private memberAt(seat: number): RoomMember {
    const member = this.members.get(seat);
    if (!member) {
      throw new Error('座位不存在');
    }
    return member;
  }

  private requireGame(): GameEngine {
    if (!this.game) {
      throw new Error('对局尚未开始');
    }
    return this.game;
  }
}

export class RoomManager {
  private readonly io: Server;
  private readonly database: GameDatabase;
  private readonly options: RoomOptions;
  private readonly rooms = new Map<string, Room>();
  // 按房间分组，保证多个机器人房并存时同一座位号的机器人不会共用大脑。
  private readonly botBrains = new Map<string, Map<number, BotBrain>>();

  constructor(io: Server, database: GameDatabase, options: RoomOptions) {
    this.io = io;
    this.database = database;
    this.options = options;
  }

  createRoom(
    socket: Socket,
    nickname: string,
    mode: GameMode,
    playerToken?: string,
    roomOptions: { kind: RoomKind; withBots: boolean } = {
      kind: 'normal',
      withBots: false,
    },
  ): CreateRoomResult {
    const roomId = this.generateRoomId();
    const botBrains = new Map<number, BotBrain>();
    this.botBrains.set(roomId, botBrains);
    const room = new Room(
      this.io,
      this.database,
      roomId,
      mode,
      roomOptions.kind,
      this.options,
      botBrains,
    );
    const result = room.addMember(socket, nickname, playerToken);
    if (roomOptions.withBots) {
      for (let index = 1; index <= 3; index += 1) {
        room.addBot(`机器人${index}`);
      }
    }
    this.rooms.set(roomId, room);
    room.joinSocket(socket, result.seat);
    return result;
  }

  joinRoom(
    socket: Socket,
    roomId: string,
    nickname: string,
    playerToken?: string,
    entry: RoomKind = 'normal',
  ): JoinRoomResult {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error('房间不存在');
    }
    if (room.kind !== entry) {
      throw new Error('房间入口不匹配');
    }
    const result = room.addMember(socket, nickname, playerToken);
    room.joinSocket(socket, result.seat);
    return result;
  }

  setReady(socket: Socket, ready?: boolean): void {
    const { room, seat } = this.resolve(socket);
    room.setReady(seat, ready);
  }

  play(socket: Socket, cards: Card[]): void {
    const { room, seat } = this.resolve(socket);
    room.play(seat, cards);
  }

  call(socket: Socket, rank: number, suit: number): void {
    const { room, seat } = this.resolve(socket);
    room.call(seat, rank, suit);
  }

  pass(socket: Socket): void {
    const { room, seat } = this.resolve(socket);
    room.pass(seat);
  }

  addBot(socket: Socket): void {
    const { room } = this.resolve(socket);
    room.addBot('');
  }

  setRematchVote(socket: Socket, vote?: boolean): Record<string, unknown> {
    const { room, seat } = this.resolve(socket);
    return room.setRematchVote(seat, vote);
  }

  leave(socket: Socket): void {
    const { room, seat } = this.resolve(socket);
    socket.leave(room.id);
    room.leave(seat);
  }

  disconnect(socket: Socket): void {
    for (const room of this.rooms.values()) {
      if (room.getMemberSeat(socket.id) !== undefined) {
        room.markDisconnected(socket.id);
      }
    }
  }

  close(): void {
    for (const room of this.rooms.values()) {
      room.close();
    }
    this.rooms.clear();
    this.botBrains.clear();
  }

  private resolve(socket: Socket): { room: Room; seat: number } {
    for (const room of this.rooms.values()) {
      const seat = room.getMemberSeat(socket.id);
      if (seat !== undefined) {
        return { room, seat };
      }
    }
    throw new Error('你尚未加入房间');
  }

  private generateRoomId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const roomId = String(Math.floor(1000 + Math.random() * 9000));
      if (!this.rooms.has(roomId)) {
        return roomId;
      }
    }
    throw new Error('暂时无法创建房间');
  }
}
