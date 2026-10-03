export type SeatOrder = number[];

export interface ScoreBreakdown {
  changes: number[];
}

const DAHUA_SCORES = [4, 2, -2, -4];

function assertOrder(order: SeatOrder): void {
  if (order.length !== 4 || new Set(order).size !== 4) {
    throw new Error('结算名次必须包含四个不同座位');
  }
}

export function scoreDahua(order: SeatOrder): number[] {
  assertOrder(order);
  const changes = [0, 0, 0, 0];
  order.forEach((seat, index) => {
    changes[seat] = DAHUA_SCORES[index];
  });
  return changes;
}

export function scoreDapengyou(
  order: SeatOrder,
  callerSeat: number,
  teammateSeat: number,
): number[] {
  assertOrder(order);
  if (callerSeat === teammateSeat) {
    throw new Error('2v2 队友不能是叫牌人');
  }

  const team = new Set([callerSeat, teammateSeat]);
  const teamRanks = order
    .map((seat, index) => (team.has(seat) ? index + 1 : 0))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const scoreByRanks: Record<string, number> = {
    '1,2': 4,
    '1,3': 2,
    '1,4': 0,
    '2,3': 0,
    '2,4': -2,
    '3,4': -4,
  };
  const teamScore = scoreByRanks[teamRanks.join(',')];
  if (teamScore === undefined) {
    throw new Error('无法识别的队伍名次组合');
  }

  return [0, 1, 2, 3].map((seat) => {
    const score = team.has(seat) ? teamScore : -teamScore;
    return score === 0 ? 0 : score;
  });
}

export function scoreSolo(callerSeat: number, callerWon: boolean): number[] {
  return [0, 1, 2, 3].map((seat) => {
    if (seat === callerSeat) {
      return callerWon ? 12 : -12;
    }
    return callerWon ? -4 : 4;
  });
}
