'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash, createHmac } = require('node:crypto');
const { getStateDir } = require('./asar-engine');
const { safeReadJsonSync, safeWriteJsonSync, acquireSyncFileLock } = require('./meter-storage');
const { buildAccountScopeKey, getPricingLedgerPath, isSyntheticCall, fetchQuotaSnapshotFromHost } = require('./meter-collector');
const { calculateRequestApiCost } = require('./meter-core');
const { PROJECT_VERSION } = require('./modules-config');

const DAY = 86_400_000;
const HEARTBEAT = 180_000;
const SYNC_TICK_MS = 60_000;
const QUOTA_SYNC_INTERVAL = 120_000;
const QUOTA_UNCHANGED_TTL = 300_000;
const LEDGER_DEBOUNCE_MS = 12_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const DASHBOARD_CACHE_TTL = 15_000;
const WEEKLY_CACHE_TTL = 180_000;
const SCOPE_KEY = /^acct_[0-9a-f]{16}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MODEL = /^[\p{L}\p{N}][\p{L}\p{N} ._()+:-]{0,95}$/u;
const MODES = new Set(['shared', 'personal_local_only', 'personal_separate']);
const hash = text => createHash('sha256').update(text).digest('hex');
const isScopeKey = key => typeof key === 'string' && SCOPE_KEY.test(key);

function read(file, fallback) {
  const result = safeReadJsonSync(file, fallback);
  if (!result.ok || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
    throw new Error('Cannot read family sync data or local ledger');
  }
  return result.data;
}

const privateFs = Object.create(fs);
privateFs.writeFileSync = (file, data, encoding) => fs.writeFileSync(file, data, { encoding, mode: 0o600 });

function write(file, data) {
  const result = safeWriteJsonSync(file, data, { indent: 0, fs: privateFs });
  if (!result.ok) throw new Error('Cannot save family sync data');
}

function serverOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid server URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS origin or a local loopback URL');
  }
  return url.origin;
}

function cleanLabel(value, length, label, required = false) {
  if (typeof value !== 'string' || value.trim().length > length || /[\x00-\x1f\x7f@]/.test(value) ||
      (required && !value.trim())) throw new Error('Invalid ' + label);
  return value.trim();
}

function normalizeConnection(input, current) {
  const rawServerUrl = (typeof input.serverUrl === 'string' && input.serverUrl.trim())
    || current.serverUrl
    || current.defaultServerUrl
    || '';
  const serverUrl = serverOrigin(rawServerUrl);
  const secret = input.familySecret || (serverUrl === current.serverUrl ? current.familySecret : '');
  if (typeof secret !== 'string' || !/^[!-~]{24,512}$/.test(secret)) throw new Error('Enter a valid family secret');
  return { serverUrl, familySecret: secret };
}

function masked(email) {
  const at = String(email || '').indexOf('@');
  return at > 0 ? String(email).slice(0, 2) + '•••' + String(email).slice(at) : '';
}

function accountKey(secret, scopeKey) {
  return createHmac('sha256', secret).update('family-account:' + scopeKey).digest('hex');
}

function parseEventTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const ms = raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
    return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d{10,13}(?:\.\d+)?$/.test(str)) {
    const num = Number(str);
    if (!Number.isFinite(num) || num <= 0) return null;
    const ms = num < 1e11 ? Math.round(num * 1000) : Math.round(num);
    return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
  }
  if (!/T\d{2}:\d{2}/.test(str)) return null;
  const value = Date.parse(str);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function eventTime(call) {
  if (!call || typeof call !== 'object') return null;
  const isProv = Boolean(call.dateIsProvisional || call.dateSource === 'provisional');
  if (!isProv) {
    return parseEventTimestamp(call.created_at ?? call.timestampMs ?? call.timestamp);
  }
  // Provisional date only indicates the RPC lacked created_at at capture time.
  // Trust explicit request bounds or live-confirmed observation timestamps, while still rejecting browse-time Date.now() on old chats.
  const explicit = call.created_at ?? call.createdAt ?? call.requestEndMs ?? call.endTimeMs ?? call.endTime ??
    call.completedAt ?? call.requestStartMs ?? call.startTimeMs ?? call.startTime ?? call.startedAt;
  const explicitMs = parseEventTimestamp(explicit);
  if (explicitMs !== null) return explicitMs;
  if (call.liveRealtimeConfirmed === true) {
    const liveMs = parseEventTimestamp(call.liveObservedAtMs ?? call.timestampMs ?? call.timestamp);
    if (liveMs !== null) return liveMs;
  }
  if (call.accountAttributionConfidence === 'repaired_session_window' ||
      call.accountAttributionConfidence === 'session_window_verified') {
    const verifiedObs = parseEventTimestamp(call.liveObservedAtMs);
    if (verifiedObs !== null) return verifiedObs;
  }
  return null;
}

function eventForCall(eventId, call, timestamp, scopeKey, rule, secret) {
  const price = calculateRequestApiCost(call);
  const costUSD = call.isPriced !== false && price.isPriced && Number.isFinite(price.costUSD) &&
    price.costUSD >= 0 && price.costUSD <= 100_000 ? price.costUSD : null;
  const normalCount = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1e9 ? Number(value) : 0;
  const inputTokens = normalCount(call.inputTokens ?? call.input_tokens ?? call.input);
  const cacheReadTokens = normalCount(call.cacheTokens ?? call.cacheReadTokens ?? call.cache_read_tokens ?? call.cached);
  const outputTokens = normalCount(call.outputTokens ?? call.output_tokens ?? call.output);
  const thinkingTokens = normalCount(call.thinkingTokens ?? call.thinking_output_tokens ?? call.thinking);
  const model = [call.modelLabel, call.model, call.modelKey].find(value => typeof value === 'string' && MODEL.test(value)) || 'Unknown';
  return {
    eventId,
    accountScopeKey: accountKey(secret, scopeKey),
    accountAlias: rule.alias,
    poolScope: rule.mode === 'shared' ? 'shared' : 'personal',
    timestamp,
    source: call.source === 'cli' ? 'cli' : 'desktop',
    model,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    totalTokens: (inputTokens + cacheReadTokens + outputTokens) || normalCount(call.totalTokens),
    costUSD
  };
}

function getSnapshot(result, config, now) {
  if (!result?.ok || result.error || !Array.isArray(result.snapshot?.pools)) return null;
  // accountScopeKey can fall back to the previous account after a partial host response.
  const email = result._raw?.planStatus?.email;
  if (typeof email !== 'string' || !email) return null;
  const key = buildAccountScopeKey(email);
  if (key !== result.accountScopeKey || config.accountRules[key]?.mode !== 'shared') return null;
  const observedAt = result.fetchedAtMs;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now + DAY || now - observedAt > 90_000) return null;
  const windows = [];
  for (const pool of result.snapshot.pools) {
    const poolLabel = [pool.title, pool.poolKey].find(value => typeof value === 'string' && MODEL.test(value));
    if (!poolLabel || !Array.isArray(pool.buckets)) continue;
    for (const bucket of pool.buckets) {
      if (!['5h', 'weekly'].includes(bucket.windowKey)) continue;
      const fraction = bucket.remainingFraction;
      if (typeof fraction !== 'number' || fraction < 0 || fraction > 1 || !Number.isFinite(fraction)) continue;
      const reset = bucket.resetAtMs;
      windows.push({ pool: poolLabel, window: bucket.windowKey, remainingPct: Math.round(fraction * 1000) / 10,
        resetAt: Number.isSafeInteger(reset) && reset > 0 && reset <= now + 365 * DAY ? reset : null });
      if (windows.length === 30) break;
    }
    if (windows.length === 30) break;
  }
  return windows.length ? { key, payload: { accountScopeKey: accountKey(config.familySecret, key),
    accountAlias: config.accountRules[key].alias, poolScope: 'shared', observedAt, windows } } : null;
}

function hasTrustedServerWeeklyPools(data, nowTs = Date.now()) {
  const pools = Array.isArray(data?.familyWeekly) ? data.familyWeekly : [];
  const active = pools.filter(p => p && (!p.expiresAt || Number(p.expiresAt) > nowTs));
  if (!active.length) return false;
  return active.every(p => {
    const usedPct = Number(p.usedPct || 0);
    if (!(usedPct > 0)) return true;
    return (p.basis === 'cost' || p.basis === 'weighted')
      && Array.isArray(p.estimates)
      && p.estimates.length > 0;
  });
}

function createFamilySync({ stateDir, ledgerPath, fetch: send = globalThis.fetch, now = Date.now, readQuota } = {}) {
  const configPath = path.join(stateDir, 'family_sync_config.json');
  const syncPath = path.join(stateDir, 'family_sync_state.json');
  const accountPath = path.join(stateDir, 'accounts_v1.json');
  const defaults = { enabled: false, serverUrl: '', defaultServerUrl: '', familySecret: '', memberId: '', deviceId: '',
    deviceName: os.hostname().replace(/[^\p{L}\p{N} ._-]/gu, '-').slice(0, 64) || 'Desktop',
    accountRules: {}, since: null, revision: 0 };
  let watcher;
  let timer;
  let debounce;
  let lockedInProcess = false;
  let lastQuotaCheckAt = 0;
  const dashboardCache = new Map();
  const weeklyCache = new Map();
  const clearDashboardCaches = () => {
    dashboardCache.clear();
    weeklyCache.clear();
  };

  const getConfig = () => ({ ...defaults, ...read(configPath, defaults) });
  const loadStates = () => read(syncPath, { destinations: {} });
  const uploadKey = cfg => hash(cfg.serverUrl + '\n' + cfg.deviceId);
  function readAccounts(cfg, calls) {
    const store = read(accountPath, {});
    const active = buildAccountScopeKey(store.activeAccountEmail);
    const found = new Map();
    const add = (key, email = '') => {
      if (!isScopeKey(key) || (found.has(key) && !email)) return;
      found.set(key, {
        key, active: key === active, label: masked(email) || '•••' + key.slice(-6),
        mode: cfg.accountRules[key]?.mode ?? '', alias: cfg.accountRules[key]?.alias ?? '', calls: 0
      });
    };
    add(active, store.activeAccountEmail);
    for (const account of Object.values(store.accounts || {})) {
      if (!account || typeof account !== 'object') continue;
      add(account.accountScopeKey || buildAccountScopeKey(account.email), account.email);
    }
    for (const key of Object.keys(cfg.accountRules)) add(key);
    for (const [id, call] of Object.entries(calls)) {
      if (!call || !isScopeKey(call.accountScopeKey) || isSyntheticCall(id, call) || call.isKeepalive) continue;
      add(call.accountScopeKey);
      found.get(call.accountScopeKey).calls++;
    }
    return [...found.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label));
  }

  function ledgerCalls() {
    return read(ledgerPath, {}).calls || {};
  }

  function view() {
    const cfg = getConfig();
    const { familySecret, accountRules, revision, defaultServerUrl, ...publicConfig } = cfg;
    const effectiveServerUrl = cfg.serverUrl || defaultServerUrl || '';
    const states = loadStates();
    const syncState = states.destinations[uploadKey(cfg)] ?? {};
    const calls = ledgerCalls();
    return {
      ...publicConfig,
      serverUrl: effectiveServerUrl,
      hasDefaultServerUrl: Boolean(effectiveServerUrl),
      hasSecret: Boolean(familySecret),
      lastSyncAt: syncState.lastSyncAt ?? null, lastError: syncState.lastError ?? '',
      accounts: readAccounts(cfg, calls),
      pendingCount: Object.entries(calls).filter(([id, call]) =>
        call && !isSyntheticCall(id, call) && !call.isKeepalive &&
        (call.accountAttributionConfidence === 'unattributed' || !call.accountAttributionConfidence ||
          !isScopeKey(call.accountScopeKey) || !accountRules[call.accountScopeKey])).length,
      undatedCount: Object.entries(calls).filter(([id, call]) =>
        call && !isSyntheticCall(id, call) && !call.isKeepalive && !eventTime(call) &&
        call.accountAttributionConfidence && call.accountAttributionConfidence !== 'unattributed' &&
        ['shared', 'personal_separate'].includes(accountRules[call.accountScopeKey]?.mode)).length
    };
  }

  async function api(cfg, route, { method = 'GET', body } = {}) {
    const origin = serverOrigin(cfg.serverUrl);
    let result;
    try {
      result = await send(origin + '/api/v1/' + route, {
        method,
        headers: { Authorization: 'Bearer ' + cfg.familySecret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(8_000),
        redirect: 'error'
      });
    } catch { throw new Error('Cannot reach family server'); }
    const type = result.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error('Family server returned an unexpected response');
    const response = await result.json();
    if (!result.ok) throw new Error('Family server HTTP ' + result.status + (result.status === 409 ? ' · ' + response.error : ''));
    return response;
  }

  async function exclusive(work, quiet = false) {
    let lock;
    if (!lockedInProcess) {
      try { lock = acquireSyncFileLock(syncPath, 30); } catch {}
    }
    if (!lock) {
      if (quiet) return { busy: true };
      throw new Error('Family sync is busy. Try again in a moment.');
    }
    lockedInProcess = true;
    try { return await work(); }
    finally { lockedInProcess = false; lock.release(); }
  }

  async function save(input) {
    const cfg = getConfig();
    const connection = normalizeConnection(input, cfg);
    const changedServer = connection.serverUrl !== cfg.serverUrl;
    const deviceName = cleanLabel(input.deviceName ?? cfg.deviceName, 64, 'device name', true);
    const memberId = input.memberId ?? cfg.memberId;
    if (typeof memberId !== 'string' || !UUID.test(memberId)) throw new Error('Choose a family member');
    const enabled = input.enabled === undefined ? cfg.enabled : input.enabled === true;
    const deviceId = cfg.deviceId || randomUUID();
    const accountRules = changedServer ? {} : { ...cfg.accountRules };
    if (input.sharedAccountKey !== undefined) {
      const key = input.sharedAccountKey;
      if (!isScopeKey(key) || !readAccounts(cfg, ledgerCalls()).some(account => account.key === key)) {
        throw new Error('Choose a detected local account for family usage');
      }
      accountRules[key] = { mode: 'shared', alias: accountRules[key]?.alias ?? '' };
    }
    const next = { ...cfg, ...connection, defaultServerUrl: connection.serverUrl, deviceId, deviceName, memberId, enabled,
      since: changedServer || cfg.since == null ? now() : cfg.since,
      accountRules, revision: cfg.revision + 1 };
    if (changedServer || !cfg.deviceId || memberId !== cfg.memberId || deviceName !== cfg.deviceName) {
      await api(next, 'devices/register', { method: 'POST', body: {
        deviceId, deviceName, memberId, platform: process.platform, appVersion: PROJECT_VERSION
      } });
    } else if (connection.familySecret !== cfg.familySecret) {
      await api(next, 'members');
    }
    write(configPath, next);
  }

  function setRule(input) {
    const cfg = getConfig();
    const accounts = readAccounts(cfg, ledgerCalls());
    if (!isScopeKey(input.key) || !accounts.some(account => account.key === input.key) ||
        !(input.mode === '' || MODES.has(input.mode))) throw new Error('Invalid account rule');
    const rules = { ...cfg.accountRules };
    if (!input.mode) delete rules[input.key];
    else {
      if (input.mode === 'personal_separate' && cfg.accountRules[input.key]?.mode !== 'personal_separate' &&
          input.allowFamilyVisibility !== true) throw new Error('Confirm visibility to family members');
      rules[input.key] = { mode: input.mode, alias: cleanLabel(input.alias || '', 48, 'account alias') };
    }
    write(configPath, { ...cfg, accountRules: rules, revision: cfg.revision + 1 });
  }

  async function synchronize({ manual = false, automatic = false, origin, range } = {}) {
    return exclusive(async () => {
      let cfg = getConfig();
      if (!cfg.deviceId || (!cfg.enabled && !manual)) return { disabled: true };
      if (range) {
        const dayCount = { '7d': 7, '30d': 30, all: Infinity }[range];
        if (!dayCount) throw new Error('Invalid backfill range');
        cfg = { ...cfg, since: Math.max(0, Math.min(cfg.since, now() - dayCount * DAY)), revision: cfg.revision + 1 };
        write(configPath, cfg);
      }
      const states = loadStates();
      const dest = uploadKey(cfg);
      const syncState = states.destinations[dest] ||= { sent: {}, quotas: {}, revision: 0 };
      const timestamp = now();
      if (automatic && !manual && Number(syncState.nextRetryAt || 0) > timestamp) {
        return { uploaded: 0, skipped: 'backoff' };
      }
      try {
        const work = [];
        const calls = ledgerCalls();
        const activeCallEventIds = new Set();
        const matchedSentByKey = new Map();
        for (const [callId, call] of Object.entries(calls)) {
          if (!call || isSyntheticCall(callId, call) || call.isKeepalive) continue;
          const id = hash(cfg.deviceId + ':' + callId);
          activeCallEventIds.add(id);
          const saved = syncState.sent[id];
          if (saved?.key) {
            matchedSentByKey.set(saved.key, (matchedSentByKey.get(saved.key) || 0) + 1);
          }
        }
        // Revocations are reconstructed from durable acknowledgments even if the ledger was trimmed.
        const revoked = new Set();
        const retract = id => {
          if (revoked.has(id)) return;
          revoked.add(id);
          work.push({ id, remove: true });
        };
        for (const [id, saved] of Object.entries(syncState.sent)) {
          const ruleAllowed = ['shared', 'personal_separate'].includes(cfg.accountRules[saved.key]?.mode);
          const orphanedReconciledKey = !activeCallEventIds.has(id) && (
            saved.syntheticStepKey === true ||
            (matchedSentByKey.get(saved.key) || 0) > 0
          );
          if (!ruleAllowed || orphanedReconciledKey) retract(id);
        }
        for (const [callId, call] of Object.entries(calls)) {
          if (!call || isSyntheticCall(callId, call) || call.isKeepalive) continue;
          const id = hash(cfg.deviceId + ':' + callId);
          const key = call.accountScopeKey;
          const time = eventTime(call);
          const rule = isScopeKey(key) && call.accountAttributionConfidence &&
            call.accountAttributionConfidence !== 'unattributed' ? cfg.accountRules[key] : null;
          if (!rule || rule.mode === 'personal_local_only') {
            if (syncState.sent[id]) retract(id);
            continue;
          }
          if (!time || time < cfg.since || time > timestamp + DAY) continue;
          const event = eventForCall(id, call, time, key, rule, cfg.familySecret);
          const signature = hash(JSON.stringify(event));
          if (syncState.sent[id]?.signature !== signature) {
            revoked.delete(id);
            work.push({ id, key, signature, event, syntheticStepKey: /#[0-9]+/.test(callId) });
          }
        }
        const withdrawQuota = Object.entries(syncState.quotas)
          .filter(([, record]) => cfg.accountRules[record.key]?.mode !== 'shared' ||
            accountKey(cfg.familySecret, record.key) !== record.account)
          .map(([key]) => key);
        let quota = null;
        let quotaWindowsHash = null;
        const shouldFetchQuota = Object.values(cfg.accountRules).some(rule => rule.mode === 'shared') &&
          (manual || timestamp - lastQuotaCheckAt >= QUOTA_SYNC_INTERVAL);
        if (shouldFetchQuota && readQuota) {
          lastQuotaCheckAt = timestamp;
          const result = await readQuota(origin).catch(() => null);
          quota = getSnapshot(result, cfg, timestamp);
          if (quota) {
            const prevQuota = syncState.quotas[quota.payload.accountScopeKey];
            quotaWindowsHash = hash(JSON.stringify(quota.payload.windows.map(w => ({
              pool: w.pool,
              window: w.window,
              remainingPct: w.remainingPct,
              resetBucket: w.resetAt ? Math.round(w.resetAt / 600_000) : null
            }))));
            if (prevQuota && (
              (prevQuota.observedAt || 0) >= quota.payload.observedAt ||
              (!manual && prevQuota.windowsHash === quotaWindowsHash && timestamp - (prevQuota.observedAt || 0) < QUOTA_UNCHANGED_TTL)
            )) {
              quota = null;
              quotaWindowsHash = null;
            }
          }
        }
        const entries = work.filter(item => !item.remove || revoked.has(item.id));
        const heartbeat = timestamp - (syncState.lastSyncAt || 0) >= HEARTBEAT;
        if (!entries.length && !withdrawQuota.length && !quota && !heartbeat && !manual) return { uploaded: 0 };
        let uploaded = 0;
        let removed = 0;
        const count = Math.max(1, Math.ceil(entries.length / 200), Math.ceil(withdrawQuota.length / 200));
        for (let batch = 0; batch < Math.min(count, manual ? count : 4); batch++) {
          const chunk = entries.slice(batch * 200, (batch + 1) * 200);
          const removeQuotaKeys = withdrawQuota.slice(batch * 200, (batch + 1) * 200);
          const quotaSnapshot = batch === 0 ? quota?.payload : undefined;
          const events = chunk.filter(item => !item.remove);
          const removeEventIds = chunk.filter(item => item.remove).map(item => item.id);
          const revision = Math.max(now(), syncState.revision + 1);
          syncState.revision = revision;
          // Mark possibly delivered IDs before sending. A lost reply must not prevent a later withdrawal.
          for (const item of events) syncState.sent[item.id] = { key: item.key, signature: null, syntheticStepKey: Boolean(item.syntheticStepKey) };
          if (quotaSnapshot) {
            syncState.quotas[quotaSnapshot.accountScopeKey] = {
              key: quota.key, account: quotaSnapshot.accountScopeKey, observedAt: null, windowsHash: quotaWindowsHash
            };
          }
          write(syncPath, states);
          const result = await api(cfg, 'sync', { method: 'POST', body: {
            deviceId: cfg.deviceId, revision, events: events.map(item => item.event),
            removeEventIds, removeQuotaKeys, quotaSnapshot
          } });
          if (result.accepted !== events.length) throw new Error('Family server did not acknowledge the batch');
          for (const item of events) syncState.sent[item.id].signature = item.signature;
          for (const id of removeEventIds) delete syncState.sent[id];
          for (const key of removeQuotaKeys) delete syncState.quotas[key];
          if (quotaSnapshot) syncState.quotas[quotaSnapshot.accountScopeKey].observedAt = quotaSnapshot.observedAt;
          syncState.lastSyncAt = now();
          syncState.lastError = '';
          syncState.consecutiveFailures = 0;
          syncState.nextRetryAt = 0;
          write(syncPath, states);
          uploaded += events.length;
          removed += removeEventIds.length;
        }
        if (uploaded > 0 || removed > 0 || quota) clearDashboardCaches();
        return { uploaded, removed };
      } catch (error) {
        syncState.lastError = error.message;
        const failures = (Number(syncState.consecutiveFailures) || 0) + 1;
        syncState.consecutiveFailures = failures;
        const backoffMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.min(failures - 1, 5)));
        syncState.nextRetryAt = now() + backoffMs;
        write(syncPath, states);
        throw error;
      }
    }, automatic);
  }

  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(() => void synchronize({ automatic: true }).catch(() => {}), LEDGER_DEBOUNCE_MS);
    debounce.unref?.();
  }

  function watchLedger() {
    if (watcher) return;
    try {
      watcher = fs.watch(path.dirname(ledgerPath), { persistent: false }, (_type, name) => {
        if (!name || String(name) === path.basename(ledgerPath)) schedule();
      });
      watcher.on('error', () => { watcher.close(); watcher = null; });
    } catch {}
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        if (!getConfig().enabled) {
          watcher?.close();
          watcher = null;
          return;
        }
        watchLedger();
        void synchronize({ automatic: true }).catch(() => {});
      } catch {}
    }, SYNC_TICK_MS);
    timer.unref?.();
    try { if (getConfig().enabled) { watchLedger(); schedule(); } } catch {}
  }

  function stop() {
    clearInterval(timer);
    clearTimeout(debounce);
    timer = null;
    watcher?.close();
    watcher = null;
  }

  async function rememberServerUrl(url) {
    if (!url) return;
    await exclusive(() => {
      const current = getConfig();
      if (current.defaultServerUrl === url) return;
      write(configPath, { ...current, defaultServerUrl: url });
    }, true).catch(() => {});
  }

  async function action(input = {}, origin) {
    try {
      switch (input?.action) {
        case 'overview': return { ok: true, data: view() };
        case 'connect': {
          const current = getConfig();
          const cfg = { ...current, ...normalizeConnection(input, current) };
          const res = await api(cfg, 'members');
          await rememberServerUrl(cfg.serverUrl);
          return { ok: true, data: res };
        }
        case 'createMember': {
          const current = getConfig();
          const cfg = { ...current, ...normalizeConnection(input, current) };
          const res = await api(cfg, 'members', { method: 'POST', body: {
            name: cleanLabel(input.name, 64, 'member name', true)
          } });
          await rememberServerUrl(cfg.serverUrl);
          return { ok: true, data: res };
        }
        case 'save':
          await exclusive(() => save(input));
          clearDashboardCaches();
          if (getConfig().enabled) { watchLedger(); schedule(); }
          else { watcher?.close(); watcher = null; }
          return { ok: true, data: view() };
        case 'rule':
          await exclusive(() => setRule(input));
          clearDashboardCaches();
          if (getConfig().enabled) schedule();
          return { ok: true, data: view() };
        case 'sync': return { ok: true, data: await synchronize({ manual: true, origin }) };
        case 'backfill': return { ok: true, data: await synchronize({ manual: true, origin, range: input.range }) };
        case 'dashboard': {
          const cfg = getConfig();
          const reqRange = input.range || 'today';
          const reqScope = input.scope || 'shared';
          const tzOffset = input.tzOffset ?? 0;
          const force = input.force === true;
          const nowTs = now();
          const dashKey = `${cfg.serverUrl}|${reqRange}|${reqScope}|${tzOffset}`;
          const weekKey = `${cfg.serverUrl}|${reqScope}|${tzOffset}`;
          if (!force) {
            const cached = dashboardCache.get(dashKey);
            if (cached && (nowTs - cached.ts) < DASHBOARD_CACHE_TTL) {
              return { ok: true, data: cached.data };
            }
          }
          const query = new URLSearchParams({
            range: reqRange,
            scope: reqScope,
            tzOffset,
            familyWeekly: '1'
          });
          const data = await api(cfg, 'dashboard?' + query);
          const needWeekly = reqScope !== 'personal'
            && reqRange !== '7d'
            && !hasTrustedServerWeeklyPools(data, nowTs);
          const cachedWeek = !force ? weeklyCache.get(weekKey) : null;
          const hasFreshWeek = Boolean(cachedWeek && (nowTs - cachedWeek.ts) < WEEKLY_CACHE_TTL);
          if (needWeekly) {
            if (hasFreshWeek) {
              data.weeklyMembers = cachedWeek.members;
            } else {
              const weekQuery = new URLSearchParams({
                range: '7d',
                scope: reqScope,
                tzOffset
              });
              const weekData = await api(cfg, 'dashboard?' + weekQuery).catch(() => null);
              if (Array.isArray(weekData?.members)) {
                weeklyCache.set(weekKey, { ts: nowTs, members: weekData.members });
                data.weeklyMembers = weekData.members;
              }
            }
          }
          if (reqRange === '7d' && reqScope !== 'personal' && Array.isArray(data?.members)) {
            weeklyCache.set(weekKey, { ts: nowTs, members: data.members });
          }
          dashboardCache.set(dashKey, { ts: nowTs, data });
          return { ok: true, data };
        }
        default: throw new Error('Unknown family action');
      }
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return { action, start, stop };
}

function createHostFamilySync(getOrigin, backendSource) {
  const readQuota = async requestedOrigin => {
    const origin = requestedOrigin || getOrigin?.();
    if (!origin) return null;
    const { getSharedAccountsManager } = require('./meter-accounts');
    const manager = getSharedAccountsManager({ origin });
    if (manager.isSwitchInFlight()) return null;
    const result = await fetchQuotaSnapshotFromHost({ origin, backendSource });
    return manager.isSwitchInFlight() ? null : result;
  };
  return createFamilySync({ stateDir: getStateDir(), ledgerPath: getPricingLedgerPath(), readQuota });
}

module.exports = { createFamilySync, createHostFamilySync };
