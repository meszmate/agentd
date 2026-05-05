/**
 * `@agentd/bot-core` — shared command + event handling for the
 * Telegram and Discord bridges. Each app implements a `BotAdapter`
 * (rendering, button widgets, send) and reuses everything else.
 */

export * from "./types.ts";
export * from "./commands.ts";
export * from "./textRouter.ts";
export * from "./eventFormat.ts";
