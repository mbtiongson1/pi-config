/**
 * Completion Sound Extension for Pi
 *
 * Plays audio notification cues when:
 * 1. The main pi agent finishes responding (agent_settled)
 * 2. A subagent task finishes execution (tool_result for 'subagent')
 *
 * Supports Termux (`termux-media-player`), macOS (`afplay`), Linux/ALSA (`aplay`),
 * PulseAudio (`paplay`), mpv, and sox (`play`).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SoundConfig {
  enabled: boolean;
  agentSound: string;
  subagentSound: string;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "sounds.json");

// Default candidate sound files
const DEFAULT_AGENT_SOUND = "/system/media/audio/notifications/Fresh.ogg";
const DEFAULT_SUBAGENT_SOUND = "/system/media/audio/notifications/Bubble.ogg";

function loadConfig(): SoundConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return {
        enabled: data.enabled ?? true,
        agentSound: data.agentSound || DEFAULT_AGENT_SOUND,
        subagentSound: data.subagentSound || DEFAULT_SUBAGENT_SOUND,
      };
    }
  } catch {
    // fallback to defaults on read/parse error
  }
  return {
    enabled: true,
    agentSound: DEFAULT_AGENT_SOUND,
    subagentSound: DEFAULT_SUBAGENT_SOUND,
  };
}

function saveConfig(config: SoundConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    // ignore write errors
  }
}

function playAudioFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  // Detect available playback binary
  const candidates: { bin: string; args: string[] }[] = [
    { bin: "/data/data/com.termux/files/usr/bin/termux-media-player", args: ["play", filePath] },
    { bin: "termux-media-player", args: ["play", filePath] },
    { bin: "afplay", args: [filePath] },
    { bin: "paplay", args: [filePath] },
    { bin: "aplay", args: ["-q", filePath] },
    { bin: "mpv", args: ["--no-video", "--really-quiet", filePath] },
    { bin: "play", args: ["-q", filePath] },
  ];

  for (const candidate of candidates) {
    try {
      if (candidate.bin.startsWith("/")) {
        if (!fs.existsSync(candidate.bin)) continue;
      }
      const child = spawn(candidate.bin, candidate.args, {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      return;
    } catch {
      // try next candidate
    }
  }
}

export default function (pi: ExtensionAPI) {
  let config = loadConfig();

  // 1. Play sound when main agent run completes
  pi.on("agent_settled", async () => {
    if (!config.enabled) return;
    playAudioFile(config.agentSound);
  });

  // 2. Play sound when subagent finishes
  pi.on("tool_result", async (event) => {
    if (!config.enabled) return;
    if (event.toolName === "subagent") {
      playAudioFile(config.subagentSound);
    }
  });

  // Slash command to manage sounds: /sound [toggle | test | test-subagent | status]
  pi.registerCommand("sound", {
    description: "Toggle or test completion sound effects (/sound toggle|test|test-subagent|status)",
    handler: async (args, ctx) => {
      const subcommand = (args || "").trim().toLowerCase();

      if (subcommand === "toggle") {
        config.enabled = !config.enabled;
        saveConfig(config);
        ctx.ui.notify(
          `Completion sounds are now ${config.enabled ? "ENABLED 🔊" : "DISABLED 🔇"}`,
          "info"
        );
      } else if (subcommand === "test" || subcommand === "test-agent") {
        playAudioFile(config.agentSound);
        ctx.ui.notify(`Playing agent completion sound (${path.basename(config.agentSound)})`, "info");
      } else if (subcommand === "test-subagent") {
        playAudioFile(config.subagentSound);
        ctx.ui.notify(`Playing subagent completion sound (${path.basename(config.subagentSound)})`, "info");
      } else {
        ctx.ui.notify(
          `Sound effects: ${config.enabled ? "ENABLED" : "DISABLED"}\n` +
          `• Agent sound: ${config.agentSound}\n` +
          `• Subagent sound: ${config.subagentSound}\n` +
          `Usage: /sound [toggle | test | test-subagent]`,
          "info"
        );
      }
    },
  });
}
