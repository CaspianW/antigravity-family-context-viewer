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
