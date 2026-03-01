#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const useProfile = process.argv[2] === "--profile";
const home = process.env["HOME"];
const cacheDir = `${home}/.cache/scraping`;

if (process.argv[2] && process.argv[2] !== "--profile") {
  console.log("Usage: start.ts [--profile]");
  console.log("\nOptions:");
  console.log(
    "  --profile  Copy your default Chrome profile (cookies, logins)",
  );
  console.log("\nExamples:");
  console.log("  start.ts            # Start with fresh profile");
  console.log("  start.ts --profile  # Start with your Chrome profile");
  process.exit(1);
}

function commandExists(command) {
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getPlatformConfig() {
  if (process.platform === "darwin") {
    return {
      chromeCommand: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      profileSource: `${home}/Library/Application Support/Google/Chrome/`,
    };
  }

  if (process.platform === "linux") {
    if (commandExists("google-chrome")) {
      return {
        chromeCommand: "google-chrome",
        profileSource: `${home}/.config/google-chrome/`,
      };
    }

    if (commandExists("google-chrome-stable")) {
      return {
        chromeCommand: "google-chrome-stable",
        profileSource: `${home}/.config/google-chrome/`,
      };
    }

    if (commandExists("chromium-browser")) {
      return {
        chromeCommand: "chromium-browser",
        profileSource: `${home}/.config/chromium/`,
      };
    }

    if (commandExists("chromium")) {
      return {
        chromeCommand: "chromium",
        profileSource: `${home}/.config/chromium/`,
      };
    }

    console.error("✗ 未找到 Chrome/Chromium，可执行文件不在 PATH");
    process.exit(1);
  }

  console.error(`✗ Unsupported platform: ${process.platform}`);
  process.exit(1);
}

function getListeningPids9222() {
  try {
    return execSync("lsof -tiTCP:9222 -sTCP:LISTEN", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function killAllChromeProcesses() {
  if (process.platform === "darwin") {
    for (const cmd of ["killall 'Google Chrome'", "killall Chromium"]) {
      try {
        execSync(cmd, { stdio: "ignore" });
      } catch {}
    }
    return;
  }

  if (process.platform === "linux") {
    for (const cmd of [
      "killall -q chrome",
      "killall -q chromium",
      "killall -q chromium-browser",
      "killall -q google-chrome",
      "killall -q google-chrome-stable",
    ]) {
      try {
        execSync(cmd, { stdio: "ignore" });
      } catch {}
    }
  }
}

const platformConfig = getPlatformConfig();

if (useProfile) {
  // use profile: kill all Chrome/Chromium instances to avoid profile lock conflicts
  killAllChromeProcesses();
} else {
  // fresh profile: only release :9222 if a Chrome-like process is using it
  for (const pid of getListeningPids9222()) {
    const cmd = execSync(`ps -p ${pid} -o comm=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!/chrome|chromium/i.test(cmd)) {
      console.error(`✗ Port 9222 is occupied by non-Chrome process: pid=${pid}, cmd=${cmd}`);
      process.exit(1);
    }

    process.kill(Number(pid), "SIGTERM");
  }
}

// Wait a bit for processes to fully die
await new Promise((r) => setTimeout(r, 1200));

// Setup profile directory
execSync(`mkdir -p "${cacheDir}"`, { stdio: "ignore" });

if (useProfile) {
  // Sync profile with rsync (much faster on subsequent runs)
  execSync(`rsync -a --delete "${platformConfig.profileSource}" "${cacheDir}/"`, {
    stdio: "pipe",
  });
} else {
  // Fresh mode: ensure user-data-dir is clean
  execSync(`find "${cacheDir}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +`, {
    stdio: "ignore",
  });
}

// Start Chrome in background (detached so Node can exit)
spawn(
  platformConfig.chromeCommand,
  [
    "--remote-debugging-port=9222",
    `--user-data-dir=${cacheDir}`,
    "--profile-directory=Default",
    "--disable-search-engine-choice-screen",
    "--no-first-run",
    "--disable-features=ProfilePicker",
  ],
  { detached: true, stdio: "ignore" },
).unref();

// Wait for Chrome to be ready by checking the debugging endpoint
let connected = false;
for (let i = 0; i < 30; i++) {
  try {
    const response = await fetch("http://localhost:9222/json/version");
    if (response.ok) {
      connected = true;
      break;
    }
  } catch {}

  await new Promise((r) => setTimeout(r, 500));
}

if (!connected) {
  console.error("✗ Failed to connect to Chrome");
  process.exit(1);
}

// Start background watcher for logs/network (detached)
const scriptDir = dirname(fileURLToPath(import.meta.url));
const watcherPath = join(scriptDir, "watch.js");
spawn(process.execPath, [watcherPath], { detached: true, stdio: "ignore" }).unref();

console.log(
  `✓ Chrome started on :9222${useProfile ? " with your profile" : ""}`,
);
