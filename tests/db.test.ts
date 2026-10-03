import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GameDatabase } from '../server/db';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('M5 SQLite 持久化', () => {
  it('累计玩家积分并写入对局记录', () => {
    const db = new GameDatabase(':memory:');
    db.getOrCreatePlayer('token-a', '甲');
    db.getOrCreatePlayer('token-b', '乙');

    const totals = db.recordMatch({
      roomId: '1234',
      mode: 'dahua',
      rankings: [0, 1],
      scoreChanges: [4, -4],
      players: [
        { seat: 0, token: 'token-a', nickname: '甲' },
        { seat: 1, token: 'token-b', nickname: '乙' },
      ],
    });

    expect(totals.find((item) => item.token === 'token-a')?.score).toBe(4);
    expect(totals.find((item) => item.token === 'token-b')?.score).toBe(-4);
    expect(db.leaderboard()[0]).toMatchObject({ nickname: '甲', score: 4 });
    db.close();
  });

  it('数据库文件重开后积分仍存在', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ffp-db-'));
    tempDirectories.push(directory);
    const file = path.join(directory, 'game.db');

    const first = new GameDatabase(file);
    first.getOrCreatePlayer('persistent-token', '常客');
    first.recordMatch({
      roomId: '5678',
      mode: 'dapengyou',
      rankings: [0, 1],
      scoreChanges: [2, 2],
      players: [
        { seat: 0, token: 'persistent-token', nickname: '常客' },
      ],
    });
    first.close();

    const second = new GameDatabase(file);
    expect(second.getOrCreatePlayer('persistent-token', '常客').score).toBe(2);
    second.close();
  });

  it('可按玩家查询倒序对局记录与得分明细', () => {
    const db = new GameDatabase(':memory:');
    db.getOrCreatePlayer('history-token', '记录玩家');
    db.recordMatch({
      roomId: '1001',
      mode: 'dahua',
      rankings: [0, 1, 2, 3],
      scoreChanges: [4, 2, -2, -4],
      players: [
        { seat: 0, token: 'history-token', nickname: '记录玩家' },
        { seat: 1, token: 'other-a', nickname: '甲' },
        { seat: 2, token: 'other-b', nickname: '乙' },
        { seat: 3, token: 'other-c', nickname: '丙' },
      ],
    });
    db.recordMatch({
      roomId: '1002',
      mode: 'dapengyou',
      rankings: [0, 1, 2, 3],
      scoreChanges: [-4, -4, 4, 4],
      players: [
        { seat: 0, token: 'history-token', nickname: '记录玩家' },
        { seat: 1, token: 'other-a', nickname: '甲' },
        { seat: 2, token: 'other-b', nickname: '乙' },
        { seat: 3, token: 'other-c', nickname: '丙' },
      ],
    });

    const records = db.listMatches('history-token');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      roomId: '1002',
      mode: 'dapengyou',
      rank: 1,
      scoreChange: -4,
    });
    expect(records[1]).toMatchObject({
      roomId: '1001',
      mode: 'dahua',
      rank: 1,
      scoreChange: 4,
    });
    expect(records[1]?.players.find((player) => player.seat === 1)).toMatchObject({
      nickname: '甲',
      rank: 2,
      scoreChange: 2,
    });
    db.close();
  });
});
