import { BridgeError, now, type ChatTurn, type Project, type Run } from '../../core/types.js';
import { verifyThread, hash } from '../../core/protocol.js';
import type { SQLiteStore } from '../storage/sqlite-adapter.js';
export interface BrowserReceipt {
  request_id: string;
  observed_url: string;
  observed_title: string;
  user_message_id: string;
  observed_user_message: string;
  response_id: string;
  response: string;
  captured_at: string;
  response_complete: boolean;
  response_follows_user_message: boolean;
}
export interface ChatGPTAdapter {
  enqueue(turn: ChatTurn): void;
  accept(p: Project, r: Run, receipt: BrowserReceipt): ChatTurn;
}
/** GrokBot's native persistent browser is the operator, with a durable local courier protocol.
 * No hidden ChatGPT API, replacement conversation, browser profile or cookie access. */
export class BrowserChatGPTAdapter implements ChatGPTAdapter {
  constructor(private store: SQLiteStore) {}
  enqueue(t: ChatTurn) {
    this.store.saveChat(t);
  }
  claim(p: Project, t: ChatTurn, observedUrl: string, observedTitle: string, baseline: string) {
    verifyThread(p, observedUrl, observedTitle);
    if (t.status !== 'pending')
      throw new BridgeError(
        'SEND_ALREADY_CLAIMED',
        'Do not resend. Inspect the exact thread and reconcile the existing request.',
      );
    if (!baseline.trim()) throw new BridgeError('BROWSER_BASELINE_REQUIRED');
    t.status = 'claimed';
    t.claimed_at = now();
    t.baseline_assistant_id = baseline;
    this.store.saveChat(t);
  }
  sent(p: Project, t: ChatTurn, url: string, title: string, messageId: string) {
    verifyThread(p, url, title);
    if (t.status !== 'claimed' || !messageId.trim()) throw new BridgeError('INVALID_SEND_RECEIPT');
    t.status = 'sent';
    t.user_message_id = messageId;
    this.store.saveChat(t);
  }
  accept(p: Project, r: Run, receipt: BrowserReceipt) {
    this.store.artifact(r, 'browser-receipt-raw', receipt, r.pending_chatgpt_id);
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      [
        'request_id',
        'observed_url',
        'observed_title',
        'user_message_id',
        'observed_user_message',
        'response_id',
        'response',
        'captured_at',
      ].some((key) => typeof (receipt as unknown as Record<string, unknown>)[key] !== 'string')
    )
      throw new BridgeError(
        'INVALID_BROWSER_RECEIPT',
        'Observation fields must be strings; completion flags must be true booleans.',
      );
    if (!r.pending_chatgpt_id || receipt.request_id !== r.pending_chatgpt_id)
      throw new BridgeError('STALE_CHATGPT_RESPONSE');
    verifyThread(p, receipt.observed_url, receipt.observed_title);
    const t = this.store.chat(r.pending_chatgpt_id);
    if (!['claimed', 'sent'].includes(t.status))
      throw new BridgeError('DUPLICATE_OR_UNCLAIMED_RESPONSE');
    if (
      receipt.response_complete !== true ||
      receipt.response_follows_user_message !== true ||
      typeof receipt.response !== 'string' ||
      !receipt.response.trim()
    )
      throw new BridgeError('CHATGPT_RESPONSE_INTERRUPTED');
    if (
      typeof receipt.observed_user_message !== 'string' ||
      hash(receipt.observed_user_message) !== t.message_sha256
    )
      throw new BridgeError('OUTBOUND_MESSAGE_MISMATCH');
    const captured = Date.parse(receipt.captured_at);
    if (Date.now() - Date.parse(t.claimed_at!) > p.timeout_ms)
      throw new BridgeError(
        'CHATGPT_RESPONSE_TIMEOUT',
        'Browser handoff deadline elapsed. Reconcile the original message with the user; never resend automatically.',
      );
    if (
      !Number.isFinite(captured) ||
      captured < Date.parse(t.claimed_at!) ||
      captured > Date.now() + 60_000 ||
      Date.now() - captured > p.timeout_ms
    )
      throw new BridgeError('STALE_CHATGPT_RESPONSE');
    if (
      !receipt.response_id ||
      !receipt.user_message_id ||
      receipt.response_id === receipt.user_message_id ||
      receipt.response_id === t.baseline_assistant_id ||
      (t.user_message_id && t.user_message_id !== receipt.user_message_id) ||
      this.store.responseSeen(p.project_id, receipt.response_id)
    )
      throw new BridgeError('DUPLICATE_CHATGPT_RESPONSE');
    t.status = 'received';
    t.user_message_id = receipt.user_message_id;
    t.response = receipt.response;
    t.response_id = receipt.response_id;
    this.store.saveChat(t);
    this.store.artifact(r, 'chatgpt-response', t.response, t.id);
    return t;
  }
}
