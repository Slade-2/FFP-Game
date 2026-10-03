import { io } from 'socket.io-client';

const entry = window.location.pathname.replace(/\/+$/, '').endsWith('/test')
  ? 'test'
  : 'normal';

export const socket = io({
  autoConnect: true,
  query: { entry },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  randomizationFactor: 0.5,
  timeout: 10000,
});
