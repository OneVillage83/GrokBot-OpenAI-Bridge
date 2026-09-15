import { BridgeError, type State } from './types.js';
const edges: Record<State, State[]> = {
  IDLE: ['PREPARING'],
  PREPARING: ['SEND_TO_CHATGPT'],
  SEND_TO_CHATGPT: ['WAITING_FOR_CHATGPT'],
  WAITING_FOR_CHATGPT: ['PARSING_CHATGPT_DECISION'],
  PARSING_CHATGPT_DECISION: ['READY_FOR_NEXT_CODEX_TURN', 'COMPLETED', 'FAILED'],
  READY_FOR_NEXT_CODEX_TURN: ['SEND_TO_CODEX'],
  SEND_TO_CODEX: ['WAITING_FOR_CODEX'],
  WAITING_FOR_CODEX: ['COLLECTING_EVIDENCE'],
  COLLECTING_EVIDENCE: ['SEND_TO_CHATGPT'],
  WAITING_FOR_USER: [
    'SEND_TO_CHATGPT',
    'COLLECTING_EVIDENCE',
    'PARSING_CHATGPT_DECISION',
    'WAITING_FOR_CHATGPT',
  ],
  PAUSED: [
    'READY_FOR_NEXT_CODEX_TURN',
    'SEND_TO_CHATGPT',
    'WAITING_FOR_CHATGPT',
    'COLLECTING_EVIDENCE',
  ],
  COMPLETED: [],
  FAILED: [],
};
export function assertTransition(from: State, to: State) {
  if (from === to) return;
  if (
    !['COMPLETED', 'FAILED'].includes(from) &&
    ['PAUSED', 'WAITING_FOR_USER', 'FAILED'].includes(to)
  )
    return;
  if (!edges[from].includes(to)) throw new BridgeError('INVALID_TRANSITION', `${from} -> ${to}`);
}
