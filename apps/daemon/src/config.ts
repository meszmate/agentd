import { parseArgs } from "node:util";

export interface DaemonConfig {
  host: string;
  port: number;
  rootDir: string | undefined;
  printPairing: boolean;
}

export function loadConfig(argv = process.argv.slice(2)): DaemonConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      root: { type: "string" },
      "no-pair": { type: "boolean" },
    },
    allowPositionals: false,
    strict: false,
  });

  const host =
    typeof values.host === "string" && values.host.length > 0
      ? values.host
      : process.env.AGENTD_HOST ?? "127.0.0.1";
  const portStr =
    typeof values.port === "string" ? values.port : process.env.AGENTD_PORT;
  const port = portStr ? parseInt(portStr, 10) : 3773;
  const rootDir =
    typeof values.root === "string" ? values.root : process.env.AGENTD_ROOT;
  const printPairing = values["no-pair"] !== true;
  return {
    host,
    port: Number.isFinite(port) ? port : 3773,
    rootDir,
    printPairing,
  };
}
