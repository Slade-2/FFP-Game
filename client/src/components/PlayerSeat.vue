<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { WifiOff } from '@lucide/vue';
import type { PublicPlayer } from '../types';
import CardView from './CardView.vue';

const props = defineProps<{
  player: PublicPlayer;
  score?: number;
  cardCount: number;
  isCurrent: boolean;
  isPassing?: boolean;
  rank?: number;
  remainingSeconds?: number;
  teamRole?: 'friend' | 'enemy';
  orientation?: 'top' | 'right' | 'left' | 'bottom';
  showCardBacks?: boolean;
  vertical?: boolean;
}>();

const initial = computed(() => props.player.nickname.trim().slice(0, 1) || '友');
const displayScore = computed(() => props.score ?? props.player.score);
const passBubble = ref<HTMLElement | null>(null);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function backStyle(index: number): Record<string, string | number> {
  const count = Math.max(props.cardCount, 1);
  const center = (count - 1) / 2;
  const normalized = center === 0 ? 0 : (index - center) / center;
  const overlap = props.orientation === 'top' ? -12 : -19;
  return {
    marginLeft: index === 0 ? '0px' : `${overlap}px`,
    transform: `translateY(${(Math.abs(normalized) * 4).toFixed(1)}px) rotate(${(normalized * 7).toFixed(1)}deg)`,
    zIndex: index + 1,
  };
}

watch(() => props.isPassing, async (passing) => {
  if (!passing) {
    return;
  }
  await nextTick();
  const element = passBubble.value;
  if (!element || reducedMotion.matches) {
    return;
  }
  element.animate(
    [
      { transform: 'translate(-50%, 8px) scale(0.82)', opacity: 0 },
      { transform: 'translate(-50%, -3px) scale(1.08)', opacity: 1, offset: 0.24 },
      { transform: 'translate(-50%, -13px) scale(1)', opacity: 0 },
    ],
    {
      duration: 760,
      easing: 'cubic-bezier(0.18, 0.88, 0.24, 1)',
      fill: 'forwards',
    },
  );
});
</script>

<template>
  <div
    class="player-seat-wrap"
    :class="{
      [`orientation-${orientation ?? 'bottom'}`]: true,
      'layout-vertical': vertical,
    }"
  >
    <div
      class="player-seat"
      :class="{
        current: isCurrent,
        offline: !player.connected,
        finished: cardCount <= 0,
      }"
    >
      <span class="avatar">{{ initial }}</span>
      <span class="player-copy">
        <strong :title="player.nickname">{{ player.nickname }}</strong>
        <span class="player-meta">
          <small :class="{ exhausted: cardCount <= 0 }">
            {{ cardCount > 0 ? `${cardCount} 张` : '已出完' }}
          </small>
          <small>总分 {{ displayScore }}</small>
        </span>
      </span>
      <span v-if="isCurrent" class="thinking">
        思考中…{{ remainingSeconds !== undefined ? remainingSeconds : '' }}
      </span>
      <span v-if="rank" class="rank-badge">第{{ rank }}</span>
      <span
        v-if="teamRole"
        class="team-badge"
        :class="teamRole"
      >
        {{ teamRole === 'friend' ? '友' : '敌' }}
      </span>
      <WifiOff v-if="!player.connected" :size="15" aria-label="离线" />
      <span v-if="isPassing" ref="passBubble" class="pass-bubble">不出</span>
    </div>
    <div
      v-if="showCardBacks && cardCount > 0"
      class="card-back-fan"
      aria-hidden="true"
    >
      <CardView
        v-for="index in cardCount"
        :key="index"
        size="mini"
        :style="backStyle(index - 1)"
      />
    </div>
  </div>
</template>

<style scoped>
.player-seat-wrap {
  position: relative;
  width: 100%;
  min-width: 0;
}

.player-seat {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border: 1px solid rgb(77 225 255 / 26%);
  border-radius: 9px;
  background:
    linear-gradient(145deg, rgb(15 45 66 / 92%), rgb(6 20 42 / 88%));
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 7%),
    0 8px 18px rgb(1 7 20 / 36%);
  color: #f5fbff;
  transition:
    border-color 160ms ease,
    box-shadow 180ms ease,
    background 160ms ease,
    transform 180ms ease;
}

.player-seat.current {
  border-color: #ffe35e;
  background:
    linear-gradient(145deg, rgb(44 62 67 / 96%), rgb(10 32 52 / 94%));
  box-shadow:
    0 0 0 2px rgb(255 227 94 / 18%),
    0 0 20px rgb(255 220 61 / 24%),
    0 8px 18px rgb(1 7 20 / 38%);
  transform: translateY(-1px);
}

.player-seat.offline {
  opacity: 0.58;
}

.player-seat.finished {
  border-color: rgb(255 255 255 / 12%);
}

.player-seat-wrap.layout-vertical {
  width: 64px;
}

.layout-vertical .player-seat {
  display: flex;
  width: 64px;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 7px 5px 6px;
  border-radius: 10px;
}

.layout-vertical .avatar {
  width: 32px;
  height: 32px;
  font-size: 14px;
}

.layout-vertical .player-copy {
  width: 100%;
  align-items: center;
  gap: 3px;
  text-align: center;
}

.layout-vertical .player-copy strong {
  font-size: 11px;
  text-align: center;
}

.layout-vertical .player-meta {
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.layout-vertical .player-meta small {
  font-size: 9px;
}

.layout-vertical .player-meta small + small::before {
  content: none;
}

.layout-vertical .thinking {
  top: calc(100% + 4px);
  right: auto;
  bottom: auto;
  left: 50%;
  padding: 2px 5px;
  font-size: 9px;
  transform: translateX(-50%);
}

.avatar {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid rgb(255 244 180 / 72%);
  border-radius: 50%;
  background:
    radial-gradient(circle at 36% 28%, #fff0a6, #f5b933 64%, #b56708 100%);
  box-shadow:
    inset 0 -4px 9px rgb(91 45 0 / 18%),
    0 0 12px rgb(255 196 47 / 28%);
  color: #183048;
  font-size: 15px;
  font-weight: 800;
}

.player-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.player-copy strong {
  width: 100%;
  overflow: hidden;
  font-size: 14px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.player-meta small {
  color: #9dc3d3;
  font-size: 11px;
  white-space: nowrap;
}

.player-meta small + small::before {
  margin-right: 7px;
  color: rgb(255 255 255 / 24%);
  content: "·";
}

.player-meta .exhausted {
  color: #ffe35e;
  font-weight: 800;
}

.thinking {
  position: absolute;
  top: -9px;
  right: 6px;
  padding: 3px 7px;
  border: 1px solid rgb(255 247 194 / 70%);
  border-radius: 999px;
  background: #ffe35e;
  box-shadow: 0 0 13px rgb(255 226 69 / 35%);
  color: #102434;
  font-size: 10px;
  font-weight: 800;
  white-space: nowrap;
}

.pass-bubble {
  position: absolute;
  z-index: 5;
  top: -18px;
  left: 50%;
  padding: 3px 9px;
  border: 1px solid rgb(255 221 221 / 58%);
  border-radius: 999px;
  background: #ef5263;
  box-shadow: 0 0 16px rgb(239 82 99 / 38%);
  color: white;
  font-size: 12px;
  font-weight: 800;
  pointer-events: none;
  white-space: nowrap;
}

.rank-badge {
  position: absolute;
  top: -8px;
  right: -7px;
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 2px solid #0a1b30;
  border-radius: 50%;
  background: #ef5263;
  box-shadow: 0 0 12px rgb(239 82 99 / 36%);
  color: white;
  font-size: 9px;
  font-weight: 800;
}

.team-badge {
  position: absolute;
  top: -8px;
  left: -7px;
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 2px solid #0a1b30;
  border-radius: 50%;
  color: white;
  font-size: 10px;
  font-weight: 900;
}

.team-badge.friend {
  background: #18b77a;
  box-shadow: 0 0 12px rgb(24 183 122 / 46%);
}

.team-badge.enemy {
  background: #ef5263;
  box-shadow: 0 0 12px rgb(239 82 99 / 46%);
}

.player-seat > svg {
  position: absolute;
  top: 7px;
  right: 7px;
}

.card-back-fan {
  position: absolute;
  z-index: 2;
  display: flex;
  align-items: center;
  pointer-events: none;
}

.card-back-fan :deep(.playing-card) {
  opacity: 0.88;
  filter: saturate(0.82) brightness(0.88);
}

.orientation-top .card-back-fan {
  top: calc(100% - 3px);
  left: 50%;
  transform: translateX(-50%);
}

.orientation-left .card-back-fan {
  top: calc(100% - 2px);
  left: 50%;
  transform: translateX(-50%);
}

.orientation-right .card-back-fan {
  top: calc(100% - 2px);
  left: 50%;
  transform: translateX(-50%);
}
</style>
