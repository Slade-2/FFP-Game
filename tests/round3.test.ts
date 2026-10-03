import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { createAppServer } from '../server';

interface ServerHarness {
  appServer: ReturnType<typeof createAppServer>;
  url: string;
  sockets: ClientSocket[];
}

const harnesses: ServerHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const socket of harness.sockets) {
      socket.disconnect();
    }
    harness.appServer.rooms.close();
    await new Promise<void>((resolve) => harness.appServer.io.close(() => resolve()));
    harness.appServer.database.close();
  }
});

async function createHarness(
  overrides: { botActionDelayMs?: number; rematchTimeoutMs?: number } = {},
): Promise<ServerHarness> {
  const appServer = createAppServer({
    dbPath: ':memory:',
    playTimeoutMs: 10,
    quickPassTimeoutMs: 10,
    botActionDelayMs: overrides.botActionDelayMs ?? 0,
    rematchTimeoutMs: overrides.rematchTimeoutMs ?? 1000,
  });
  await new Promise<void>((resolve) => {
    appServer.httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = appServer.httpServer.address() as AddressInfo;
  return {
    appServer,
    url: `http://127.0.0.1:${address.port}`,
    sockets: [],
  };
}

async function connect(
  harness: ServerHarness,
  entry: 'normal' | 'test' = 'normal',
): Promise<ClientSocket> {
  const socket = createClient(harness.url, {
    transports: ['websocket'],
    forceNew: true,
    query: { entry },
  });
  harness.sockets.push(socket);
  await once(socket, 'connect');
  return socket;
}

describe('第三轮测试端、机器人与重赛', () => {
  it('普通入口忽略机器人开关，测试入口创建 1 人加 3 机器人', async () => {
    const normalHarness = await createHarness();
    const normalSocket = await connect(normalHarness);
    const normalState = once(normalSocket, 'room:state');
    const normalCreated = await emitAck(normalSocket, 'room:create', {
      nickname: '正式玩家',
      mode: 'dahua',
      withBots: true,
    });
    expect(normalCreated.ok).toBe(true);
    expect((await normalState).payload.players).toHaveLength(1);

    const testHarness = await createHarness();
    const testSocket = await connect(testHarness, 'test');
    const testState = once(testSocket, 'room:state');
    const testCreated = await emitAck(testSocket, 'room:create', {
      nickname: '测试玩家',
      mode: 'dahua',
      withBots: true,
    });
    expect(testCreated.ok).toBe(true);
    const state = (await testState).payload;
    expect(state.kind).toBe('test');
    expect(state.players).toHaveLength(4);
    expect(state.players.filter((player: { nickname: string }) => player.nickname.startsWith('机')))
      .toHaveLength(3);
    expect(state.players.filter((player: { ready: boolean }) => player.ready)).toHaveLength(3);
  });

  it('机器人完成整局、测试积分不入账，并可与玩家投票重开', async () => {
    const harness = await createHarness();
    const socket = await connect(harness, 'test');
    await emitAck(socket, 'room:create', {
      nickname: '测试玩家',
      mode: 'dahua',
      withBots: true,
    });

    const rematchStates: Array<{ count: number; votes: number[] }> = [];
    socket.on('game:rematch-state', (payload: { count: number; votes: number[] }) => {
      rematchStates.push(payload);
    });
    const firstStart = once(socket, 'game:start');
    const firstOver = once(socket, 'game:over');

    expect(await emitAck(socket, 'room:ready', {})).toEqual({ ok: true });
    await withTimeout(firstStart, 2000);
    const over = await withTimeout(firstOver, 15_000);
    expect(over.payload.rankings).toHaveLength(4);
    expect(over.payload.totals.every((item: { score: number }) => item.score === 0)).toBe(true);
    expect(harness.appServer.database.leaderboard().every((item) => item.score === 0)).toBe(true);

    await waitUntil(() => rematchStates.some((state) => state.count === 3), 2000);
    const secondStart = once(socket, 'game:start');
    const vote = await emitAck(socket, 'game:rematch', { vote: true });
    expect(vote.ok).toBe(true);
    await withTimeout(secondStart, 2000);
  }, 20_000);

  it('普通房空位可添加机器人，含机器人对局不计入总分榜', async () => {
    const harness = await createHarness();
    const socket = await connect(harness);
    const created = await emitAck(socket, 'room:create', {
      nickname: '补位玩家',
      mode: 'dahua',
      withBots: true,
    });
    expect(created.ok).toBe(true);

    let statePromise = once(socket, 'room:state');
    for (let index = 0; index < 3; index += 1) {
      const added = await emitAck(socket, 'room:add-bot', {});
      expect(added.ok).toBe(true);
      const state = (await statePromise).payload;
      expect(state.players.filter((player: { isBot?: boolean }) => player.isBot))
        .toHaveLength(index + 1);
      statePromise = once(socket, 'room:state');
    }

    const overPromise = once(socket, 'game:over');
    expect(await emitAck(socket, 'room:ready', {})).toEqual({ ok: true });
    const over = await withTimeout(overPromise, 15_000);
    expect(over.payload.rankings).toHaveLength(4);
    expect(over.payload.totals.every((item: { score: number }) => item.score === 0)).toBe(true);
    expect(harness.appServer.database.leaderboard().every((item) => item.score === 0)).toBe(true);

    const response = await fetch(
      `${harness.url}/api/matches?token=${encodeURIComponent(created.playerToken as string)}`,
    );
    const history = await response.json();
    expect(history.ok).toBe(true);
    expect(history.matches).toEqual([]);
  }, 20_000);

  it('正式房对局结束后机器人自动投赞成票，仍需真人确认才重开', async () => {
    const harness = await createHarness();
    const socket = await connect(harness);
    const created = await emitAck(socket, 'room:create', {
      nickname: '正式房玩家',
      mode: 'dahua',
    });
    expect(created.ok).toBe(true);

    for (let index = 0; index < 3; index += 1) {
      expect((await emitAck(socket, 'room:add-bot', {})).ok).toBe(true);
    }

    const voteStates: Array<{ count: number; votes: number[] }> = [];
    const cancelled = once(socket, 'game:rematch-cancelled');
    socket.on('game:rematch-state', (payload: { count: number; votes: number[] }) => {
      voteStates.push(payload);
    });

    const overPromise = once(socket, 'game:over');
    expect(await emitAck(socket, 'room:ready', {})).toEqual({ ok: true });
    const over = await withTimeout(overPromise, 15_000);
    expect(over.payload.rankings).toHaveLength(4);

    const startsAfterOver: unknown[] = [];
    socket.on('game:start', (payload: unknown) => startsAfterOver.push(payload));

    await waitUntil(() => voteStates.some((state) => [1, 2, 3].every(
      (seat) => state.votes.includes(seat),
    )), 2000);
    const botVotes = voteStates.find((state) => [1, 2, 3].every(
      (seat) => state.votes.includes(seat),
    ));
    expect(botVotes?.count).toBe(3);

    await withTimeout(cancelled, 3000);
    expect(startsAfterOver).toHaveLength(0);
  }, 20_000);

  it('真人离开后机器人不再投票，也不会无人确认直接重开', async () => {
    const harness = await createHarness({ botActionDelayMs: 100, rematchTimeoutMs: 300 });
    const socket = await connect(harness);
    expect((await emitAck(socket, 'room:create', {
      nickname: '要离开的玩家',
      mode: 'dahua',
    })).ok).toBe(true);
    for (let index = 0; index < 3; index += 1) {
      expect((await emitAck(socket, 'room:add-bot', {})).ok).toBe(true);
    }

    const overPromise = once(socket, 'game:over');
    expect(await emitAck(socket, 'room:ready', {})).toEqual({ ok: true });
    const over = await withTimeout(overPromise, 15_000);
    expect(over.payload.rankings).toHaveLength(4);

    expect((await emitAck(socket, 'room:leave', {})).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const probe = await connect(harness);
    expect((await emitAck(probe, 'room:create', {
      nickname: '探针玩家',
      mode: 'dahua',
    })).ok).toBe(true);
  }, 20_000);
});

function once(socket: ClientSocket, event: string): Promise<{ payload: any }> {
  return new Promise((resolve) => {
    socket.once(event, (payload: unknown) => resolve({ payload }));
  });
}

function emitAck(
  socket: ClientSocket,
  event: string,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack 超时`)), 3000);
    socket.emit(event, payload, (response: Record<string, any>) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error('等待事件超时')), timeoutMs);
    }),
  ]);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('等待状态超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
