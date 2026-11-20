const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFamilySync } = require('./meter-family-sync');

test('createFamilySync remembers defaultServerUrl after connect, omits secret in overview, and passes familyWeekly=1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-family-sync-test-'));
  const ledgerPath = path.join(tmpDir, 'ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ calls: {} }));
  const requests = [];
  const memberId = '11111111-1111-4111-8111-111111111111';

  const mockFetch = async (url, opts = {}) => {
    requests.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const route = new URL(url).pathname;
    if (route === '/api/v1/members') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ members: [{ id: memberId, name: 'Caspian', archived: false }] })
      };
    }
    if (route === '/api/v1/devices/register') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true })
      };
    }
    if (route === '/api/v1/dashboard') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ total: { calls: 0, totalTokens: 0, costUSD: 0, unpricedCalls: 0 }, members: [] })
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'not found' })
    };
  };

  try {
    const sync = createFamilySync({ stateDir: tmpDir, ledgerPath, fetch: mockFetch });
    const secret = 'test_family_secret_0123456789abcdef';

    // 1. Connect remembers serverUrl as default on this machine without requiring save yet
    const conn = await sync.action({
      action: 'connect',
      serverUrl: 'https://example-family.test',
      familySecret: secret
    });
    assert.equal(conn.ok, true);

    const overviewBeforeSave = await sync.action({ action: 'overview' });
    assert.equal(overviewBeforeSave.ok, true);
    assert.equal(overviewBeforeSave.data.serverUrl, 'https://example-family.test');
    assert.equal(overviewBeforeSave.data.hasDefaultServerUrl, true);
    assert.equal(overviewBeforeSave.data.familySecret, undefined);
    assert.equal(overviewBeforeSave.data.hasSecret, false);

    // 2. Save registers device using remembered serverUrl even if serverUrl is left blank
    const saved = await sync.action({
      action: 'save',
      serverUrl: '',
      familySecret: secret,
      memberId,
      deviceName: 'DevBox',
      enabled: true
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.serverUrl, 'https://example-family.test');
    assert.equal(saved.data.hasSecret, true);

    // 3. Dashboard passes familyWeekly=1 and fetches 7d weeklyMembers when range=today
    const dash = await sync.action({ action: 'dashboard', range: 'today', scope: 'shared', tzOffset: 480 });
    assert.equal(dash.ok, true);
    assert.equal(Array.isArray(dash.data.weeklyMembers), true);
    const dashReqs = requests.filter(r => r.url.includes('/api/v1/dashboard'));
    assert.equal(dashReqs.length, 2);
    assert.equal(dashReqs.some(r => new URL(r.url).searchParams.get('familyWeekly') === '1'), true);
    assert.equal(dashReqs.some(r => new URL(r.url).searchParams.get('range') === '7d'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createFamilySync uploads liveRealtimeConfirmed and explicit-timestamp provisional calls while filtering unverified browse timestamps', async () => {
  const { buildAccountScopeKey } = require('./meter-collector');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-family-sync-prov-'));
  const ledgerPath = path.join(tmpDir, 'ledger.json');
  const memberId = '11111111-1111-4111-8111-111111111111';
  const scopeKey = buildAccountScopeKey('shared@example.com');
  const liveTs = 1795156017963;
  const reqStartTs = 1795156117000;
  const syncSince = 1795156000000;

  fs.writeFileSync(ledgerPath, JSON.stringify({
    calls: {
      // 1. Real-time Orchestrator (Neon) call lacking transcript created_at, but live-confirmed & session-repaired
      call_neon_live: {
        callId: 'call_neon_live',
        source: 'desktop',
        model: 'Orchestrator (Neon)',
        inputTokens: 500000,
        cacheReadTokens: 3400000,
        outputTokens: 5000,
        totalTokens: 3905000,
        costUSD: 0,
        isPriced: false,
        date: '2026-11-20',
        dateSource: 'provisional',
        dateIsProvisional: true,
        created_at: null,
        timestamp: liveTs,
        liveRealtimeConfirmed: true,
        liveObservedAtMs: liveTs,
        accountScopeKey: scopeKey,
        accountAttributionConfidence: 'repaired_session_window'
      },
      // 2. Provisional date with explicit request startTimeMs
      call_explicit_req_time: {
        callId: 'call_explicit_req_time',
        source: 'desktop',
        model: 'Gemini 4 Carbon',
        inputTokens: 1000,
        cacheReadTokens: 2000,
        outputTokens: 500,
        totalTokens: 3500,
        date: '2026-11-20',
        dateSource: 'provisional',
        dateIsProvisional: true,
        created_at: null,
        requestStartMs: reqStartTs,
        accountScopeKey: scopeKey,
        accountAttributionConfidence: 'repaired_session_window'
      },
      // 3. Old chat opened while browsing (provisional browse Date.now() only, NO liveRealtimeConfirmed, NO explicit time)
      call_old_browse_fake: {
        callId: 'call_old_browse_fake',
        source: 'desktop',
        model: 'Gemini 4 Hydrogen',
        inputTokens: 999999,
        cacheReadTokens: 0,
        outputTokens: 1000,
        totalTokens: 1000999,
        date: '2026-11-20',
        dateSource: 'provisional',
        dateIsProvisional: true,
        created_at: null,
        timestamp: 1795156200000,
        accountScopeKey: scopeKey,
        accountAttributionConfidence: 'live_confirmed_account'
      },
      // 4. Coarse date string without time must stay filtered
      call_coarse_date: {
        callId: 'call_coarse_date',
        source: 'desktop',
        model: 'Gemini 4 Hydrogen',
        inputTokens: 100,
        cacheReadTokens: 0,
        outputTokens: 50,
        totalTokens: 150,
        date: '2026-11-20',
        dateSource: 'explicit_date',
        dateIsProvisional: false,
        created_at: '2026-11-20',
        accountScopeKey: scopeKey,
        accountAttributionConfidence: 'session_window_verified'
      }
    }
  }));

  fs.writeFileSync(path.join(tmpDir, 'family_sync_config.json'), JSON.stringify({
    enabled: true,
    serverUrl: 'https://example-family.test',
    familySecret: 'test_family_secret_0123456789abcdef',
    memberId,
    deviceId: '22222222-2222-4222-8222-222222222222',
    deviceName: 'WinBox',
    since: syncSince,
    accountRules: { [scopeKey]: { mode: 'shared', alias: 'SharedPool' } }
  }));

  const uploadedBatches = [];
  const mockFetch = async (url, opts = {}) => {
    if (new URL(url).pathname === '/api/v1/sync') {
      const body = JSON.parse(opts.body);
      uploadedBatches.push(...(body.events || []));
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ accepted: (body.events || []).length })
      };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
  };

  try {
    const sync = createFamilySync({ stateDir: tmpDir, ledgerPath, fetch: mockFetch, now: () => 1795156300000 });
    const overview = await sync.action({ action: 'overview' });
    assert.equal(overview.ok, true);
    // call_old_browse_fake & call_coarse_date lack reliable event time (2 undated); live/explicit do not count as undated
    assert.equal(overview.data.undatedCount, 2);

    const res = await sync.action({ action: 'sync' });
    assert.equal(res.ok, true);
    assert.equal(res.data.uploaded, 2);
    assert.equal(uploadedBatches.length, 2);
    assert.deepEqual(
      uploadedBatches.map(e => ({ model: e.model, totalTokens: e.totalTokens, timestamp: e.timestamp })).sort((a, b) => a.timestamp - b.timestamp),
      [
        { model: 'Orchestrator (Neon)', totalTokens: 3905000, timestamp: liveTs },
        { model: 'Gemini 4 Carbon', totalTokens: 3500, timestamp: reqStartTs }
      ]
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
