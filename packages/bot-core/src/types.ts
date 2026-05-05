/**
 * Shared bot abstractions used by `@agentd/telegram` and `@agentd/discord`.
 *
 * The two platforms have different rich-message models (MarkdownV2 + inline
 * keyboards on Telegram; markdown + action-row buttons on Discord) but
 * largely identical command surface and event-routing logic. Everything
 * platform-specific is hidden behind `BotAdapter`; the rest of bot-core
 * works in plain strings + structural primitives.
 *
 * Design notes:
 * - `chatId` is a string. Telegram uses int64 chat ids; we keep them as
 *   strings here so adapters don't lose precision and so Discord channel
 *   snowflakes drop in unchanged.
 * - Adapters render formatting via `Formatter`. The shared logic only
 *   composes plain text with `fmt.bold("foo")` etc; the adapter decides
 *   how to escape and emit it.
 */

import type { AgentdClient } from "@agentd/client";

/**
 * Platform-specific text formatting. Telegram has to escape MarkdownV2
 * reserved chars; Discord can pass markdown straight through. Each
 * helper returns a string ready to splice into a sendable message.
 */
export interface Formatter {
  bold(s: string): string;
  italic(s: string): string;
  /** inline `code span` */
  code(s: string): string;
  /** ```fenced block``` */
  codeBlock(s: string): string;
  /** Escape arbitrary text so it survives the platform's parser. */
  escape(s: string): string;
}

/** Outbound button on a project picker / yes-no prompt. */
export interface BotButton {
  /** Stable callback id. Format: `pp:<pendingId>:<projectId>` for picker. */
  id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
}

export interface SendResult {
  /** Platform message id (string for both — TG ints get stringified). */
  messageId: string;
}

/**
 * Platform adapter. Each method takes a platform-agnostic chatId string
 * and string body; the adapter handles chunking, escaping, and platform
 * mechanics. Methods may throw — callers always wrap with try/catch.
 */
export interface BotAdapter {
  platform: "telegram" | "discord";
  fmt: Formatter;
  /** Max chars per outbound message (used by chunkers). */
  chunkSize: number;
  sendMessage(chatId: string, text: string): Promise<SendResult>;
  /** Send `text` as a code block (for diff / log output). */
  sendCodeBlock(chatId: string, text: string): Promise<SendResult>;
  /**
   * Send a message with inline buttons. Buttons are passed as rows; the
   * adapter packs them into platform-native widgets (InlineKeyboard for
   * Telegram, ActionRowBuilder for Discord). Buttons beyond what the
   * platform allows are dropped.
   */
  sendWithButtons(
    chatId: string,
    text: string,
    rows: BotButton[][],
  ): Promise<SendResult>;
  /** React with an emoji (optional — Telegram has no per-message reaction API we use). */
  react?(chatId: string, messageId: string, emoji: string): Promise<void>;
}

/** Reference to a message we previously sent — used for reply-thread routing. */
export interface MessageRef {
  chatId: string;
  messageId: string;
}

/** A user message coming in. */
export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  /** If the user replied to one of our previous messages, this points to it. */
  replyTo: MessageRef | null;
  /** True when the operator's id is on the allowlist. */
  isAllowed: boolean;
  /** Platform-friendly reply helper that posts back to the same chat. */
  reply(text: string): Promise<SendResult>;
  /** React to the incoming message (optional). */
  react?(emoji: string): Promise<void>;
}

/**
 * The `(verb, prompt)` snapshot stashed when we open a project picker.
 * Cleared when the operator taps a project (or the 10-minute TTL fires).
 */
export type PendingKind = "new" | "brainstorm" | "plan";
export interface PendingPick {
  kind: PendingKind;
  prompt: string;
  chatId: string;
  expiresAt: number;
}

/** Cross-platform shared maps. Keyed by string chatId / messageId. */
export interface BotState {
  /** chatId → focused taskId. Set by `/use` or implicitly by `/new`. */
  focus: Map<string, string>;
  /**
   * chatId → focused projectId. Set by `/project <id>`. When set,
   * project-targeted verbs (`/new`, `/brainstorm`, `/plan`, `/issues`,
   * `/prs`, `/ideas`) skip the picker and operate on this project.
   * Cleared by `/project clear`.
   */
  focusProject: Map<string, string>;
  /** picker id → pending verb+prompt. Set on `/new` etc, drained on tap. */
  pending: Map<string, PendingPick>;
  /** "chatId:msgId" of one of our messages → the taskId it referred to. */
  replyMap: Map<string, string>;
  /** "chatId:msgId" of a suggestion bubble → suggestionId. */
  suggestionReplyMap: Map<string, string>;
  /** Per-chat fallback when the user types without reply-threading. */
  lastSuggestionByChat: Map<string, string>;
  /** taskId → latest options offered (lets "1"/"2" resolve to text). */
  latestOptions: Map<string, string[]>;
  /** taskIds that just emitted `done: true`. Single-word "yes" should ack. */
  awaitingDone: Set<string>;
  /** taskId → projectId | null (cached so we don't refetch every event). */
  projectByTask: Map<string, string | null>;
}

export function createState(): BotState {
  return {
    focus: new Map(),
    focusProject: new Map(),
    pending: new Map(),
    replyMap: new Map(),
    suggestionReplyMap: new Map(),
    lastSuggestionByChat: new Map(),
    latestOptions: new Map(),
    awaitingDone: new Set(),
    projectByTask: new Map(),
  };
}

/** Helpers for keyed-by-string map entries. */
export function replyKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`;
}

/** Generate a fresh short id for picker callbacks. */
export function newPickerId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Bag of handles a command handler needs. Constructed once per bot at
 * startup and passed into every `runCommand` / `handleEvent` call.
 */
export interface BotContext {
  adapter: BotAdapter;
  client: AgentdClient;
  state: BotState;
  /**
   * Whether the operator is allowed. Implementations gate this in the
   * incoming-message stage, but the picker-tap path also needs it
   * (Discord button interactions can come from non-allowed users).
   */
  isAllowed(chatId: string, userId: string): boolean;
}
