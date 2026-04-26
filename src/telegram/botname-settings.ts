/**
 * Dynamic bot name settings per chat.
 * When enabled, the Telegram bot display name updates to include the active project.
 */

import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { z } from 'zod';

const botnameSettingsSchema = z.object({
  enabled: z.boolean().optional(),
});

const botnameSettingsFileSchema = z.object({
  settings: z.record(z.string(), botnameSettingsSchema),
});

export interface BotNameSettings {
  enabled: boolean;
}

const SETTINGS_DIR = path.join(os.homedir(), '.claudegram');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'botname-settings.json');
const chatBotNameSettings: Map<string, BotNameSettings> = new Map();

function ensureDirectory(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
}

function normalizeSettings(settings?: Partial<BotNameSettings>): BotNameSettings {
  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : config.DYNAMIC_BOT_NAME,
  };
}

function loadSettings(): void {
  ensureDirectory();
  if (!fs.existsSync(SETTINGS_FILE)) return;

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    const result = botnameSettingsFileSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[BotName] Invalid settings file format, starting fresh:', result.error.message);
      return;
    }

    for (const [key, settings] of Object.entries(result.data.settings)) {
      chatBotNameSettings.set(key, normalizeSettings(settings));
    }
  } catch (error) {
    console.error('[BotName] Failed to load settings:', error);
  }
}

function saveSettings(): void {
  ensureDirectory();
  const settings: Record<string, BotNameSettings> = {};
  for (const [key, value] of chatBotNameSettings.entries()) {
    settings[key] = value;
  }

  try {
    atomicWriteFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('[BotName] Failed to save settings:', error);
  }
}

loadSettings();

export function getBotNameSettings(sessionKey: string): BotNameSettings {
  const existing = chatBotNameSettings.get(sessionKey);
  if (existing) return existing;

  const defaults = normalizeSettings();
  chatBotNameSettings.set(sessionKey, defaults);
  saveSettings();
  return defaults;
}

export function setBotNameEnabled(sessionKey: string, enabled: boolean): void {
  const settings = getBotNameSettings(sessionKey);
  settings.enabled = enabled;
  saveSettings();
}

export function isBotNameEnabled(sessionKey: string): boolean {
  return getBotNameSettings(sessionKey).enabled;
}

// ---------------------------------------------------------------------------
// Rate-limited setMyName wrapper
// ---------------------------------------------------------------------------

const MIN_NAME_UPDATE_INTERVAL_MS = 60_000; // 1 minute
let lastNameUpdateTime = 0;
let pendingName: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Rate-limited wrapper around `bot.api.setMyName()`.
 * At most one call per minute; if called more frequently the latest name is
 * queued and applied when the cooldown expires.
 */
export async function rateLimitedSetMyName(
  apiCall: (name: string) => Promise<unknown>,
  name: string,
): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastNameUpdateTime;

  if (elapsed >= MIN_NAME_UPDATE_INTERVAL_MS) {
    // Cooldown expired — apply immediately
    lastNameUpdateTime = now;
    pendingName = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    await apiCall(name);
  } else {
    // Still in cooldown — queue the latest name
    pendingName = name;
    if (!pendingTimer) {
      const delay = MIN_NAME_UPDATE_INTERVAL_MS - elapsed;
      pendingTimer = setTimeout(async () => {
        pendingTimer = null;
        if (pendingName !== null) {
          const queuedName = pendingName;
          pendingName = null;
          lastNameUpdateTime = Date.now();
          try {
            await apiCall(queuedName);
          } catch (err) {
            console.error('[BotName] Deferred name update failed:', err instanceof Error ? err.message : err);
          }
        }
      }, delay);
    }
  }
}
