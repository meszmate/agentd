import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const TelegramPluginConfig = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(""),
  allowedUserIds: z.array(z.number()).default([]),
  allowedChatIds: z.array(z.number()).default([]),
  defaultRepo: z.string().nullable().default(null),
});
export type TelegramPluginConfig = z.infer<typeof TelegramPluginConfig>;

export const DiscordPluginConfig = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(""),
  allowedUserIds: z.array(z.string()).default([]),
  allowedChannelIds: z.array(z.string()).default([]),
  defaultRepo: z.string().nullable().default(null),
});
export type DiscordPluginConfig = z.infer<typeof DiscordPluginConfig>;

export const AgentdConfig = z.object({
  pluginSessionToken: z.string().nullable().default(null),
  plugins: z
    .object({
      telegram: TelegramPluginConfig.default({
        enabled: false,
        botToken: "",
        allowedUserIds: [],
        allowedChatIds: [],
        defaultRepo: null,
      }),
      discord: DiscordPluginConfig.default({
        enabled: false,
        botToken: "",
        allowedUserIds: [],
        allowedChannelIds: [],
        defaultRepo: null,
      }),
    })
    .default({
      telegram: {
        enabled: false,
        botToken: "",
        allowedUserIds: [],
        allowedChatIds: [],
        defaultRepo: null,
      },
      discord: {
        enabled: false,
        botToken: "",
        allowedUserIds: [],
        allowedChannelIds: [],
        defaultRepo: null,
      },
    }),
});
export type AgentdConfig = z.infer<typeof AgentdConfig>;

export type PluginName = "telegram" | "discord";

export function configPath(rootDir: string): string {
  return `${rootDir}/config.json`;
}

export function loadConfig(rootDir: string): AgentdConfig {
  const path = configPath(rootDir);
  if (!existsSync(path)) return AgentdConfig.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`config at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = AgentdConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `config at ${path} failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export function saveConfig(rootDir: string, config: AgentdConfig): void {
  const path = configPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function updateConfig(
  rootDir: string,
  fn: (c: AgentdConfig) => AgentdConfig,
): AgentdConfig {
  const next = fn(loadConfig(rootDir));
  saveConfig(rootDir, next);
  return next;
}
