import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { GameMode } from './game';

export interface StoredPlayer {
  token: string;
  nickname: string;
  score: number;
}

export interface MatchPlayer extends StoredPlayer {
  seat: number;
}

export interface MatchRecord {
  roomId: string;
  mode: GameMode;
  rankings: number[];
  scoreChanges: number[];
  players: MatchPlayer[];
}

export interface MatchHistoryDetailPlayer {
  seat: number;
  nickname: string;
  rank: number;
  scoreChange: number;
}

export interface MatchHistoryRecord {
  id: number;
  roomId: string;
  mode: GameMode;
  createdAt: string;
  rank: number;
  scoreChange: number;
  rankings: number[];
  scoreChanges: number[];
  players: MatchHistoryDetailPlayer[];
}

interface PlayerRow {
  token: string;
  nickname: string;
  score: number;
}

interface MatchRow {
  id: number;
  room_id: string;
  mode: GameMode;
  rankings_json: string;
  score_changes_json: string;
  players_json: string;
  created_at: string;
}

export class GameDatabase {
  private readonly db: InstanceType<typeof Database>;

  constructor(filePath = path.resolve(process.cwd(), 'data/ffp.db')) {
    if (filePath !== ':memory:') {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new Database(filePath);
    if (filePath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.migrate();
  }

  getOrCreatePlayer(token: string, nickname: string): StoredPlayer {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO players (token, nickname, score, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(token) DO UPDATE SET
        nickname = excluded.nickname,
        updated_at = excluded.updated_at
    `).run(token, nickname, now);

    return this.db.prepare(
      'SELECT token, nickname, score FROM players WHERE token = ?',
    ).get(token) as StoredPlayer;
  }

  recordMatch(record: MatchRecord): StoredPlayer[] {
    const now = new Date().toISOString();
    const updatePlayer = this.db.prepare(`
      INSERT INTO players (token, nickname, score, updated_at)
      VALUES (@token, @nickname, @change, @updatedAt)
      ON CONFLICT(token) DO UPDATE SET
        nickname = excluded.nickname,
        score = players.score + excluded.score,
        updated_at = excluded.updated_at
    `);
    const selectPlayer = this.db.prepare(
      'SELECT token, nickname, score FROM players WHERE token = ?',
    );
    const insertMatch = this.db.prepare(`
      INSERT INTO matches (
        room_id, mode, rankings_json, score_changes_json, players_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      const totals: StoredPlayer[] = [];
      for (const player of record.players) {
        updatePlayer.run({
          token: player.token,
          nickname: player.nickname,
          change: record.scoreChanges[player.seat] ?? 0,
          updatedAt: now,
        });
        totals.push(selectPlayer.get(player.token) as StoredPlayer);
      }
      insertMatch.run(
        record.roomId,
        record.mode,
        JSON.stringify(record.rankings),
        JSON.stringify(record.scoreChanges),
        JSON.stringify(record.players),
        now,
      );
      return totals;
    });

    return transaction();
  }

  leaderboard(limit = 50): StoredPlayer[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.db.prepare(`
      SELECT token, nickname, score
      FROM players
      ORDER BY score DESC, updated_at ASC
      LIMIT ?
    `).all(safeLimit) as StoredPlayer[];
  }

  listMatches(token: string, limit = 30): MatchHistoryRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT
        id, room_id, mode, rankings_json, score_changes_json, players_json, created_at
      FROM matches
      WHERE players_json LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `).all(`%${token}%`, Math.max(50, safeLimit * 5)) as MatchRow[];

    const records: MatchHistoryRecord[] = [];
    for (const row of rows) {
      try {
        const rankings = JSON.parse(row.rankings_json) as number[];
        const scoreChanges = JSON.parse(row.score_changes_json) as number[];
        const players = JSON.parse(row.players_json) as MatchPlayer[];
        const own = players.find((player) => player.token === token);
        if (!own) {
          continue;
        }
        records.push({
          id: row.id,
          roomId: row.room_id,
          mode: row.mode,
          createdAt: row.created_at,
          rank: rankings.indexOf(own.seat) + 1,
          scoreChange: scoreChanges[own.seat] ?? 0,
          rankings,
          scoreChanges,
          players: players.map((player) => ({
            seat: player.seat,
            nickname: player.nickname,
            rank: rankings.indexOf(player.seat) + 1,
            scoreChange: scoreChanges[player.seat] ?? 0,
          })),
        });
      } catch {
        continue;
      }
      if (records.length >= safeLimit) {
        break;
      }
    }
    return records;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        token TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        rankings_json TEXT NOT NULL,
        score_changes_json TEXT NOT NULL,
        players_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_players_score
      ON players(score DESC);
    `);
  }
}
