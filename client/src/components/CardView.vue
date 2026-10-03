<script setup lang="ts">
import { computed } from 'vue';
import { CARD_BACK_FILE, cardName, cardToFile } from '../cards';
import type { Card } from '../types';

const props = withDefaults(defineProps<{
  card?: Card;
  selected?: boolean;
  disabled?: boolean;
  size?: 'normal' | 'hand' | 'table' | 'mini';
  interactive?: boolean;
}>(), {
  selected: false,
  disabled: false,
  size: 'normal',
  interactive: false,
});

const emit = defineEmits<{
  select: [];
}>();

const noHoverDevice = window.matchMedia('(hover: none)');

const cardFile = computed(() => (props.card
  ? cardToFile(props.card.r, props.card.s)
  : CARD_BACK_FILE));
const cardLabel = computed(() => (props.card ? cardName(props.card) : '牌背'));

function activate(): void {
  if (props.interactive && !props.disabled) {
    emit('select');
  }
}
</script>

<template>
  <button
    v-if="interactive"
    type="button"
    class="playing-card"
    :class="{
      selected,
      disabled,
      hand: size === 'hand',
      table: size === 'table',
      mini: size === 'mini',
      back: !card,
      'no-hover': noHoverDevice.matches,
    }"
    :disabled="disabled"
    @click="activate"
  >
    <img class="card-image" :src="cardFile" :alt="cardLabel" draggable="false" />
  </button>

  <div
    v-else
    class="playing-card"
    :class="{
      selected,
      disabled,
      hand: size === 'hand',
      table: size === 'table',
      mini: size === 'mini',
      back: !card,
      'no-hover': noHoverDevice.matches,
    }"
  >
    <img class="card-image" :src="cardFile" :alt="cardLabel" draggable="false" />
  </div>
</template>

<style scoped>
.playing-card {
  position: relative;
  width: 52px;
  height: auto;
  aspect-ratio: 2 / 3;
  flex: 0 0 auto;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 6px;
  background: transparent;
  box-shadow:
    0 3px 8px rgb(4 10 22 / 28%);
  transform-origin: 50% 50%;
  transition:
    transform 240ms cubic-bezier(0.2, 1.4, 0.35, 1),
    box-shadow 220ms ease,
    filter 220ms ease;
  will-change: transform;
}

.card-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

button.playing-card {
  cursor: pointer;
}

.playing-card.selected {
  z-index: 4;
  outline: 2px solid #f6c85d;
  outline-offset: 2px;
  box-shadow:
    0 0 18px rgb(246 200 93 / 58%),
    0 12px 18px rgb(4 10 22 / 34%);
  transform: translateY(-14px);
}

.playing-card.disabled {
  cursor: default;
  filter: saturate(0.78) brightness(0.94);
  opacity: 0.84;
}

.playing-card.hand {
  width: var(--hand-card-width, clamp(64px, 17vw, 78px));
  border-radius: 7px;
  transform: none;
  transform-origin: 50% 100%;
  transition:
    transform 150ms ease-out,
    box-shadow 150ms ease-out,
    outline-color 120ms ease-out;
}

button.playing-card.hand:not(.no-hover):not(.selected):not(:disabled):hover {
  z-index: auto;
  outline: 2px solid #ffe09a;
  outline-offset: 1px;
  box-shadow:
    0 0 0 2px rgb(255 224 154 / 18%),
    0 7px 12px rgb(4 10 22 / 32%);
  transform: translateY(-8px);
}

.playing-card.hand.selected {
  z-index: auto;
  outline: 2px solid #f6c85d;
  outline-offset: 1px;
  box-shadow:
    0 0 0 2px rgb(246 200 93 / 18%),
    0 8px 13px rgb(4 10 22 / 34%);
  filter: none;
  transform: translateY(-16px);
}

.playing-card.table {
  width: clamp(44px, 10cqw, 58px);
  border-radius: 6px;
  box-shadow:
    0 8px 13px rgb(2 7 18 / 42%);
}

.playing-card.mini {
  width: 24px;
  border-radius: 4px;
  box-shadow: 0 3px 7px rgb(2 7 18 / 38%);
}
</style>
