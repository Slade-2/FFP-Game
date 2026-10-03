import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { createAppServer } from '../server';
import { beats, type Card } from '../server/rules';

interface Signal {
  event: string;
  payload: any;
}

describe('M2 Socket.IO 打花全流程', () => {
  let appServer: ReturnType<typeof createAppServer>;
  let url = '';
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    appServer = createAppServer({ dbPath: ':memory:' });
    await new Promise<void>((resolve) => {
      appServer.httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = appServer.httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    appServer.rooms.close();
    await new Promise<void>((resolve) => appServer.io.close(() => resolve()));
    appServer.database.close();
  });

  it('四个客户端可建房、发牌、出牌、pass 并结算', async () => {
    const clients = await Promise.all([0, 1, 2, 3].map(() => connect(url, sockets)));
    const createResult = await emitAck(clients[0], 'room:create', {
      nickname: '玩家1',
      mode: 'dahua',
    });
    expect(createResult.ok).toBe(true);
    const roomId = createResult.roomId as string;

    const seats = [{ socket: clients[0], seat: createResult.seat as number }];
    for (let index = 1; index < clients.length; index += 1) {
      const result = await emitAck(clients[index], 'room:join', {
        roomId,
        nickname: `玩家${index + 1}`,
      });
      expect(result.ok).toBe(true);
      seats.push({ socket: clients[index], seat: result.seat as number });
    }

    const bySeat = new Map(seats.map((item) => [item.seat, item.socket]));
    const hands = new Map<number, Card[]>();
    const turnControls: Array<{ socketSeat: number; payload: any }> = [];
    const deals = new Map<number, Promise<Signal>>();
    for (const item of seats) {
      deals.set(item.seat, onceSignal(item.socket, 'game:deal'));
      item.socket.on('game:turn-control', (payload) => {
        turnControls.push({ socketSeat: item.seat, payload });
      });
      item.socket.on('game:deal', (payload) => {
        hands.set(item.seat, payload.cards);
      });
    }

    const signals: Signal[] = [];
    const waiters: Array<(signal: Signal) => void> = [];
    clients[0].on('game:turn', (payload) => pushSignal({ event: 'game:turn', payload }));
    clients[0].on('game:over', (payload) => pushSignal({ event: 'game:over', payload }));

    function pushSignal(signal: Signal): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(signal);
      } else {
        signals.push(signal);
      }
    }

    function nextSignal(): Promise<Signal> {
      const signal = signals.shift();
      if (signal) {
        return Promise.resolve(signal);
      }
      return new Promise((resolve) => waiters.push(resolve));
    }

    await Promise.all(seats.map(({ socket }) => emitAck(socket, 'room:ready', {})));
    const dealt = await Promise.all(deals.values());
    expect(dealt.every((signal) => signal.payload.cards.length === 13)).toBe(true);

    let signal = await nextSignal();
    let safety = 1000;
    while (signal.event !== 'game:over' && safety-- > 0) {
      expect(signal.event).toBe('game:turn');
      const seat = signal.payload.seat as number;
      const socket = bySeat.get(seat) as ClientSocket;
      const hand = hands.get(seat) as Card[];

      if (signal.payload.table) {
        const next = hand.find((card) => beats(signal.payload.table.cards, [card]));
        if (next) {
          const result = await emitAck(socket, 'game:play', { cards: [next] });
          expect(result).toEqual({ ok: true });
          removeCards(hand, [next]);
        } else {
          const result = await emitAck(socket, 'game:pass', {});
          expect(result).toEqual({ ok: true });
        }
      } else {
        const card = signal.payload.mustIncludeDiamondFour
          ? hand.find((item) => item.r === 0 && item.s === 0)
          : hand[0];
        expect(card).toBeDefined();
        const result = await emitAck(socket, 'game:play', { cards: [card] });
        expect(result).toEqual({ ok: true });
        removeCards(hand, [card as Card]);
      }
      signal = await nextSignal();
    }

    expect(safety).toBeGreaterThan(0);
    expect(signal.payload.rankings).toHaveLength(4);
    expect(new Set(signal.payload.rankings).size).toBe(4);
    expect((signal.payload.scoreChanges as number[]).reduce((sum, value) => sum + value, 0))
      .toBe(0);
    expect(turnControls.length).toBeGreaterThan(0);
    expect(turnControls.every((item) => (
      item.socketSeat === item.payload.seat
      && typeof item.payload.canRespond === 'boolean'
    ))).toBe(true);
  }, 15000);

  it('打朋友队友身份只出现在相关玩家的私有报文中', async () => {
    const clients = await Promise.all([0, 1, 2, 3].map(() => connect(url, sockets)));
    const createResult = await emitAck(clients[0], 'room:create', {
      nickname: '叫牌人',
      mode: 'dapengyou',
    });
    const roomId = createResult.roomId as string;
    const seats = [{ socket: clients[0], seat: createResult.seat as number }];

    for (let index = 1; index < clients.length; index += 1) {
      const result = await emitAck(clients[index], 'room:join', {
        roomId,
        nickname: `玩家${index + 1}`,
      });
      seats.push({ socket: clients[index], seat: result.seat as number });
    }

    const packets = new Map<number, Array<{ event: string; args: unknown[] }>>();
    const hands = new Map<number, Card[]>();
    const dealPromises = new Map<number, Promise<Signal>>();
    const callRequests = seats.map((item) => (
      onceSignal(item.socket, 'game:call-request').then(() => item.seat)
    ));
    const callResults = new Map<number, Promise<Signal>>();
    const overResults = new Map<number, Promise<Signal>>();

    for (const item of seats) {
      packets.set(item.seat, []);
      callResults.set(item.seat, onceSignal(item.socket, 'game:call-result'));
      overResults.set(item.seat, onceSignal(item.socket, 'game:over'));
      dealPromises.set(item.seat, onceSignal(item.socket, 'game:deal'));
      item.socket.onAny((event: string, ...args: unknown[]) => {
        packets.get(item.seat)?.push({ event, args });
      });
      item.socket.on('game:deal', (payload) => {
        hands.set(item.seat, payload.cards);
      });
    }

    await Promise.all(seats.map(({ socket }) => emitAck(socket, 'room:ready', {})));
    await Promise.all(dealPromises.values());
    const callerSeat = await Promise.any(callRequests);
    const callerSocket = seats.find((item) => item.seat === callerSeat)?.socket as ClientSocket;
    const bySeat = new Map(seats.map((item) => [item.seat, item.socket]));
    const ownCard = (hands.get(callerSeat) as Card[]).find((card) => card.r <= 6) as Card;
    expect(ownCard).toBeDefined();

    const signals: Signal[] = [];
    const signalWaiters: Array<(signal: Signal) => void> = [];
    clients[0].on('game:turn', (payload) => pushSignal({ event: 'game:turn', payload }));
    clients[0].on('game:over', (payload) => pushSignal({ event: 'game:over', payload }));

    function pushSignal(signal: Signal): void {
      const waiter = signalWaiters.shift();
      if (waiter) {
        waiter(signal);
      } else {
        signals.push(signal);
      }
    }

    function nextSignal(): Promise<Signal> {
      const signal = signals.shift();
      if (signal) {
        return Promise.resolve(signal);
      }
      return new Promise((resolve) => signalWaiters.push(resolve));
    }

    const result = await emitAck(callerSocket, 'game:call', { r: ownCard.r, s: ownCard.s });
    expect(result).toEqual({ ok: true });
    const published = await Promise.all(callResults.values());
    expect(published.every((signal) => (
      JSON.stringify(signal.payload) === JSON.stringify(published[0].payload)
    ))).toBe(true);

    let turnSignal = await nextSignal();
    let safety = 1000;
    while (turnSignal.event !== 'game:over' && safety-- > 0) {
      const seat = turnSignal.payload.seat as number;
      const hand = hands.get(seat) as Card[];
      const table = turnSignal.payload.table as { cards: Card[] } | null;
      if (table) {
        const next = hand.find((card) => beats(table.cards, [card]));
        if (next) {
          await emitAck(bySeat.get(seat) as ClientSocket, 'game:play', { cards: [next] });
          removeCards(hand, [next]);
        } else {
          await emitAck(bySeat.get(seat) as ClientSocket, 'game:pass', {});
        }
      } else {
        const lead = turnSignal.payload.mustIncludeDiamondFour
          ? hand.find((card) => card.r === 0 && card.s === 0)
          : hand[0];
        await emitAck(bySeat.get(seat) as ClientSocket, 'game:play', { cards: [lead] });
        removeCards(hand, [lead as Card]);
      }
      turnSignal = await nextSignal();
    }
    expect(safety).toBeGreaterThan(0);

    const overPackets = await Promise.all(overResults.values());
    expect(overPackets.every((signal) => (
      Array.isArray(signal.payload.scoreChanges)
      && Array.isArray(signal.payload.totals)
    ))).toBe(true);
    const revealEvents = [...packets.entries()].flatMap(([seat, items]) => (
      items
        .filter((item) => item.event === 'game:team-reveal')
        .map((item) => ({ seat, payload: item.args[0] }))
    ));
    expect(revealEvents).toHaveLength(1);
    expect(revealEvents[0]?.seat).toBe(callerSeat);
    expect(revealEvents[0]?.payload).toMatchObject({
      callerSeat,
      teammateSeat: callerSeat,
      selfCall: true,
    });

    const publicPackets = [...packets.values()]
      .flatMap((items) => items)
      .filter((item) => item.event !== 'game:team-reveal');
    expect(JSON.stringify(publicPackets)).not.toMatch(/teammate|isTeammate|solo/i);
  }, 15000);

  it('对局记录 API 按玩家返回名次和得分明细', async () => {
    const token = 'history-api-token';
    appServer.database.getOrCreatePlayer(token, '记录玩家');
    appServer.database.recordMatch({
      roomId: '8899',
      mode: 'dahua',
      rankings: [0, 1, 2, 3],
      scoreChanges: [4, 2, -2, -4],
      players: [
        { seat: 0, token, nickname: '记录玩家' },
        { seat: 1, token: 'history-other-1', nickname: '甲' },
        { seat: 2, token: 'history-other-2', nickname: '乙' },
        { seat: 3, token: 'history-other-3', nickname: '丙' },
      ],
    });

    const response = await fetch(`${url}/api/matches?token=${encodeURIComponent(token)}`);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]).toMatchObject({
      roomId: '8899',
      mode: 'dahua',
      rank: 1,
      scoreChange: 4,
    });
    expect(payload.matches[0].players).toHaveLength(4);
  });
});

async function connect(baseUrl: string, sockets: ClientSocket[]): Promise<ClientSocket> {
  const socket = createClient(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
  });
  sockets.push(socket);
  await onceSignal(socket, 'connect');
  return socket;
}

function emitAck(
  socket: ClientSocket,
  event: string,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} ack 超时`)), 2000);
    socket.emit(event, payload, (response: Record<string, any>) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function onceSignal(socket: ClientSocket, event: string): Promise<Signal> {
  return new Promise((resolve) => {
    socket.once(event, (payload: unknown) => resolve({ event, payload }));
  });
}

function removeCards(hand: Card[], cards: Card[]): void {
  for (const card of cards) {
    const index = hand.findIndex((item) => item.r === card.r && item.s === card.s);
    hand.splice(index, 1);
  }
}
