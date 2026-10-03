import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { GameDatabase } from './db';
import type { GameMode } from './game';
import { RoomManager, type RoomKind } from './room';
import type { Card } from './rules';

type Ack = (response: Record<string, unknown>) => void;

interface RoomCreatePayload {
  nickname?: string;
  mode?: GameMode;
  playerToken?: string;
  withBots?: boolean;
}

interface RoomJoinPayload {
  roomId?: string;
  nickname?: string;
  playerToken?: string;
}

interface GamePlayPayload {
  cards?: Card[];
}

interface GameCallPayload {
  r?: number;
  s?: number;
}

interface AppServerOptions {
  dbPath?: string;
  callTimeoutMs?: number;
  playTimeoutMs?: number;
  quickPassTimeoutMs?: number;
  botActionDelayMs?: number;
  rematchTimeoutMs?: number;
}

export function createAppServer(options: AppServerOptions = {}) {
  const botActionDelayMs = options.botActionDelayMs
    ?? (process.env.BOT_ACTION_DELAY_MS === undefined
      ? undefined
      : Number(process.env.BOT_ACTION_DELAY_MS));
  const app = express();
  const httpServer = createHttpServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });
  const database = new GameDatabase(options.dbPath ?? process.env.DB_PATH);
  const rooms = new RoomManager(io, database, {
    callTimeoutMs: options.callTimeoutMs
      ?? Number(process.env.CALL_TIMEOUT_MS ?? 60_000),
    playTimeoutMs: options.playTimeoutMs
      ?? Number(process.env.PLAY_TIMEOUT_MS ?? 15_000),
    quickPassTimeoutMs: options.quickPassTimeoutMs
      ?? Number(process.env.QUICK_PASS_TIMEOUT_MS ?? 5_000),
    botActionDelayMs,
    rematchTimeoutMs: options.rematchTimeoutMs
      ?? Number(process.env.REMATCH_TIMEOUT_MS ?? 30_000),
  });

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/leaderboard', (_request, response) => {
    response.json({ ok: true, players: database.leaderboard() });
  });

  app.get('/api/matches', (request, response) => {
    const token = typeof request.query.token === 'string' ? request.query.token : '';
    response.json({
      ok: Boolean(token),
      matches: token ? database.listMatches(token) : [],
    });
  });

  const clientDist = path.resolve(__dirname, '../client');
  app.use(express.static(clientDist));
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(clientDist, 'index.html'));
  });

  io.on('connection', (socket) => {
    const entry: RoomKind = socket.handshake.query.entry === 'test' ? 'test' : 'normal';

    socket.on('room:create', (payload: RoomCreatePayload = {}, ack?: Ack) => {
      handleAction(ack, () => {
        const nickname = payload.nickname ?? '';
        const mode = payload.mode ?? 'dahua';
        return {
          ok: true,
          ...rooms.createRoom(socket, nickname, mode, payload.playerToken, {
            kind: entry,
            withBots: entry === 'test' && payload.withBots === true,
          }),
        };
      });
    });

    socket.on('room:join', (payload: RoomJoinPayload = {}, ack?: Ack) => {
      handleAction(ack, () => {
        if (!payload.roomId) {
          throw new Error('缺少房号');
        }
        return {
          ok: true,
          ...rooms.joinRoom(
            socket,
            payload.roomId,
            payload.nickname ?? '',
            payload.playerToken,
            entry,
          ),
        };
      });
    });

    socket.on('room:ready', (payload: { ready?: boolean } = {}, ack?: Ack) => {
      handleAction(ack, () => {
        rooms.setReady(socket, payload.ready);
        return { ok: true };
      });
    });

    socket.on('game:play', (payload: GamePlayPayload = {}, ack?: Ack) => {
      handleAction(ack, () => {
        rooms.play(socket, payload.cards ?? []);
        return { ok: true };
      });
    });

    socket.on('game:call', (payload: GameCallPayload = {}, ack?: Ack) => {
      handleAction(ack, () => {
        if (payload.r === undefined || payload.s === undefined) {
          throw new Error('请选择叫牌点数与花色');
        }
        rooms.call(socket, payload.r, payload.s);
        return { ok: true };
      });
    });

    socket.on('game:pass', (_payload: unknown, ack?: Ack) => {
      handleAction(ack, () => {
        rooms.pass(socket);
        return { ok: true };
      });
    });

    socket.on('room:add-bot', (_payload: unknown, ack?: Ack) => {
      handleAction(ack, () => {
        rooms.addBot(socket);
        return { ok: true };
      });
    });

    socket.on('game:rematch', (payload: { vote?: boolean } = {}, ack?: Ack) => {
      handleAction(ack, () => ({
        ok: true,
        ...rooms.setRematchVote(socket, payload.vote),
      }));
    });

    socket.on('room:leave', (_payload: unknown, ack?: Ack) => {
      handleAction(ack, () => {
        rooms.leave(socket);
        return { ok: true };
      });
    });

    socket.on('disconnect', () => {
      rooms.disconnect(socket);
    });
  });

  return { app, httpServer, io, rooms, database };
}

function handleAction(ack: Ack | undefined, action: () => Record<string, unknown>): void {
  try {
    const response = action();
    ack?.(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : '服务端处理失败';
    ack?.({ ok: false, error: message });
  }
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  const runtime = createAppServer();
  runtime.httpServer.listen(port, host, () => {
    console.log(`FFP-Game listening on http://${host}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    runtime.rooms.close();
    runtime.io.close(() => {
      runtime.database.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
