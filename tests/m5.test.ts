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

async function createHarness(options: {
  callTimeoutMs?: number;
  playTimeoutMs?: number;
} = {}): Promise<ServerHarness> {
  const appServer = createAppServer({ dbPath: ':memory:', ...options });
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

async function connect(harness: ServerHarness): Promise<ClientSocket> {
  const socket = createClient(harness.url, {
    transports: ['websocket'],
    forceNew: true,
  });
  harness.sockets.push(socket);
  await once(socket, 'connect');
  return socket;
}

async function createFourPlayerGame(
  harness: ServerHarness,
  mode: 'dahua' | 'dapengyou',
) {
  const sockets = await Promise.all([0, 1, 2, 3].map(() => connect(harness)));
  const created = await emitAck(sockets[0], 'room:create', {
    nickname: '玩家1',
    mode,
  });
  const joins = [{ socket: sockets[0], ...created }];
  for (let index = 1; index < sockets.length; index += 1) {
    const joined = await emitAck(sockets[index], 'room:join', {
      roomId: created.roomId,
      nickname: `玩家${index + 1}`,
    });
    joins.push({ socket: sockets[index], ...joined });
  }
  return { sockets, joins, roomId: created.roomId as string };
}

describe('M5 超时与重连', () => {
  it('叫牌和出牌超时后由服务端自动托管', async () => {
    const harness = await createHarness({ callTimeoutMs: 50, playTimeoutMs: 50 });
    const { sockets } = await createFourPlayerGame(harness, 'dapengyou');
    const callResult = once(sockets[0], 'game:call-result');
    const autoPlay = once(sockets[0], 'game:play');

    await Promise.all(sockets.map((socket, index) => emitAck(socket, 'room:ready', {
      ready: index === 0,
    })));
    for (let index = 1; index < sockets.length; index += 1) {
      await emitAck(sockets[index], 'room:ready', {});
    }

    await expect(withTimeout(callResult, 500)).resolves.toBeTruthy();
    await expect(withTimeout(autoPlay, 500)).resolves.toBeTruthy();
  });

  it('断线后可使用原 token 回到同一座位并恢复手牌', async () => {
    const harness = await createHarness();
    const { sockets, joins, roomId } = await createFourPlayerGame(harness, 'dahua');
    const target = joins[1];
    const firstDeal = once(target.socket, 'game:deal');

    await Promise.all(sockets.map((socket) => emitAck(socket, 'room:ready', {})));
    await firstDeal;

    target.socket.disconnect();
    const replacement = await connect(harness);
    const restoredDeal = once(replacement, 'game:deal');
    const rejoin = await emitAck(replacement, 'room:join', {
      roomId,
      nickname: '玩家2',
      playerToken: target.playerToken,
    });
    const restored = await withTimeout(restoredDeal, 500);

    expect(rejoin).toMatchObject({
      ok: true,
      seat: target.seat,
      reconnected: true,
    });
    expect((restored.payload as { cards: unknown[] }).cards).toHaveLength(13);
  });
});

function once(socket: ClientSocket, event: string): Promise<{ payload: unknown }> {
  return new Promise((resolve) => {
    socket.once(event, (payload: unknown) => resolve({ payload }));
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

function emitAck(
  socket: ClientSocket,
  event: string,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}
