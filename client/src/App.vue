<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
  ArrowLeft,
  Bot,
  Check,
  Copy,
  History,
  DoorOpen,
  LogIn,
  Play,
  RefreshCw,
  ShieldCheck,
  Trophy,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
  X,
} from '@lucide/vue';
import CardView from './components/CardView.vue';
import PlayerSeat from './components/PlayerSeat.vue';
import { CARD_BACK_FILE, RANK_LABELS, sortCards, SUIT_LABELS } from './cards';
import { socket } from './socket';
import type {
  Card,
  GameMode,
  GameOver,
  LeaderboardPlayer,
  MatchHistory,
  RematchState,
  RoomState,
  TableAction,
  TablePlay,
} from './types';

type Screen = 'home' | 'room' | 'game';
type SeatPosition = 'top' | 'right' | 'left' | 'bottom';
interface ScorePopup {
  seat: number;
  value: number;
  left: number;
  top: number;
}

const screen = ref<Screen>('home');
const connected = ref(socket.connected);
const isTestEntry = window.location.pathname.replace(/\/+$/, '').endsWith('/test');
const nickname = ref(localStorage.getItem('ffp:nickname') ?? '');
const roomIdInput = ref(new URLSearchParams(window.location.search).get('room') ?? '');
const mode = ref<GameMode>('dahua');
const withBots = ref(false);
const room = ref<RoomState | null>(null);
const mySeat = ref<number | null>(null);
const playerToken = ref<string | null>(localStorage.getItem('ffp:playerToken'));
const hand = ref<Card[]>([]);
const selected = ref<Card[]>([]);
const currentTurn = ref<any>(null);
const table = ref<TablePlay | null>(null);
const tableActions = ref<Record<number, TableAction | null>>({});
const canRespond = ref<boolean | null>(null);
const ranks = ref<Record<number, number>>({});
const cardCounts = ref<Record<number, number>>({});
const gameOver = ref<GameOver | null>(null);
const toast = ref('');
const statusMessage = ref('');
const isCalling = ref(false);
const callRank = ref(0);
const callSuit = ref(0);
const calledCard = ref<Card | null>(null);
const callResult = ref<{ callerSeat: number; r: number; s: number } | null>(null);
const calledCardVisible = ref(false);
const callAnnouncement = ref<{ callerSeat: number; card: Card } | null>(null);
const privateTeamReveal = ref<{
  callerSeat: number;
  teammateSeat: number;
  selfCall: boolean;
} | null>(null);
const calledCardPlayedSeat = ref<number | null>(null);
const leaderboard = ref<LeaderboardPlayer[]>([]);
const deadline = ref<{ seat: number; kind: 'call' | 'play'; expiresAt: number } | null>(null);
const now = ref(Date.now());
const busy = ref(false);
const restoring = ref(false);
const feltRef = ref<HTMLElement | null>(null);
const animationLayer = ref<HTMLElement | null>(null);
const playBadge = ref<{ rank: string; type: string } | null>(null);
const playBadgeRef = ref<HTMLElement | null>(null);
const scorePopups = ref<ScorePopup[]>([]);
const scoreOverrides = ref<Record<number, number>>({});
const rematch = ref<RematchState | null>(null);
const resultOverlayVisible = ref(false);
const passingSeats = ref<Set<number>>(new Set());
const roundPlays = ref<TablePlay[]>([]);
const burstPulse = ref(0);
const recordsOpen = ref(false);
const recordsLoading = ref(false);
const matches = ref<MatchHistory[]>([]);
const selectedMatch = ref<MatchHistory | null>(null);
const handCardRefs = new Map<string, HTMLElement>();
const seatRefs = new Map<number, HTMLElement>();
const scorePopupRefs = new Map<number, HTMLElement>();
const tableCardRefs = new Map<number, HTMLElement>();
let toastTimer: number | undefined;
let clockTimer: number | undefined;
let playBadgeTimer: number | undefined;
let burstTimer: number | undefined;
let callAnnouncementTimer: number | undefined;
let playBadgeSequence = 0;
let callAnnouncementSequence = 0;
let settlementSequence = 0;
let dealAnimationArmed = false;
const passTimers = new Map<number, number>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const myPlayer = computed(() => room.value?.players.find((item) => item.seat === mySeat.value));
function relativeSeatPosition(seat: number): SeatPosition {
  if (mySeat.value === null) {
    return 'bottom';
  }
  return (['bottom', 'right', 'top', 'left'][(seat - mySeat.value + 4) % 4]
    ?? 'bottom') as SeatPosition;
}
const opponents = computed(() => {
  if (!room.value || mySeat.value === null) {
    return [];
  }
  const ownSeat = mySeat.value;
  return room.value.players
    .filter((item) => item.seat !== ownSeat)
    .map((player) => ({
      player,
      position: (['right', 'top', 'left'][(player.seat - ownSeat + 3) % 4] ?? 'top') as SeatPosition,
    }));
});
const topOpponent = computed(() => opponents.value.find((item) => item.position === 'top') ?? null);
const leftOpponent = computed(() => opponents.value.find((item) => item.position === 'left') ?? null);
const rightOpponent = computed(() => opponents.value.find((item) => item.position === 'right') ?? null);
const isMyTurn = computed(() => currentTurn.value?.seat === mySeat.value);
const canPass = computed(() => isMyTurn.value && Boolean(table.value));
const canPlay = computed(() => (
  isMyTurn.value
  && canRespond.value !== false
  && selected.value.length > 0
));
const myRematchVoted = computed(() => mySeat.value !== null
  && Boolean(rematch.value?.votes.includes(mySeat.value)));
const rematchCount = computed(() => rematch.value?.count ?? 0);
const tableActionSeats = computed(() => [0, 1, 2, 3].map((seat) => ({
  seat,
  action: tableActions.value[seat] ?? null,
})));
const hasTableActions = computed(() => tableActionSeats.value.some((item) => item.action));
const revealedTeam = computed(() => {
  if (
    calledCardPlayedSeat.value !== null
    && callResult.value
  ) {
    return {
      callerSeat: callResult.value.callerSeat,
      teammateSeat: calledCardPlayedSeat.value,
      selfCall: calledCardPlayedSeat.value === callResult.value.callerSeat,
    };
  }
  if (privateTeamReveal.value && calledCardVisible.value) {
    return privateTeamReveal.value;
  }
  return null;
});
const deadlineSeconds = computed(() => deadline.value
  ? Math.max(0, Math.ceil((deadline.value.expiresAt - now.value) / 1000))
  : 0);
const allReady = computed(() => room.value?.players.length === 4
  && room.value.players.every((player) => player.ready));
const roomLink = computed(() => {
  if (!room.value) {
    return '';
  }
  const url = new URL(window.location.href);
  url.searchParams.set('room', room.value.roomId);
  return url.toString();
});

function showToast(message: string): void {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = '';
  }, 2600);
}

function resolveElement(value: unknown): HTMLElement | null {
  if (value instanceof HTMLElement) {
    return value;
  }
  const element = (value as { $el?: unknown } | null)?.$el;
  return element instanceof HTMLElement ? element : null;
}

function cardKey(card: Card): string {
  return `${card.r}:${card.s}`;
}

function cardGlyphName(card: Card): string {
  return `${SUIT_LABELS[card.s]}${RANK_LABELS[card.r]}`;
}

function setHandCardRef(card: Card, value: unknown): void {
  const element = resolveElement(value);
  if (element) {
    handCardRefs.set(cardKey(card), element);
  } else {
    handCardRefs.delete(cardKey(card));
  }
}

function setSeatRef(seat: number, value: unknown): void {
  const element = resolveElement(value);
  if (element) {
    seatRefs.set(seat, element);
  } else {
    seatRefs.delete(seat);
  }
}

function setScorePopupRef(seat: number, value: unknown): void {
  const element = resolveElement(value);
  if (element) {
    scorePopupRefs.set(seat, element);
  } else {
    scorePopupRefs.delete(seat);
  }
}

function setTableCardRef(index: number, value: unknown): void {
  const element = resolveElement(value);
  if (element) {
    tableCardRefs.set(index, element);
  } else {
    tableCardRefs.delete(index);
  }
}

function isCurrentTablePlay(play: TablePlay): boolean {
  return Boolean(
    table.value
    && table.value.seat === play.seat
    && playSignature(table.value) === playSignature(play),
  );
}

function setActionCardRef(play: TablePlay, index: number, value: unknown): void {
  if (isCurrentTablePlay(play)) {
    setTableCardRef(index, value);
  }
}

function setActionPlayCardRef(
  action: TableAction | null,
  index: number,
  value: unknown,
): void {
  if (!action) {
    return;
  }
  const play = tablePlayFromAction(action);
  if (play) {
    setActionCardRef(play, index, value);
  }
}

function captureHandRects(): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const [key, element] of handCardRefs) {
    rects.set(key, element.getBoundingClientRect());
  }
  return rects;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRange(seed: string, min: number, max: number): number {
  const unit = hashString(seed) / 4294967295;
  return min + unit * (max - min);
}

function discardAngle(card: Card | undefined, index: number, seed = ''): number {
  if (!card) {
    return (index % 2 === 0 ? -1 : 1) * (3 + index);
  }
  return seededRange(`${seed}:${cardKey(card)}:${index}:angle`, -10, 10);
}

function tableCardStyle(
  index: number,
  _card?: Card,
): Record<string, string | number> {
  return {
    zIndex: index + 1,
  };
}

function playSignature(play: TablePlay): string {
  return `${play.seat}:${play.cards.map(cardKey).join('|')}`;
}

function setTablePlay(next: TablePlay | null): void {
  table.value = next;
  if (!next) {
    roundPlays.value = [];
    return;
  }
  const current = roundPlays.value.at(-1);
  if (!current || playSignature(current) !== playSignature(next)) {
    roundPlays.value = [...roundPlays.value, next];
  }
}

function cubicBezierPoint(
  start: number,
  controlA: number,
  controlB: number,
  end: number,
  progress: number,
): number {
  const inverse = 1 - progress;
  return inverse ** 3 * start
    + 3 * inverse ** 2 * progress * controlA
    + 3 * inverse * progress ** 2 * controlB
    + progress ** 3 * end;
}

function easeOutBack(progress: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (progress - 1) ** 3 + c1 * (progress - 1) ** 2;
}

async function animateHandReorder(previousRects: Map<string, DOMRect>): Promise<void> {
  if (reducedMotion.matches || previousRects.size === 0) {
    return;
  }
  await nextTick();
  for (const card of hand.value) {
    const element = handCardRefs.get(cardKey(card));
    const previous = previousRects.get(cardKey(card));
    if (!element || !previous) {
      continue;
    }
    const current = element.getBoundingClientRect();
    const deltaX = previous.left - current.left;
    const deltaY = previous.top - current.top;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
      continue;
    }
    element.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: 'translate(0, 0)' },
      ],
      {
        duration: 250,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    );
  }
}

async function animatePlay(
  payload: TablePlay,
  sourceRects: Array<DOMRect | undefined>,
): Promise<void> {
  await nextTick();
  const targets = payload.cards
    .map((_, index) => tableCardRefs.get(index))
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
  if (targets.length === 0) {
    return;
  }

  if (reducedMotion.matches || !animationLayer.value) {
    targets.forEach((element) => {
      element.style.opacity = '';
    });
    return;
  }

  const fallbackRect = seatRefs.get(payload.seat)?.getBoundingClientRect()
    ?? feltRef.value?.getBoundingClientRect();
  const animations: Animation[] = [];

  targets.forEach((target, index) => {
    const targetRect = target.getBoundingClientRect();
    const targetWidth = target.offsetWidth;
    const targetHeight = target.offsetHeight;
    const source = sourceRects[index] ?? fallbackRect;
    if (!source) {
      return;
    }
    const clone = target.cloneNode(true) as HTMLElement;
    clone.classList.remove('selected', 'disabled');
    clone.classList.add('flight-card');
    clone.removeAttribute('disabled');
    Object.assign(clone.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${targetWidth}px`,
      height: `${targetHeight}px`,
      margin: '0',
      opacity: '0',
      pointerEvents: 'none',
      transformOrigin: '50% 50%',
      zIndex: String(80 + index),
    });
    clone.style.transform = '';
    animationLayer.value?.appendChild(clone);
    target.style.opacity = '0';

    const startX = source.left + source.width / 2;
    const startY = source.top + source.height / 2;
    const endX = targetRect.left + targetRect.width / 2;
    const endY = targetRect.top + targetRect.height / 2;
    const startRotation = index % 2 === 0 ? -8 : 8;
    const endRotation = discardAngle(payload.cards[index], index, `play-${payload.seat}`);
    const deltaX = endX - startX;
    const controlAX = startX + deltaX * 0.18;
    const controlAY = startY - Math.min(118, 58 + Math.abs(deltaX) * 0.13);
    const controlBX = startX + deltaX * 0.76;
    const controlBY = endY - Math.min(126, 54 + Math.abs(deltaX) * 0.17);
    const frame = (x: number, y: number, scale: number, rotation: number) => (
      `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`
    );
    const pathFrames = Array.from({ length: 19 }, (_, frameIndex) => {
      const rawProgress = frameIndex / 18;
      const easedProgress = easeOutBack(rawProgress);
      const x = cubicBezierPoint(startX, controlAX, controlBX, endX, easedProgress);
      const y = cubicBezierPoint(startY, controlAY, controlBY, endY, easedProgress);
      const arcLift = Math.sin(Math.PI * rawProgress);
      const rotation = startRotation
        + (endRotation - startRotation) * Math.min(1, rawProgress * 1.16)
        + Math.sin(Math.PI * rawProgress) * (index % 2 === 0 ? -7 : 7);
      const scale = 0.78 + arcLift * 0.39 + rawProgress * 0.12;
      return {
        transform: frame(x, y, scale, rotation),
        opacity: rawProgress < 0.08 ? rawProgress / 0.08 : 1,
        offset: rawProgress,
      };
    });
    pathFrames[pathFrames.length - 1] = {
      ...pathFrames[pathFrames.length - 1],
      transform: frame(endX, endY, 1, endRotation),
      opacity: 1,
    };

    const animation = clone.animate(
      pathFrames,
      {
        duration: 560,
        delay: index * 46,
        easing: 'linear',
        fill: 'forwards',
      },
    );
    animations.push(animation);
    void animation.finished.catch(() => undefined).finally(() => {
      clone.remove();
    });
  });

  await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  targets.forEach((element) => {
    element.style.opacity = '';
  });
}

function createFlightBack(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'flight-card flight-card-back';
  const image = document.createElement('img');
  image.src = CARD_BACK_FILE;
  image.alt = '';
  image.draggable = false;
  element.appendChild(image);
  return element;
}

async function animateDeal(): Promise<void> {
  await nextTick();
  const center = feltRef.value?.getBoundingClientRect();
  if (!center || !animationLayer.value) {
    return;
  }

  if (reducedMotion.matches) {
    return;
  }

  const centerX = center.left + center.width / 2;
  const centerY = center.top + center.height / 2;

  hand.value.forEach((card, index) => {
    const element = handCardRefs.get(cardKey(card));
    if (!element) {
      return;
    }
    const target = element.getBoundingClientRect();
    const deltaX = centerX - (target.left + target.width / 2);
    const deltaY = centerY - (target.top + target.height / 2);
    element.animate(
      [
        {
          transform: `translate(${deltaX}px, ${deltaY}px) rotate(-12deg) scale(0.55)`,
          opacity: 0,
        },
        { transform: 'translate(0, 0) rotate(0) scale(1)', opacity: 1 },
      ],
      {
        duration: 320,
        delay: index * 60,
        easing: 'cubic-bezier(0.2, 0.85, 0.25, 1)',
        fill: 'backwards',
      },
    );
  });

  opponents.value.forEach((opponent, seatIndex) => {
    const seatRect = seatRefs.get(opponent.player.seat)?.getBoundingClientRect();
    if (!seatRect) {
      return;
    }
    const endX = seatRect.left + seatRect.width / 2;
    const endY = seatRect.top + seatRect.height / 2;
    for (let index = 0; index < 13; index += 1) {
      const element = createFlightBack();
      animationLayer.value?.appendChild(element);
      const animation = element.animate(
        [
          { transform: `translate(${centerX}px, ${centerY}px) scale(0.65)`, opacity: 0 },
          { transform: `translate(${endX}px, ${endY}px) scale(0.82)`, opacity: 1 },
        ],
        {
          duration: 330,
          delay: index * 60 + seatIndex * 90,
          easing: 'cubic-bezier(0.2, 0.8, 0.25, 1)',
          fill: 'forwards',
        },
      );
      void animation.finished.catch(() => undefined).finally(() => element.remove());
    }
  });
}

async function showPlayBadge(payload: TablePlay): Promise<void> {
  const sequence = ++playBadgeSequence;
  window.clearTimeout(playBadgeTimer);
  window.clearTimeout(burstTimer);
  const typeLabels: Record<string, string> = {
    SINGLE: '单张',
    PAIR: '对子',
    TRIPLE: '三张',
    FULL_HOUSE: '三带二',
    FOUR: '四张',
    FOUR_WITH_ONE: '四带一',
    STRAIGHT: '顺子',
    FLUSH: '同花',
    STRAIGHT_FLUSH: '同花顺',
  };
  const highest = [...payload.cards].sort((a, b) => b.r - a.r || b.s - a.s)[0];
  playBadge.value = {
    rank: highest ? RANK_LABELS[highest.r] : '',
    type: typeLabels[payload.type] ?? payload.type,
  };
  burstPulse.value += 1;
  burstTimer = window.setTimeout(() => {
    if (sequence === playBadgeSequence) {
      burstPulse.value = 0;
    }
  }, 900);
  await nextTick();
  const element = playBadgeRef.value;
  if (!element || reducedMotion.matches) {
    playBadgeTimer = window.setTimeout(() => {
      if (sequence === playBadgeSequence) {
        playBadge.value = null;
      }
    }, 650);
    return;
  }
  await element.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.5)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1.3)', opacity: 1, offset: 0.32 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.62 },
      { transform: 'translate(-50%, -50%) scale(1.04)', opacity: 0 },
    ],
    {
      duration: 820,
      easing: 'cubic-bezier(0.18, 0.9, 0.24, 1)',
    },
  ).finished.catch(() => undefined);
  if (sequence === playBadgeSequence) {
    playBadge.value = null;
  }
}

function showPassBubble(seat: number): void {
  const next = new Set(passingSeats.value);
  next.add(seat);
  passingSeats.value = next;
  window.clearTimeout(passTimers.get(seat));
  passTimers.set(seat, window.setTimeout(() => {
    const current = new Set(passingSeats.value);
    current.delete(seat);
    passingSeats.value = current;
  }, 760));
}

function showCallAnnouncement(payload: { callerSeat: number; r: number; s: number }): void {
  const sequence = ++callAnnouncementSequence;
  window.clearTimeout(callAnnouncementTimer);
  const card = { r: payload.r, s: payload.s };
  callAnnouncement.value = { callerSeat: payload.callerSeat, card };
  callAnnouncementTimer = window.setTimeout(() => {
    if (sequence !== callAnnouncementSequence) {
      return;
    }
    callAnnouncement.value = null;
    calledCardVisible.value = true;
  }, 2500);
}

function setTableActions(payload: unknown): void {
  if (!Array.isArray(payload)) {
    return;
  }
  const next: Record<number, TableAction | null> = {};
  for (const item of payload as Array<TableAction | null>) {
    if (item && Number.isInteger(item.seat)) {
      next[item.seat] = item;
    }
  }
  tableActions.value = next;
}

function tablePlayFromAction(action: TableAction): TablePlay | null {
  if (action.kind !== 'play' || !action.type) {
    return null;
  }
  return {
    seat: action.seat,
    cards: action.cards,
    type: action.type,
  };
}

function teamRoleForSeat(seat: number): 'friend' | 'enemy' | undefined {
  const reveal = revealedTeam.value;
  if (!reveal) {
    return undefined;
  }
  if (reveal.selfCall) {
    return seat === reveal.callerSeat ? 'friend' : 'enemy';
  }
  return seat === reveal.callerSeat || seat === reveal.teammateSeat
    ? 'friend'
    : 'enemy';
}

function scoreEntries(payload: GameOver): Array<{ seat: number; value: number }> {
  if (payload.scoreChanges) {
    return [0, 1, 2, 3].map((seat) => ({
      seat,
      value: payload.scoreChanges?.[seat] ?? 0,
    }));
  }
  if (payload.yourSeat !== undefined) {
    return [{ seat: payload.yourSeat, value: payload.yourScoreChange ?? 0 }];
  }
  return [];
}

function scorePopupPoint(seat: number): { left: number; top: number } {
  const rect = seatRefs.get(seat)?.getBoundingClientRect();
  if (!rect) {
    return {
      left: window.innerWidth / 2,
      top: window.innerHeight * 0.42,
    };
  }

  const position = relativeSeatPosition(seat);
  const left = position === 'right' ? rect.left - 12 : rect.right + 12;
  const top = rect.top + rect.height / 2;
  return {
    left: Math.min(window.innerWidth - 42, Math.max(42, left)),
    top: Math.min(window.innerHeight - 30, Math.max(30, top)),
  };
}

function applySettlementScores(payload: GameOver): void {
  const entries = payload.totals?.map((item) => [item.seat, item.score] as const) ?? [];
  if (entries.length > 0) {
    scoreOverrides.value = Object.fromEntries(entries);
  } else if (payload.yourSeat !== undefined && payload.yourTotal !== undefined) {
    scoreOverrides.value = { [payload.yourSeat]: payload.yourTotal };
  }
}

async function animateSettlement(payload: GameOver): Promise<void> {
  const sequence = ++settlementSequence;
  resultOverlayVisible.value = false;
  const entries = scoreEntries(payload);
  if (reducedMotion.matches || entries.length === 0) {
    applySettlementScores(payload);
    resultOverlayVisible.value = true;
    return;
  }

  scorePopups.value = entries.map((entry) => ({
    ...entry,
    ...scorePopupPoint(entry.seat),
  }));
  await nextTick();

  const animations = scorePopups.value.map((entry) => {
    const element = scorePopupRefs.get(entry.seat);
    if (!element) {
      return Promise.resolve();
    }
    return element.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.32)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.24)', opacity: 1, offset: 0.18 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.3 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.88 },
        { transform: 'translate(-50%, -50%) scale(1.08)', opacity: 0 },
      ],
      {
        duration: 1700,
        easing: 'cubic-bezier(0.18, 0.9, 0.22, 1)',
        fill: 'forwards',
      },
    ).finished.catch(() => undefined);
  });
  await Promise.all(animations);

  if (sequence !== settlementSequence) {
    return;
  }
  scorePopups.value = [];
  applySettlementScores(payload);
  resultOverlayVisible.value = true;
}

function resetGameDisplay(): void {
  playBadgeSequence += 1;
  callAnnouncementSequence += 1;
  settlementSequence += 1;
  window.clearTimeout(playBadgeTimer);
  window.clearTimeout(burstTimer);
  window.clearTimeout(callAnnouncementTimer);
  for (const timer of passTimers.values()) {
    window.clearTimeout(timer);
  }
  passTimers.clear();
  passingSeats.value = new Set();
  handCardRefs.clear();
  tableCardRefs.clear();
  scorePopupRefs.clear();
  playBadge.value = null;
  callAnnouncement.value = null;
  calledCardVisible.value = false;
  privateTeamReveal.value = null;
  calledCardPlayedSeat.value = null;
  burstPulse.value = 0;
  tableActions.value = {};
  canRespond.value = null;
  roundPlays.value = [];
  scorePopups.value = [];
  scoreOverrides.value = {};
  rematch.value = null;
  resultOverlayVisible.value = false;
}

async function handlePlay(payload: TablePlay & { remaining: number }): Promise<void> {
  const previousRects = captureHandRects();
  const sourceRects = payload.cards.map((card) => previousRects.get(cardKey(card)));
  const ownPlay = payload.seat === mySeat.value;

  setTablePlay(payload);
  tableActions.value = {
    ...tableActions.value,
    [payload.seat]: {
      seat: payload.seat,
      kind: 'play',
      cards: payload.cards.map((card) => ({ ...card })),
      type: payload.type,
    },
  };
  if (
    calledCard.value
    && payload.cards.some((card) => (
      card.r === calledCard.value?.r && card.s === calledCard.value?.s
    ))
  ) {
    calledCardPlayedSeat.value = payload.seat;
  }
  cardCounts.value[payload.seat] = payload.remaining;
  statusMessage.value = `${playerName(payload.seat)} 出牌`;

  if (ownPlay) {
    const playedKeys = new Set(payload.cards.map(cardKey));
    hand.value = hand.value.filter((card) => !playedKeys.has(cardKey(card)));
    selected.value = [];
  }

  void showPlayBadge(payload);
  const tasks = [animatePlay(payload, sourceRects)];
  if (ownPlay) {
    tasks.push(animateHandReorder(previousRects));
  }
  await Promise.all(tasks);
}

function ack(event: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      resolve({ ok: false, error: '服务器响应超时', transient: true });
    }, 5000);
    socket.emit(event, payload, (response: Record<string, any>) => {
      window.clearTimeout(timer);
      resolve(response);
    });
  });
}

async function createRoom(): Promise<void> {
  if (!nickname.value.trim()) {
    showToast('请输入昵称');
    return;
  }
  busy.value = true;
  localStorage.setItem('ffp:nickname', nickname.value.trim());
  const response = await ack('room:create', {
    nickname: nickname.value.trim(),
    mode: mode.value,
    playerToken: playerToken.value ?? undefined,
    withBots: isTestEntry && withBots.value,
  });
  busy.value = false;
  if (!response.ok) {
    showToast(response.error ?? '建房失败');
    return;
  }
  applySession(response);
}

async function joinRoom(): Promise<void> {
  if (!nickname.value.trim() || !roomIdInput.value.trim()) {
    showToast('请输入昵称和房号');
    return;
  }
  busy.value = true;
  localStorage.setItem('ffp:nickname', nickname.value.trim());
  const response = await ack('room:join', {
    nickname: nickname.value.trim(),
    roomId: roomIdInput.value.trim(),
    playerToken: playerToken.value ?? undefined,
  });
  busy.value = false;
  if (!response.ok) {
    showToast(response.error ?? '加入失败');
    return;
  }
  applySession(response);
}

function applySession(response: Record<string, any>): void {
  mySeat.value = response.seat;
  playerToken.value = response.playerToken;
  roomIdInput.value = response.roomId;
  localStorage.setItem('ffp:playerToken', response.playerToken);
  localStorage.setItem('ffp:roomId', response.roomId);
  screen.value = room.value && room.value.phase !== 'waiting' ? 'game' : 'room';
}

async function toggleReady(): Promise<void> {
  const response = await ack('room:ready', {});
  if (!response.ok) {
    showToast(response.error ?? '准备失败');
  }
}

function toggleCard(card: Card): void {
  if (isMyTurn.value && canRespond.value === false) {
    return;
  }
  const exists = selected.value.some((item) => item.r === card.r && item.s === card.s);
  selected.value = exists
    ? selected.value.filter((item) => item.r !== card.r || item.s !== card.s)
    : [...selected.value, card];
}

function activateCard(card: Card): void {
  toggleCard(card);
}

function isSelected(card: Card): boolean {
  return selected.value.some((item) => item.r === card.r && item.s === card.s);
}

async function playSelected(): Promise<void> {
  if (!canPlay.value) {
    return;
  }
  const response = await ack('game:play', { cards: selected.value });
  if (!response.ok) {
    selected.value = [];
    showToast(response.error ?? '出牌不合法');
  }
}

async function submitCall(): Promise<void> {
  const response = await ack('game:call', { r: callRank.value, s: callSuit.value });
  if (!response.ok) {
    showToast(response.error ?? '叫牌失败');
  }
}

async function passTurn(): Promise<void> {
  if (!canPass.value) {
    return;
  }
  const response = await ack('game:pass', {});
  if (!response.ok) {
    showToast(response.error ?? 'pass 失败');
  }
}

async function addBot(): Promise<void> {
  const response = await ack('room:add-bot', {});
  if (!response.ok) {
    showToast(response.error ?? '添加机器人失败');
  }
}

async function copyRoomLink(): Promise<void> {
  await navigator.clipboard.writeText(roomLink.value);
  showToast('房间链接已复制');
}

async function openRecords(): Promise<void> {
  recordsOpen.value = true;
  selectedMatch.value = null;
  recordsLoading.value = true;
  try {
    const token = playerToken.value ?? '';
    const response = await fetch(`/api/matches?token=${encodeURIComponent(token)}`);
    const payload = await response.json();
    matches.value = payload.ok && Array.isArray(payload.matches)
      ? payload.matches as MatchHistory[]
      : [];
  } catch {
    matches.value = [];
    showToast('对局记录加载失败');
  } finally {
    recordsLoading.value = false;
  }
}

function closeRecords(): void {
  recordsOpen.value = false;
  selectedMatch.value = null;
}

function formatMatchTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

async function toggleRematch(): Promise<void> {
  const response = await ack('game:rematch', {
    vote: !myRematchVoted.value,
  });
  if (!response.ok) {
    showToast(response.error ?? '操作失败');
    return;
  }
  if (!gameOver.value) {
    return;
  }
  rematch.value = {
    votes: response.votes ?? [],
    count: response.count ?? 0,
    total: response.total ?? 4,
    expiresAt: response.expiresAt ?? null,
  };
}

async function restoreSession(): Promise<void> {
  const storedRoomId = localStorage.getItem('ffp:roomId');
  if (restoring.value || !playerToken.value || !storedRoomId) {
    return;
  }
  restoring.value = true;
  const response = await ack('room:join', {
    roomId: storedRoomId,
    nickname: nickname.value || '玩家',
    playerToken: playerToken.value,
  });
  restoring.value = false;
  if (!response.ok) {
    if (!response.transient) {
      localStorage.removeItem('ffp:roomId');
      room.value = null;
      mySeat.value = null;
      hand.value = [];
      table.value = null;
      currentTurn.value = null;
      screen.value = 'home';
      showToast('原房间已失效，请重新加入');
    } else {
      showToast('连接中断，正在重试');
    }
    return;
  }
  applySession(response);
}

function resumeConnection(): void {
  if (navigator.onLine === false) {
    return;
  }
  if (!socket.connected) {
    socket.connect();
    return;
  }
  void restoreSession();
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    resumeConnection();
  }
}

async function loadLeaderboard(): Promise<void> {
  try {
    const response = await fetch('/api/leaderboard');
    const payload = await response.json();
    if (payload.ok) {
      leaderboard.value = payload.players.slice(0, 6);
    }
  } catch {
    leaderboard.value = [];
  }
}

async function leaveRoom(): Promise<void> {
  if (room.value) {
    await ack('room:leave', {});
  }
  localStorage.removeItem('ffp:roomId');
  window.location.href = window.location.pathname;
}

function playerName(seat: number): string {
  return room.value?.players.find((item) => item.seat === seat)?.nickname ?? `座位${seat + 1}`;
}

function remainingSecondsFor(seat: number): number | undefined {
  if (
    seat !== mySeat.value
    || deadline.value?.kind !== 'play'
    || deadline.value.seat !== seat
  ) {
    return undefined;
  }
  return deadlineSeconds.value;
}

function visibleScore(seat: number): number {
  const override = scoreOverrides.value[seat];
  if (override !== undefined) {
    return override;
  }
  return room.value?.players.find((item) => item.seat === seat)?.score ?? 0;
}

function scoreChange(seat: number): number | null {
  if (gameOver.value?.scoreChanges) {
    return gameOver.value.scoreChanges[seat] ?? 0;
  }
  if (seat === mySeat.value) {
    return gameOver.value?.yourScoreChange ?? null;
  }
  return null;
}

function totalScore(seat: number): number | null {
  const total = gameOver.value?.totals?.find((item) => item.seat === seat);
  if (total) {
    return total.score;
  }
  if (seat === mySeat.value) {
    return gameOver.value?.yourTotal ?? myPlayer.value?.score ?? null;
  }
  return room.value?.players.find((item) => item.seat === seat)?.score ?? null;
}

onMounted(() => {
  socket.on('connect', () => {
    connected.value = true;
    void restoreSession();
  });
  socket.on('disconnect', () => {
    connected.value = false;
  });
  socket.on('room:state', (payload: RoomState) => {
    if (
      payload.phase === 'over'
      && room.value?.phase !== 'over'
      && !gameOver.value
      && room.value
    ) {
      scoreOverrides.value = Object.fromEntries(
        room.value.players.map((player) => [player.seat, player.score]),
      );
    }
    room.value = payload;
    if (payload.phase === 'waiting' && !gameOver.value) {
      screen.value = 'room';
    } else if ((payload.phase === 'calling' || payload.phase === 'playing') && !gameOver.value) {
      screen.value = 'game';
    }
  });
  socket.on('game:start', () => {
    resetGameDisplay();
    gameOver.value = null;
    isCalling.value = false;
    calledCard.value = null;
    callResult.value = null;
    ranks.value = {};
    hand.value = [];
    selected.value = [];
    setTablePlay(null);
    cardCounts.value = Object.fromEntries([0, 1, 2, 3].map((seat) => [seat, 13]));
    deadline.value = null;
    screen.value = 'game';
    dealAnimationArmed = true;
  });
  socket.on('game:deal', (payload: { cards: Card[] }) => {
    hand.value = sortCards(payload.cards);
    if (dealAnimationArmed) {
      dealAnimationArmed = false;
      void animateDeal();
    }
  });
  socket.on('game:call-request', () => {
    isCalling.value = true;
    statusMessage.value = '请选择叫牌';
  });
  socket.on('game:call-result', (payload: {
    callerSeat: number;
    r: number;
    s: number;
    replay?: boolean;
  }) => {
    isCalling.value = false;
    callResult.value = {
      callerSeat: payload.callerSeat,
      r: payload.r,
      s: payload.s,
    };
    calledCard.value = { r: payload.r, s: payload.s };
    statusMessage.value = `${playerName(payload.callerSeat)} 叫了 ${cardGlyphName(calledCard.value)}`;
    if (payload.replay) {
      calledCardVisible.value = true;
      callAnnouncement.value = null;
    } else {
      showCallAnnouncement(payload);
    }
  });
  socket.on('game:team-reveal', (payload: {
    callerSeat: number;
    teammateSeat: number;
    selfCall: boolean;
    replay?: boolean;
  }) => {
    privateTeamReveal.value = {
      callerSeat: payload.callerSeat,
      teammateSeat: payload.teammateSeat,
      selfCall: payload.selfCall,
    };
    if (payload.replay) {
      calledCardVisible.value = true;
      callAnnouncement.value = null;
    }
  });
  socket.on('game:turn', (payload: any) => {
    currentTurn.value = payload;
    if (Array.isArray(payload.roundPlays)) {
      table.value = payload.table ?? null;
      roundPlays.value = payload.roundPlays;
    } else {
      setTablePlay(payload.table ?? null);
    }
    setTableActions(payload.tableActions);
    if (payload.seat === mySeat.value) {
      canRespond.value = null;
    } else {
      canRespond.value = null;
    }
    if (Array.isArray(payload.cardCounts)) {
      cardCounts.value = Object.fromEntries(
        payload.cardCounts.map((count: number, seat: number) => [seat, count]),
      );
    }
    statusMessage.value = payload.isLead ? '重新领出' : '';
  });
  socket.on('game:turn-control', (payload: {
    seat: number;
    canRespond: boolean;
  }) => {
    if (payload.seat === mySeat.value) {
      canRespond.value = payload.canRespond;
    }
  });
  socket.on('game:deadline', (payload: { seat: number; kind: 'call' | 'play'; expiresAt: number }) => {
    deadline.value = payload;
    now.value = Date.now();
  });
  socket.on('game:play', (payload: TablePlay & { remaining: number }) => {
    void handlePlay(payload);
  });
  socket.on('game:pass', (payload: { seat: number }) => {
    tableActions.value = {
      ...tableActions.value,
      [payload.seat]: {
        seat: payload.seat,
        kind: 'pass',
        cards: [],
        type: null,
      },
    };
    statusMessage.value = `${playerName(payload.seat)} 不要`;
    showPassBubble(payload.seat);
  });
  socket.on('game:round-reset', (payload: { seat: number }) => {
    tableCardRefs.clear();
    setTablePlay(null);
    statusMessage.value = `${playerName(payload.seat)} 重新领出`;
  });
  socket.on('game:rank', (payload: { seat: number; rank: number }) => {
    ranks.value[payload.seat] = payload.rank;
  });
  socket.on('game:over', (payload: GameOver) => {
    gameOver.value = payload;
    rematch.value = null;
    deadline.value = null;
    if (room.value && payload.totals) {
      const totals = payload.totals;
      room.value = {
        ...room.value,
        players: room.value.players.map((player) => ({
          ...player,
          score: totals.find((item) => item.seat === player.seat)?.score ?? player.score,
        })),
      };
    } else if (room.value && payload.yourTotal !== undefined && mySeat.value !== null) {
      room.value = {
        ...room.value,
        players: room.value.players.map((player) => (
          player.seat === mySeat.value
            ? { ...player, score: payload.yourTotal as number }
            : player
        )),
      };
    }
    screen.value = 'game';
    void animateSettlement(payload);
    void loadLeaderboard();
  });
  socket.on('game:rematch-state', (payload: RematchState) => {
    rematch.value = payload;
  });
  socket.on('game:rematch-cancelled', (payload: { message?: string }) => {
    rematch.value = null;
    if (payload.message) {
      showToast(payload.message);
    }
  });
  socket.on('game:error', (payload: { message?: string }) => {
    showToast(payload.message ?? '操作失败');
  });
  clockTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 500);
  window.addEventListener('online', resumeConnection);
  window.addEventListener('focus', resumeConnection);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void restoreSession();
  void loadLeaderboard();
});

onUnmounted(() => {
  window.clearInterval(clockTimer);
  window.clearTimeout(playBadgeTimer);
  window.clearTimeout(burstTimer);
  window.clearTimeout(callAnnouncementTimer);
  for (const timer of passTimers.values()) {
    window.clearTimeout(timer);
  }
  window.removeEventListener('online', resumeConnection);
  window.removeEventListener('focus', resumeConnection);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  socket.removeAllListeners();
});
</script>

<template>
  <div class="app-shell" :class="{ 'game-shell': screen === 'game' }">
    <header v-if="screen !== 'game'" class="topbar">
      <div class="brand">
        <span class="brand-mark">花</span>
        <div>
          <strong>打花</strong>
          <small>打朋友</small>
        </div>
      </div>
      <span class="connection" :class="{ online: connected }">
        <Wifi v-if="connected" :size="15" />
        <WifiOff v-else :size="15" />
        {{ connected ? '已连接' : '连接中' }}
      </span>
    </header>

    <div v-if="!connected && screen !== 'home'" class="reconnect-banner">
      <WifiOff :size="16" />
      <span>连接中断，正在重连</span>
      <button type="button" @click="resumeConnection">重试</button>
    </div>

    <main v-if="screen === 'home'" class="home">
      <div class="home-stack">
      <section class="entry-panel">
        <div class="entry-heading">
          <span class="entry-kicker">四人牌局</span>
          <h1>坐下来，开一局</h1>
        </div>
        <label class="field">
          <span>昵称</span>
          <input v-model="nickname" maxlength="12" placeholder="怎么称呼你" autocomplete="nickname" />
        </label>
        <div class="mode-picker" aria-label="玩法">
          <button type="button" :class="{ active: mode === 'dahua' }" @click="mode = 'dahua'">
            <ShieldCheck :size="17" />
            打花
          </button>
          <button
            type="button"
            :class="{ active: mode === 'dapengyou' }"
            @click="mode = 'dapengyou'"
          >
            <Users :size="17" />
            打朋友
          </button>
        </div>
        <label v-if="isTestEntry" class="test-toggle">
          <input v-model="withBots" type="checkbox" />
          <span>
            <strong>加入 3 个机器人</strong>
            <small>仅测试端创建房间时可用</small>
          </span>
        </label>
        <button type="button" class="primary-button" :disabled="busy" @click="createRoom">
          <Users :size="18" />
          创建房间
        </button>
        <div class="divider"><span>或加入好友房</span></div>
        <div class="join-row">
          <label class="field room-code">
            <span>房号</span>
            <input v-model="roomIdInput" inputmode="numeric" maxlength="4" placeholder="4 位房号" />
          </label>
          <button type="button" class="secondary-button" :disabled="busy" @click="joinRoom">
            <LogIn :size="18" />
            加入
          </button>
        </div>
      </section>
      <section v-if="leaderboard.length" class="leaderboard-panel">
        <div class="leaderboard-heading">
          <span><Trophy :size="16" /> 积分榜</span>
          <button type="button" aria-label="刷新积分榜" @click="loadLeaderboard">
            <RefreshCw :size="15" />
          </button>
        </div>
        <div
          v-for="(player, index) in leaderboard"
          :key="player.token"
          class="leaderboard-row"
        >
          <span class="leaderboard-rank">{{ index + 1 }}</span>
          <strong>{{ player.nickname }}</strong>
          <span :class="{ positive: player.score > 0, negative: player.score < 0 }">
            {{ player.score > 0 ? '+' : '' }}{{ player.score }}
          </span>
        </div>
      </section>
      </div>
    </main>

    <main v-else-if="screen === 'room'" class="waiting">
      <div class="section-heading">
        <button type="button" class="icon-button" aria-label="返回" @click="leaveRoom">
          <ArrowLeft :size="19" />
        </button>
        <div>
          <small>房间</small>
          <h1>{{ room?.roomId }}</h1>
        </div>
        <button type="button" class="icon-button" aria-label="复制房间链接" @click="copyRoomLink">
          <Copy :size="19" />
        </button>
      </div>

      <section class="room-card">
        <div class="room-meta">
          <span>{{ room?.mode === 'dahua' ? '打花' : '打朋友' }}</span>
          <span>{{ room?.players.length ?? 0 }}/4 人</span>
          <span v-if="room?.kind === 'test'" class="test-room-badge">测试中</span>
        </div>
        <div class="player-list">
          <div
            v-for="seat in [0, 1, 2, 3]"
            :key="seat"
            class="player-row"
            :class="{ occupied: room?.players.some((item) => item.seat === seat) }"
          >
            <span class="seat-number">{{ seat + 1 }}</span>
            <template v-if="room?.players.find((item) => item.seat === seat)">
              <span class="row-name">{{ room.players.find((item) => item.seat === seat)?.nickname }}</span>
              <span
                class="ready-state"
                :class="{ ready: room.players.find((item) => item.seat === seat)?.ready }"
              >
                <Check v-if="room.players.find((item) => item.seat === seat)?.ready" :size="14" />
                {{ room.players.find((item) => item.seat === seat)?.ready ? '已准备' : '未准备' }}
              </span>
            </template>
            <button v-else type="button" class="add-bot-button" @click="addBot">
              <UserPlus :size="14" />
              添加机器人
            </button>
          </div>
        </div>
      </section>

      <button
        type="button"
        class="primary-button ready-button"
        :class="{ prepared: myPlayer?.ready }"
        @click="toggleReady"
      >
        <Check :size="18" />
        {{ myPlayer?.ready ? '取消准备' : '准备' }}
      </button>
      <p class="waiting-note">
        {{ allReady ? '开局中…' : '四人全部准备后自动开始' }}
      </p>
    </main>

    <main v-else class="game-screen">
      <header class="game-header">
        <button type="button" class="icon-button dark" aria-label="返回" @click="leaveRoom">
          <DoorOpen :size="19" />
        </button>
        <div class="game-title">
          <strong>房间 {{ room?.roomId }}</strong>
          <small>
            <span v-if="room?.kind === 'test'" class="test-room-badge">测试中</span>
            {{ statusMessage || '对局进行中' }}
          </small>
        </div>
        <div
          v-if="calledCardVisible && calledCard && callResult"
          class="header-called-card"
        >
          <span class="header-called-label">叫牌</span>
          <strong>{{ playerName(callResult.callerSeat) }} 叫 {{ cardGlyphName(calledCard) }}</strong>
          <CardView
            class="header-called-card-view"
            :card="calledCard"
            size="mini"
          />
        </div>
      </header>

      <section v-if="topOpponent" class="opponent-strip">
        <PlayerSeat
          class="top-opponent-seat"
          :player="topOpponent.player"
          :score="visibleScore(topOpponent.player.seat)"
          :card-count="cardCounts[topOpponent.player.seat] ?? 13"
          :is-current="currentTurn?.seat === topOpponent.player.seat"
          :is-passing="passingSeats.has(topOpponent.player.seat)"
          :rank="ranks[topOpponent.player.seat]"
          :remaining-seconds="remainingSecondsFor(topOpponent.player.seat)"
          :team-role="teamRoleForSeat(topOpponent.player.seat)"
          orientation="top"
          show-card-backs
        />
      </section>

      <section class="table-stage">
        <PlayerSeat
          v-if="leftOpponent"
          class="side-player-panel side-player-panel-left"
          :player="leftOpponent.player"
          :score="visibleScore(leftOpponent.player.seat)"
          :card-count="cardCounts[leftOpponent.player.seat] ?? 13"
          :is-current="currentTurn?.seat === leftOpponent.player.seat"
          :is-passing="passingSeats.has(leftOpponent.player.seat)"
          :rank="ranks[leftOpponent.player.seat]"
          :remaining-seconds="remainingSecondsFor(leftOpponent.player.seat)"
          :team-role="teamRoleForSeat(leftOpponent.player.seat)"
          orientation="left"
          vertical
        />
        <PlayerSeat
          v-if="rightOpponent"
          class="side-player-panel side-player-panel-right"
          :player="rightOpponent.player"
          :score="visibleScore(rightOpponent.player.seat)"
          :card-count="cardCounts[rightOpponent.player.seat] ?? 13"
          :is-current="currentTurn?.seat === rightOpponent.player.seat"
          :is-passing="passingSeats.has(rightOpponent.player.seat)"
          :rank="ranks[rightOpponent.player.seat]"
          :remaining-seconds="remainingSecondsFor(rightOpponent.player.seat)"
          :team-role="teamRoleForSeat(rightOpponent.player.seat)"
          orientation="right"
          vertical
        />
        <div ref="feltRef" class="felt">
          <div class="felt-center">
            <div class="action-slots">
              <div
                v-for="item in tableActionSeats"
                :key="item.seat"
                :ref="(value) => setSeatRef(item.seat, value)"
                class="action-slot"
                :class="`action-slot-${relativeSeatPosition(item.seat)}`"
              >
                <template v-if="item.action">
                  <div
                    v-if="item.action.kind === 'play' && item.action.type"
                    class="action-slot-cards"
                  >
                    <CardView
                      v-for="(card, index) in item.action.cards"
                      :key="`${card.r}-${card.s}`"
                      :ref="(value) => setActionPlayCardRef(item.action, index, value)"
                      :card="card"
                      size="table"
                      :style="tableCardStyle(index, card)"
                    />
                  </div>
                  <span v-else class="action-slot-pass">不要</span>
                </template>
                <span
                  v-else
                  class="action-slot-empty"
                >
                  等待出牌
                </span>
              </div>
            </div>
            <div v-if="!hasTableActions" class="empty-table">
              <span>等待首手</span>
            </div>
          </div>
          <div
            v-if="burstPulse"
            :key="burstPulse"
            class="play-burst"
            aria-hidden="true"
          >
            <span class="burst-flash"></span>
            <span
              v-for="ray in 16"
              :key="`ray-${ray}`"
              class="burst-ray"
              :style="{ '--burst-angle': `${(ray - 1) * 22.5}deg` }"
            ></span>
            <span
              v-for="particle in 12"
              :key="`particle-${particle}`"
              class="burst-particle"
              :style="{
                '--burst-angle': `${(particle - 1) * 30 + 12}deg`,
                '--burst-distance': `${58 + (particle % 4) * 13}px`,
              }"
            ></span>
          </div>
          <div
            v-if="playBadge"
            ref="playBadgeRef"
            class="play-badge"
            aria-live="polite"
          >
            <strong>{{ playBadge.rank }}</strong>
            <span>{{ playBadge.type }}</span>
          </div>
        </div>
      </section>

      <div v-if="myPlayer && mySeat !== null" class="self-controls">
        <div class="self-seat-strip">
          <PlayerSeat
            :ref="(value) => setSeatRef(mySeat as number, value)"
            class="self-seat"
            :player="myPlayer"
            :score="visibleScore(mySeat)"
            :card-count="cardCounts[mySeat] ?? hand.length"
            :is-current="isMyTurn"
            :is-passing="passingSeats.has(mySeat)"
            :rank="ranks[mySeat]"
            :remaining-seconds="remainingSecondsFor(mySeat)"
            :team-role="teamRoleForSeat(mySeat)"
            orientation="bottom"
          />
        </div>
        <div
          v-if="isMyTurn && !isCalling && canRespond !== null"
          class="action-row"
          :class="{ 'single-action': canRespond === false }"
        >
          <template v-if="canRespond === false">
            <button
              type="button"
              class="unable-button"
              :disabled="!canPass"
              @click="passTurn"
            >
              要不起
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="pass-button"
              :disabled="!canPass"
              @click="passTurn"
            >
              不出
            </button>
            <button
              type="button"
              class="play-button"
              :disabled="!canPlay"
              @click="playSelected"
            >
              <Play :size="18" />
              出牌
            </button>
          </template>
        </div>
      </div>

      <section class="hand-zone">
        <div v-if="isCalling" class="call-panel">
          <div class="call-heading">
            <strong>叫一张牌</strong>
            <span>点数与花色{{ deadlineSeconds ? ` · ${deadlineSeconds}s` : '' }}</span>
          </div>
          <div class="rank-picker">
            <button
              v-for="rank in 7"
              :key="rank"
              type="button"
              :class="{ active: callRank === rank - 1 }"
              @click="callRank = rank - 1"
            >
              {{ ['4', '5', '6', '7', '8', '9', '10'][rank - 1] }}
            </button>
          </div>
          <div class="suit-picker">
            <button
              v-for="(suit, index) in SUIT_LABELS"
              :key="suit"
              type="button"
              :class="{ active: callSuit === index, red: index === 0 || index === 2 }"
              @click="callSuit = index"
            >
              {{ suit }}
            </button>
          </div>
          <button type="button" class="primary-button call-submit" @click="submitCall">
            确认叫牌
          </button>
        </div>
        <div class="hand-cards">
          <CardView
            v-for="card in hand"
            :ref="(value) => setHandCardRef(card, value)"
            :key="`${card.r}-${card.s}`"
            :card="card"
            size="hand"
            interactive
            :data-card-key="cardKey(card)"
            :selected="isSelected(card)"
            @select="activateCard(card)"
          />
        </div>
      </section>
    </main>

    <div ref="animationLayer" class="animation-layer" aria-hidden="true"></div>

    <div
      v-for="popup in scorePopups"
      :key="popup.seat"
      :ref="(value) => setScorePopupRef(popup.seat, value)"
      class="score-popup"
      :class="{
        positive: popup.value > 0,
        negative: popup.value < 0,
      }"
      :style="{ left: `${popup.left}px`, top: `${popup.top}px` }"
      aria-live="polite"
    >
      本局 {{ popup.value > 0 ? '+' : '' }}{{ popup.value }}
    </div>

    <Transition name="call-announcement">
      <div v-if="callAnnouncement" class="call-announcement" aria-live="polite">
        <span>叫牌播报</span>
        <strong>
          【{{ playerName(callAnnouncement.callerSeat) }}】叫了【{{ cardGlyphName(callAnnouncement.card) }}】
        </strong>
        <CardView :card="callAnnouncement.card" size="table" />
      </div>
    </Transition>

    <div v-if="gameOver && resultOverlayVisible" class="result-overlay">
      <section class="result-panel">
        <span class="result-kicker">本局结算</span>
        <h2>{{ gameOver.rankings[0] === mySeat ? '拿下头游' : '本局结束' }}</h2>
        <div class="result-list">
          <div v-for="(seat, index) in gameOver.rankings" :key="seat" class="result-row">
            <span class="place">{{ index + 1 }}</span>
            <strong>{{ playerName(seat) }}</strong>
            <span
              v-if="scoreChange(seat) !== null"
              class="score-summary"
            >
              <span
                class="score-change"
                :class="{
                  positive: (scoreChange(seat) ?? 0) > 0,
                  negative: (scoreChange(seat) ?? 0) < 0,
                }"
              >
                本局 {{ (scoreChange(seat) ?? 0) > 0 ? '+' : '' }}{{ scoreChange(seat) }}
              </span>
              <small v-if="totalScore(seat) !== null">总分 {{ totalScore(seat) }}</small>
            </span>
          </div>
        </div>
        <div class="result-actions">
          <button
            type="button"
            class="secondary-button records-entry-button"
            @click="openRecords"
          >
            <History :size="17" />
            对局记录
          </button>
          <button type="button" class="secondary-button" @click="leaveRoom">
            返回首页
          </button>
          <button
            type="button"
            class="primary-button"
            :class="{ waiting: myRematchVoted }"
            @click="toggleRematch"
          >
            {{ myRematchVoted ? `等待中 (${rematchCount}/4)` : '再来一局' }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="recordsOpen" class="records-overlay" @click.self="closeRecords">
      <section class="records-panel">
        <header class="records-header">
          <div>
            <span class="result-kicker">个人中心</span>
            <h2>对局记录</h2>
          </div>
          <button type="button" class="icon-button" aria-label="关闭对局记录" @click="closeRecords">
            <X :size="19" />
          </button>
        </header>

        <div v-if="recordsLoading" class="records-empty">
          <RefreshCw :size="22" class="records-spinner" />
          <span>正在加载</span>
        </div>

        <div v-else-if="selectedMatch" class="match-detail">
          <button type="button" class="match-back" @click="selectedMatch = null">
            <ArrowLeft :size="17" />
            返回列表
          </button>
          <div class="match-detail-head">
            <span>{{ selectedMatch.mode === 'dahua' ? '打花' : '打朋友' }}</span>
            <strong>第 {{ selectedMatch.rank }} 名</strong>
            <small>{{ formatMatchTime(selectedMatch.createdAt) }}</small>
          </div>
          <div class="match-detail-list">
            <div
              v-for="player in selectedMatch.players"
              :key="player.seat"
              class="match-detail-row"
            >
              <span class="place">{{ player.rank }}</span>
              <strong>{{ player.nickname }}</strong>
              <span
                class="score-change"
                :class="{
                  positive: player.scoreChange > 0,
                  negative: player.scoreChange < 0,
                }"
              >
                {{ player.scoreChange > 0 ? '+' : '' }}{{ player.scoreChange }}
              </span>
            </div>
          </div>
        </div>

        <div v-else-if="matches.length" class="match-list">
          <button
            v-for="match in matches"
            :key="match.id"
            type="button"
            class="match-row"
            @click="selectedMatch = match"
          >
            <span class="match-mode">{{ match.mode === 'dahua' ? '打花' : '打朋友' }}</span>
            <span class="match-time">{{ formatMatchTime(match.createdAt) }}</span>
            <strong>第 {{ match.rank }} 名</strong>
            <span
              class="match-score"
              :class="{
                positive: match.scoreChange > 0,
                negative: match.scoreChange < 0,
              }"
            >
              {{ match.scoreChange > 0 ? '+' : '' }}{{ match.scoreChange }}
            </span>
          </button>
        </div>

        <div v-else class="records-empty">
          <Bot :size="24" />
          <span>暂无对局记录</span>
        </div>
      </section>
    </div>

    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>
