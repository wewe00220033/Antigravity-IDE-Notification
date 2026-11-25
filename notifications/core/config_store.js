'use strict';

/**
 * Dynamic JSON configuration and state store with schema fallback and self-healing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG = require('../config/default_config.json');

const EVENT_KEYS = Object.freeze([
  'finished',
  'askQuestion',
  'runCommand',
  'openBrowserUrl',
  'permission',
  'unknown',
]);

const VALID_SOUND_MODES = new Set([
  'respectPayload',
  'windows',
  'antigravity',
  'both',
  'silent',
]);

/**
 * Resolve the persistent notification runtime directory outside resources/app/.
 * @param {string} [customHome] Optional override directory for tests.
 * @returns {string}
 */
function getDataDir(customHome) {
  if (customHome) return path.resolve(customHome);
  if (process.env.AGY_NOTIF_HOME) return path.resolve(process.env.AGY_NOTIF_HOME);
  return path.join(os.homedir(), '.antigravity-notifications');
}

function getConfigPath(customHome) {
  return path.join(getDataDir(customHome), 'config.json');
}

function getStatePath(customHome) {
  return path.join(getDataDir(customHome), 'state.json');
}

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge partial or older config safely onto the versioned default schema.
 * Invalid fields fall back cleanly without crashing callers.
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
function normalizeConfig(raw) {
  const base = cloneDefaultConfig();
  if (!isPlainObject(raw)) return base;

  const boolKeys = [
    'enabled',
    'notifyWhenFocused',
    'notifySameActiveChat',
    'showOpenChatBannerInSameChat',
    'autoPatchOnUpdate',
    'promptReloadAfterUpdate',
  ];
  for (const key of boolKeys) {
    if (typeof raw[key] === 'boolean') {
      base[key] = raw[key];
    }
  }

  if (typeof raw.soundMode === 'string' && VALID_SOUND_MODES.has(raw.soundMode)) {
    // Migrate v1 auto-default 'respectPayload' (which silenced Windows Toast when webview audio was blocked) to 'windows'
    if (raw.schemaVersion === 1 && raw.soundMode === 'respectPayload') {
      base.soundMode = 'windows';
    } else {
      base.soundMode = raw.soundMode;
    }
  }

  if (typeof raw.dedupeWindowMs === 'number' && Number.isFinite(raw.dedupeWindowMs) && raw.dedupeWindowMs >= 0) {
    base.dedupeWindowMs = Math.min(60000, Math.round(raw.dedupeWindowMs));
  }

  if (Array.isArray(raw.stripPrefixes)) {
    base.stripPrefixes = raw.stripPrefixes.filter((item) => typeof item === 'string' && item.length > 0);
  }

  if (typeof raw.fallbackFinishedText === 'string' && raw.fallbackFinishedText.trim()) {
    base.fallbackFinishedText = raw.fallbackFinishedText.trim();
  }

  if (isPlainObject(raw.events)) {
    for (const evt of EVENT_KEYS) {
      const candidate = raw.events[evt];
      if (!isPlainObject(candidate)) continue;
      if (typeof candidate.enabled === 'boolean') {
        base.events[evt].enabled = candidate.enabled;
      }
      if (typeof candidate.titleTemplate === 'string') {
        base.events[evt].titleTemplate = candidate.titleTemplate;
      }
      if (typeof candidate.bodyTemplate === 'string') {
        base.events[evt].bodyTemplate = candidate.bodyTemplate;
      }
    }
  }

  return base;
}

/**
 * Load config.json, creating it from defaults on first run or falling back if corrupted.
 * @param {string} [customHome]
 * @returns {{ config: typeof DEFAULT_CONFIG, configPath: string, error: string | null }}
 */
function loadConfig(customHome) {
  const configPath = getConfigPath(customHome);
  try {
    if (!fs.existsSync(configPath)) {
      const fresh = cloneDefaultConfig();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
      return { config: fresh, configPath, error: null };
    }
    const rawText = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawText);
    return { config: normalizeConfig(parsed), configPath, error: null };
  } catch (err) {
    return {
      config: cloneDefaultConfig(),
      configPath,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Persist config safely via atomic temp write when supported.
 * @param {unknown} nextConfig
 * @param {string} [customHome]
 * @returns {typeof DEFAULT_CONFIG}
 */
function saveConfig(nextConfig, customHome) {
  const normalized = normalizeConfig(nextConfig);
  const configPath = getConfigPath(customHome);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, configPath);
  return normalized;
}

/**
 * Read persisted state.json cleanly (version fingerprints and backup map).
 * @param {string} [customHome]
 * @returns {{ schemaVersion: number, installations: Record<string, any> }}
 */
function loadState(customHome) {
  const statePath = getStatePath(customHome);
  const empty = { schemaVersion: 1, installations: {} };
  try {
    if (!fs.existsSync(statePath)) return empty;
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!isPlainObject(parsed)) return empty;
    return {
      schemaVersion: 1,
      installations: isPlainObject(parsed.installations) ? parsed.installations : {},
    };
  } catch (_) {
    return empty;
  }
}

/**
 * Persist state.json safely.
 * @param {object} nextState
 * @param {string} [customHome]
 */
function saveState(nextState, customHome) {
  const statePath = getStatePath(customHome);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp.${process.pid}`;
  const payload = {
    schemaVersion: 1,
    installations: isPlainObject(nextState && nextState.installations) ? nextState.installations : {},
  };
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, statePath);
  return payload;
}

/**
 * Extract the minimal public config object exposed to the webview runtime.
 * @param {typeof DEFAULT_CONFIG} config
 */
function toWebviewConfig(config) {
  const normalized = normalizeConfig(config);
  const stripFinishedPrefix = Array.isArray(normalized.stripPrefixes) && normalized.stripPrefixes.length > 0;
  return {
    enabled: normalized.enabled,
    notifyWhenFocused: normalized.notifyWhenFocused,
    notifySameActiveChat: normalized.notifySameActiveChat,
    soundMode: normalized.soundMode,
    stripFinishedPrefix,
    fallbackFinishedText: normalized.fallbackFinishedText,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  EVENT_KEYS,
  VALID_SOUND_MODES,
  getDataDir,
  getConfigPath,
  getStatePath,
  cloneDefaultConfig,
  normalizeConfig,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  toWebviewConfig,
};
