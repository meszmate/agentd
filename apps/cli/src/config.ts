import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface CliConfig {
  server: string;
  sessionToken: string | null;
}

const CONFIG_DIR = join(homedir(), ".agentd");
const CONFIG_FILE = join(CONFIG_DIR, "cli.json");

export function loadCliConfig(): CliConfig {
  const fromEnv: CliConfig = {
    server: process.env.AGENTD_SERVER ?? "http://127.0.0.1:3773",
    sessionToken: process.env.AGENTD_TOKEN ?? null,
  };
  if (!existsSync(CONFIG_FILE)) return fromEnv;
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<CliConfig>;
    return {
      server: process.env.AGENTD_SERVER ?? data.server ?? fromEnv.server,
      sessionToken:
        process.env.AGENTD_TOKEN ?? data.sessionToken ?? fromEnv.sessionToken,
    };
  } catch {
    return fromEnv;
  }
}

export function saveCliConfig(c: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}
