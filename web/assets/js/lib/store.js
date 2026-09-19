// Latest /api/status snapshot shared by the shell and views.
import { emit } from './bus.js';

let current = null;

export const getStatus = () => current;

export function setStatus(next) {
  current = next;
  emit('status:changed', next);
}
