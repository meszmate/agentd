/**
 * `agentd setup` — register the daemon as a long-lived service so it
 * survives reboots and shell logouts. Models the cloudflared `service
 * install` command:
 *
 *   - linux: writes a system-level systemd unit to /etc/systemd/system,
 *     plus an oneshot + timer for daily auto-update. Needs sudo (the
 *     paths live under /etc).
 *   - macos: writes a per-user LaunchAgent to ~/Library/LaunchAgents.
 *     No sudo — LaunchAgents run in the user session, which is what
 *     we want on a mac because the agent CLIs (claude, codex) cache
 *     auth in the user's keychain.
 *
 * `agentd setup --uninstall` reverses everything. Data at --data-dir
 * is left intact.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { hostname, platform, userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

interface Opts {
  uninstall: boolean;
  status: boolean;
  dataDir: string;
  port: number;
  publicBind: boolean;
  autoUpdate: boolean;
  dryRun: boolean;
  user: string;
  userHome: string;
  bunBin: string;
  agentdEntry: string;
}

const HELP = `agentd setup — install agentd as a long-lived service

  agentd setup                  install + start with sane defaults
  agentd setup --uninstall      remove the service (data is preserved)
  agentd setup --status         show service status

Flags:
  --data-dir <path>     where agentd keeps its DB/worktrees/config
                        default: /var/lib/agentd on linux, ~/.agentd on macos
  --port <n>            listening port (default 3773)
  --public              bind 0.0.0.0 (default 127.0.0.1)
  --no-auto-update      skip the daily auto-update timer/agent
  --dry-run             print what would happen, don't touch disk

Linux writes a system-level systemd unit. Re-run with sudo if you see a
permission error:
  sudo -E env "PATH=$PATH" agentd setup

macOS writes a per-user LaunchAgent (no sudo).
`;

export function cmdSetup(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean" },
      "data-dir": { type: "string" },
      port: { type: "string" },
      public: { type: "boolean" },
      "no-auto-update": { type: "boolean" },
      "dry-run": { type: "boolean" },
      uninstall: { type: "boolean" },
      status: { type: "boolean" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const plat = platform();
  if (plat !== "linux" && plat !== "darwin") {
    console.error(
      `setup: only linux and macos are supported (got ${plat}).\n` +
        `See https://github.com/meszmate/agentd/blob/main/docs/deploy.md for manual options.`,
    );
    process.exit(2);
  }

  const opts = buildOpts(values, plat);

  if (opts.status) {
    return plat === "linux" ? statusLinux() : statusMacos(opts);
  }
  if (opts.uninstall) {
    return plat === "linux" ? uninstallLinux(opts) : uninstallMacos(opts);
  }
  return plat === "linux" ? installLinux(opts) : installMacos(opts);
}

function buildOpts(values: Record<string, unknown>, plat: NodeJS.Platform): Opts {
  // SUDO_USER is set when running under sudo. We want the unit's User= to
  // point at the human, not root, so the daemon spawns shells with their
  // real env, ssh keys, nvm shims, etc.
  const user = process.env.SUDO_USER || userInfo().username;
  const userHome = process.env.SUDO_USER
    ? process.env.HOME && process.env.HOME !== "/root"
      ? process.env.HOME
      : `/home/${user}`
    : userInfo().homedir;

  // process.execPath is bun itself when this script runs under bun. realpath
  // resolves any symlinks (e.g. ~/.bun/bin/bun -> ~/.bun/install/bun-1.x/bun).
  const bunBin = realpathSync(process.execPath);
  // process.argv[1] is the script bun was asked to run — for a global install
  // that's the agentd bin symlink, which we realpath to the actual TS file.
  const argv1 = process.argv[1];
  if (!argv1) {
    console.error("setup: cannot determine agentd entry path (process.argv[1] empty)");
    process.exit(1);
  }
  const agentdEntry = realpathSync(argv1);

  const dataDirRaw = values["data-dir"];
  const dataDir =
    typeof dataDirRaw === "string" && dataDirRaw
      ? dataDirRaw
      : plat === "linux"
        ? "/var/lib/agentd"
        : `${userHome}/.agentd`;

  const portRaw = values.port;
  const port =
    typeof portRaw === "string" && portRaw ? parseInt(portRaw, 10) : 3773;

  return {
    uninstall: !!values.uninstall,
    status: !!values.status,
    dataDir,
    port,
    publicBind: !!values.public,
    autoUpdate: !values["no-auto-update"],
    dryRun: !!values["dry-run"],
    user,
    userHome,
    bunBin,
    agentdEntry,
  };
}

function requireRoot(): void {
  if (process.getuid && process.getuid() !== 0) {
    console.error(
      `setup: writing system files needs root. Re-run as:\n` +
        `  sudo -E env "PATH=$PATH" agentd setup\n` +
        `(the -E env "PATH=$PATH" bit is so sudo doesn't strip bun off PATH)`,
    );
    process.exit(1);
  }
}

function writeFile(path: string, contents: string, mode: number, opts: Opts) {
  if (opts.dryRun) {
    console.log(
      `[dry-run] would write ${path} (${contents.length} bytes, mode ${mode.toString(8)})`,
    );
    return;
  }
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  console.log(`wrote ${path}`);
}

function run(cmd: string[], opts: Opts): number {
  if (opts.dryRun) {
    console.log(`[dry-run] would run: ${cmd.join(" ")}`);
    return 0;
  }
  console.log(`> ${cmd.join(" ")}`);
  const head = cmd[0];
  if (!head) return 0;
  const r = spawnSync(head, cmd.slice(1), { stdio: "inherit" });
  if (r.status !== 0 && r.status !== null) {
    console.error(`${head} exited with code ${r.status}`);
  }
  return r.status ?? 0;
}

// ----- Linux (systemd) ------------------------------------------------------

const LINUX_UNIT = "/etc/systemd/system/agentd.service";
const LINUX_UPDATE_SERVICE = "/etc/systemd/system/agentd-update.service";
const LINUX_UPDATE_TIMER = "/etc/systemd/system/agentd-update.timer";
const LINUX_SUDOERS = "/etc/sudoers.d/agentd-update";

function installLinux(opts: Opts) {
  requireRoot();

  if (!opts.dryRun) {
    mkdirSync(opts.dataDir, { recursive: true });
    spawnSync("chown", ["-R", `${opts.user}:${opts.user}`, opts.dataDir]);
  } else {
    console.log(`[dry-run] would mkdir ${opts.dataDir} (chown to ${opts.user})`);
  }

  writeFile(LINUX_UNIT, renderLinuxUnit(opts), 0o644, opts);

  if (opts.autoUpdate) {
    writeFile(LINUX_UPDATE_SERVICE, renderLinuxUpdateService(opts), 0o644, opts);
    writeFile(LINUX_UPDATE_TIMER, renderLinuxUpdateTimer(), 0o644, opts);
    // Narrow sudoers rule so the auto-update unit can restart agentd without
    // a password prompt. Mode 0440 is required for files in /etc/sudoers.d/.
    writeFile(
      LINUX_SUDOERS,
      `${opts.user} ALL=(root) NOPASSWD: /bin/systemctl restart agentd\n`,
      0o440,
      opts,
    );
  }

  run(["systemctl", "daemon-reload"], opts);
  run(["systemctl", "enable", "--now", "agentd.service"], opts);
  if (opts.autoUpdate) {
    run(["systemctl", "enable", "--now", "agentd-update.timer"], opts);
  }

  printPostInstallLinux(opts);
}

function uninstallLinux(opts: Opts) {
  requireRoot();
  run(["systemctl", "disable", "--now", "agentd-update.timer"], opts);
  run(["systemctl", "disable", "--now", "agentd.service"], opts);
  for (const p of [
    LINUX_UNIT,
    LINUX_UPDATE_SERVICE,
    LINUX_UPDATE_TIMER,
    LINUX_SUDOERS,
  ]) {
    if (existsSync(p)) {
      if (opts.dryRun) {
        console.log(`[dry-run] would rm ${p}`);
      } else {
        rmSync(p);
        console.log(`rm ${p}`);
      }
    }
  }
  run(["systemctl", "daemon-reload"], opts);
  console.log(
    `\nagentd service removed. Your data at ${opts.dataDir} is untouched.`,
  );
}

function statusLinux() {
  spawnSync("systemctl", ["status", "agentd.service"], { stdio: "inherit" });
}

function renderLinuxUnit(opts: Opts): string {
  const hostFlag = opts.publicBind ? "--host 0.0.0.0" : "--host 127.0.0.1";
  const bunDir = resolve(opts.bunBin, "..");
  return `[Unit]
Description=agentd — coding-agent orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${opts.user}
Group=${opts.user}
WorkingDirectory=${opts.userHome}

# Include bun's dir plus typical tool locations so the daemon can find
# claude/codex/gh/git when it spawns them.
Environment=PATH=${bunDir}:/usr/local/bin:/usr/bin:/bin:${opts.userHome}/.local/bin
Environment=HOME=${opts.userHome}

ExecStart=${opts.bunBin} ${opts.agentdEntry} serve ${hostFlag} --port ${opts.port} --root ${opts.dataDir}

Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=20

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

function renderLinuxUpdateService(opts: Opts): string {
  const bunDir = resolve(opts.bunBin, "..");
  return `[Unit]
Description=agentd auto-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${opts.user}
Group=${opts.user}
Environment=PATH=${bunDir}:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${opts.userHome}

# Pull the latest version from npm and restart the daemon. The narrow
# sudoers rule in /etc/sudoers.d/agentd-update lets this run unattended.
# \`|| exit 0\` on the install step prevents a transient npm 5xx from
# triggering a failed-unit email.
ExecStart=/bin/sh -c '\\
  set -eu; \\
  ${opts.bunBin} install -g @meszmate/agentd@latest || exit 0; \\
  sudo /bin/systemctl restart agentd.service'
`;
}

function renderLinuxUpdateTimer(): string {
  return `[Unit]
Description=agentd nightly auto-update

[Timer]
OnCalendar=*-*-* 04:17:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
`;
}

function printPostInstallLinux(opts: Opts) {
  if (opts.dryRun) {
    console.log("\n[dry-run] no changes made.");
    return;
  }
  const url = opts.publicBind
    ? `http://${hostname()}:${opts.port}`
    : `http://127.0.0.1:${opts.port}`;
  console.log("");
  console.log("agentd installed and running.");
  console.log(`  URL:       ${url}`);
  console.log(`  Data dir:  ${opts.dataDir}`);
  console.log(`  Logs:      journalctl -u agentd -f`);
  if (opts.autoUpdate) {
    console.log(`  Updates:   journalctl -u agentd-update -f`);
  }
  console.log("");
  console.log("Pair this device — find the token in the log:");
  console.log(
    `  sudo journalctl -u agentd --since "5 minutes ago" | grep 'token:'`,
  );
  console.log(`Then from the other device:`);
  console.log(`  agentd pair --server ${url} --token <token>`);
}

// ----- macOS (launchd) ------------------------------------------------------

function macosPlistPath(opts: Opts) {
  return `${opts.userHome}/Library/LaunchAgents/sh.bun.agentd.plist`;
}
function macosUpdatePlistPath(opts: Opts) {
  return `${opts.userHome}/Library/LaunchAgents/sh.bun.agentd-update.plist`;
}

function installMacos(opts: Opts) {
  if (!opts.dryRun) mkdirSync(opts.dataDir, { recursive: true });
  writeFile(macosPlistPath(opts), renderMacosPlist(opts), 0o644, opts);
  if (opts.autoUpdate) {
    writeFile(
      macosUpdatePlistPath(opts),
      renderMacosUpdatePlist(opts),
      0o644,
      opts,
    );
  }
  run(["launchctl", "load", "-w", macosPlistPath(opts)], opts);
  if (opts.autoUpdate) {
    run(["launchctl", "load", "-w", macosUpdatePlistPath(opts)], opts);
  }
  printPostInstallMacos(opts);
}

function uninstallMacos(opts: Opts) {
  for (const p of [macosPlistPath(opts), macosUpdatePlistPath(opts)]) {
    if (existsSync(p)) {
      run(["launchctl", "unload", "-w", p], opts);
      if (opts.dryRun) {
        console.log(`[dry-run] would rm ${p}`);
      } else {
        rmSync(p);
        console.log(`rm ${p}`);
      }
    }
  }
  console.log(
    `\nagentd service removed. Your data at ${opts.dataDir} is untouched.`,
  );
}

function statusMacos(opts: Opts) {
  void opts;
  spawnSync("launchctl", ["list", "sh.bun.agentd"], { stdio: "inherit" });
}

function renderMacosPlist(opts: Opts): string {
  const hostFlag = opts.publicBind ? "0.0.0.0" : "127.0.0.1";
  const bunDir = resolve(opts.bunBin, "..");
  const logPath = `${opts.dataDir}/agentd.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.bun.agentd</string>

  <key>ProgramArguments</key>
  <array>
    <string>${opts.bunBin}</string>
    <string>${opts.agentdEntry}</string>
    <string>serve</string>
    <string>--host</string>
    <string>${hostFlag}</string>
    <string>--port</string>
    <string>${opts.port}</string>
    <string>--root</string>
    <string>${opts.dataDir}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${bunDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${opts.userHome}/.local/bin</string>
    <key>HOME</key>
    <string>${opts.userHome}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

function renderMacosUpdatePlist(opts: Opts): string {
  const bunDir = resolve(opts.bunBin, "..");
  const logPath = `${opts.dataDir}/agentd-update.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.bun.agentd-update</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${opts.bunBin} install -g @meszmate/agentd@latest &amp;&amp; /bin/launchctl kickstart -k gui/$(id -u)/sh.bun.agentd</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${bunDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${opts.userHome}</string>
  </dict>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>17</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

function printPostInstallMacos(opts: Opts) {
  if (opts.dryRun) {
    console.log("\n[dry-run] no changes made.");
    return;
  }
  const url = opts.publicBind
    ? `http://${hostname()}:${opts.port}`
    : `http://127.0.0.1:${opts.port}`;
  console.log("");
  console.log("agentd installed and running.");
  console.log(`  URL:       ${url}`);
  console.log(`  Data dir:  ${opts.dataDir}`);
  console.log(`  Logs:      tail -f ${opts.dataDir}/agentd.log`);
  if (opts.autoUpdate) {
    console.log(`  Updates:   tail -f ${opts.dataDir}/agentd-update.log`);
  }
  console.log("");
  console.log("Pair this device — find the token in the log:");
  console.log(`  grep -i 'token:' ${opts.dataDir}/agentd.log`);
  console.log(`Then from the other device:`);
  console.log(`  agentd pair --server ${url} --token <token>`);
}
