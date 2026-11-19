const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_BATCH = 200;
const MAX_BODY = 256 * 1024;
const DEVICE = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const DIGEST = /^[\da-f]{64}$/;
const MODEL = /^[\p{L}\p{N}][\p{L}\p{N} ._()+:-]{0,95}$/u;
const jsonHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (data, status = 200, headers = {}) => Response.json(data, {
  status, headers: { ...jsonHeaders, ...headers }
});

class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function check(condition, message, status = 400) {
  if (!condition) throw new InputError(status, message);
}

function label(value, limit, field, required = false) {
  check(typeof value === 'string' && value.trim().length <= limit && !/[\x00-\x1F\x7F]/.test(value), field);
  const trimmed = value.trim();
  check(!required || trimmed.length, field);
  return trimmed;
}

function integer(value, min, max, field) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, field);
  return value;
}

function identifier(value, pattern, field) {
  check(typeof value === 'string' && pattern.test(value), field);
  return value;
}

async function authorize(header, secret) {
  if (!secret || !header?.startsWith('Bearer ') || header.length > 520) return false;
  const encode = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([encode(header.slice(7)), encode(secret)]);
  const provided = new Uint8Array(a);
  const expected = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= provided[i] ^ expected[i];
  return mismatch === 0;
}

async function readBody(request) {
  check(request.body, 'JSON body required');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let data = '';
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new InputError(413, 'Request body too large');
    }
    data += decoder.decode(value, { stream: true });
  }
  let body;
  try { body = JSON.parse(data + decoder.decode()); } catch { throw new InputError(400, 'Invalid JSON'); }
  check(body && typeof body === 'object' && !Array.isArray(body), 'Invalid JSON object');
  return body;
}

const membersQuery = `SELECT m.id, m.name, m.color, m.note, m.archived, m.created_at AS createdAt,
  count(d.device_id) AS deviceCount FROM members m LEFT JOIN devices d ON d.member_id=m.id
  GROUP BY m.id ORDER BY m.archived, m.name COLLATE NOCASE`;
const devicesQuery = `SELECT device_id AS deviceId, member_id AS memberId, device_name AS deviceName,
  platform, app_version AS appVersion, last_seen_at AS lastSeenAt FROM devices ORDER BY device_name`;

function memberFields(body, existing = {}) {
  return {
    name: label(body.name ?? existing.name, 64, 'Invalid member name', true),
    color: identifier(body.color ?? existing.color ?? '#4179c5', /^#[\da-f]{6}$/i, 'Invalid color'),
    note: label(body.note ?? existing.note ?? '', 180, 'Invalid note'),
    archived: body.archived === undefined ? existing.archived ?? 0 : Number(body.archived === true)
  };
}

async function saveMember(db, body, id, now) {
  const existing = id ? (await db.all('SELECT * FROM members WHERE id=?', id))[0] : null;
  check(!id || existing, 'Member not found', 404);
  const { name, color, note, archived } = memberFields(body, existing || {});
  try {
    if (id) {
      await db.batch([['UPDATE members SET name=?,color=?,note=?,archived=? WHERE id=?', name, color, note, archived, id]]);
    } else {
      id = crypto.randomUUID();
      await db.batch([['INSERT INTO members (id,name,color,note,created_at) VALUES (?,?,?,?,?)', id, name, color, note, now]]);
    }
  } catch (error) {
    if (/UNIQUE constraint failed: members.name/i.test(error.message)) throw new InputError(409, 'Member name is already in use');
    throw error;
  }
  return { id, name, color, note, archived };
}

async function saveDevice(db, body, id, now, register) {
  identifier(id, DEVICE, 'Invalid device ID');
  const existing = (await db.all('SELECT * FROM devices WHERE device_id=?', id))[0];
  check(existing || register, 'Device not found', 404);
  const memberId = identifier(body.memberId ?? existing?.member_id, DEVICE, 'Invalid member ID');
  const deviceName = label(body.deviceName ?? existing?.device_name, 64, 'Invalid device name', true);
  if (register || memberId !== existing?.member_id) {
    const member = (await db.all('SELECT archived FROM members WHERE id=?', memberId))[0];
    check(member && !member.archived, 'Member is unavailable', 404);
  }
  const statements = [];
  if (register) {
    const platform = identifier(body.platform, /^(darwin|win32|linux)$/, 'Invalid platform');
    const version = label(body.appVersion ?? '', 32, 'Invalid app version');
    statements.push([`INSERT INTO devices VALUES (?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET
      member_id=excluded.member_id, device_name=excluded.device_name, platform=excluded.platform,
      app_version=excluded.app_version, last_seen_at=excluded.last_seen_at`, id, memberId, deviceName, platform, version, now, now]);
  } else {
    statements.push(['UPDATE devices SET member_id=?, device_name=? WHERE device_id=?', memberId, deviceName, id]);
  }
  if (body.migrateHistory === true) {
    statements.push(['UPDATE usage_events SET member_id=? WHERE device_id=?', memberId, id]);
  }
  await db.batch(statements);
  return { deviceId: id, memberId, deviceName };
}

function cleanEvent(event, now) {
  check(event && typeof event === 'object', 'Invalid event');
  const cost = event.costUSD ?? null;
  check(cost === null || (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= 100_000), 'Invalid API cost');
  return {
    id: identifier(event.eventId, DIGEST, 'Invalid event ID'),
    account: identifier(event.accountScopeKey, DIGEST, 'Invalid account key'),
    alias: label(event.accountAlias ?? '', 48, 'Invalid account alias'),
    scope: identifier(event.poolScope, /^(shared|personal)$/, 'Invalid event scope'),
    time: integer(event.timestamp, 0, now + DAY, 'Invalid event time'),
    source: identifier(event.source, /^(desktop|cli)$/, 'Invalid source'),
    model: identifier(event.model, MODEL, 'Invalid model name'),
    input: integer(event.inputTokens, 0, 1_000_000_000, 'Invalid input tokens'),
    cache: integer(event.cacheReadTokens, 0, 1_000_000_000, 'Invalid cache tokens'),
    output: integer(event.outputTokens, 0, 1_000_000_000, 'Invalid output tokens'),
    thinking: integer(event.thinkingTokens, 0, 1_000_000_000, 'Invalid thinking tokens'),
    total: integer(event.totalTokens, 0, 3_000_000_000, 'Invalid total tokens'),
    cost
  };
}

function cleanSnapshot(snapshot, now) {
  check(snapshot && snapshot.poolScope === 'shared', 'Invalid quota scope');
  const account = identifier(snapshot.accountScopeKey, DIGEST, 'Invalid quota account');
  const alias = label(snapshot.accountAlias ?? '', 48, 'Invalid quota alias');
  const observedAt = integer(snapshot.observedAt, 1, now + DAY, 'Invalid quota time');
  check(Array.isArray(snapshot.windows) && snapshot.windows.length > 0 && snapshot.windows.length <= 30, 'Invalid quota windows');
  const windows = snapshot.windows.map(window => {
    check(window && typeof window === 'object', 'Invalid quota window');
    check(typeof window.remainingPct === 'number' && window.remainingPct >= 0 && window.remainingPct <= 100, 'Invalid quota percentage');
    return {
      pool: identifier(window.pool, MODEL, 'Invalid pool'),
      window: identifier(window.window, /^(5h|weekly)$/, 'Invalid window'),
      remainingPct: window.remainingPct,
      resetAt: window.resetAt == null ? null : integer(window.resetAt, 1, now + 365 * DAY, 'Invalid quota reset')
    };
  });
  return { account, alias, observedAt, windows };
}

const insertEvents = `INSERT INTO usage_events (
    event_id,device_id,member_id,account_scope_key,account_alias,pool_scope,timestamp_ms,source,model,
    input_tokens,cache_read_tokens,output_tokens,thinking_tokens,total_tokens,cost_usd,revision
  )
  SELECT value->>'id', d.device_id,d.member_id,value->>'account',value->>'alias',value->>'scope',
    value->>'time',value->>'source',value->>'model',value->>'input',value->>'cache',value->>'output',
    value->>'thinking',value->>'total',value->>'cost',?
  FROM json_each(?) j JOIN devices d ON d.device_id=?
  WHERE NOT EXISTS (
    SELECT 1 FROM usage_retractions r WHERE r.device_id=d.device_id AND r.event_id=j.value->>'id' AND r.revision>=?
  )
  ON CONFLICT(event_id) DO UPDATE SET account_scope_key=excluded.account_scope_key,
    account_alias=excluded.account_alias,pool_scope=excluded.pool_scope,timestamp_ms=excluded.timestamp_ms,
    source=excluded.source,model=excluded.model,input_tokens=excluded.input_tokens,
    cache_read_tokens=excluded.cache_read_tokens,output_tokens=excluded.output_tokens,
    thinking_tokens=excluded.thinking_tokens,total_tokens=excluded.total_tokens,
    cost_usd=excluded.cost_usd,revision=excluded.revision
  WHERE usage_events.device_id=excluded.device_id AND usage_events.revision<excluded.revision`;

async function sync(db, body, now) {
  const id = identifier(body.deviceId, DEVICE, 'Invalid device ID');
  const revision = integer(body.revision, 1, now + DAY, 'Invalid revision');
  const raw = body.events ?? [];
  const removed = body.removeEventIds ?? [];
  const quotaKeys = body.removeQuotaKeys ?? [];
  check(Array.isArray(raw) && Array.isArray(removed) && raw.length + removed.length <= MAX_BATCH, 'Batch exceeds 200 events');
  check(Array.isArray(quotaKeys) && quotaKeys.length <= MAX_BATCH, 'Too many account keys');
  const events = raw.map(event => cleanEvent(event, now));
  const removeEventIds = JSON.stringify(removed.map(key => identifier(key, DIGEST, 'Invalid retraction ID')));
  const removeQuotaKeys = JSON.stringify(quotaKeys.map(key => identifier(key, DIGEST, 'Invalid quota account')));
  check(new Set(events.map(event => event.id).concat(removed)).size === raw.length + removed.length, 'Duplicate event in batch');
  const quota = body.quotaSnapshot == null ? null : cleanSnapshot(body.quotaSnapshot, now);
  check(!quota || !quotaKeys.includes(quota.account), 'Conflicting quota actions');

  const device = (await db.all('SELECT member_id FROM devices WHERE device_id=?', id))[0];
  check(device, 'Register the device before syncing', 409);
  const statements = [['UPDATE devices SET last_seen_at=? WHERE device_id=?', now, id]];
  if (removed.length) {
    statements.push([`INSERT INTO usage_retractions SELECT ?,value,? FROM json_each(?) WHERE true
      ON CONFLICT(device_id,event_id) DO UPDATE SET revision=max(revision,excluded.revision)`, id, revision, removeEventIds]);
    statements.push([`DELETE FROM usage_events WHERE device_id=? AND revision<=?
      AND event_id IN (SELECT value FROM json_each(?))`, id, revision, removeEventIds]);
  }
  const eventStatement = statements.length;
  if (events.length) statements.push([insertEvents, revision, JSON.stringify(events), id, revision]);
  if (quotaKeys.length) {
    // Keep an empty tombstone to prevent a delayed snapshot from recreating a withdrawn row.
    statements.push([`INSERT INTO quota_snapshots SELECT ?,value,'',?,'[]' FROM json_each(?) WHERE true
      ON CONFLICT (device_id,account_scope_key) DO UPDATE SET account_alias='',observed_at=excluded.observed_at,windows_json='[]'
      WHERE quota_snapshots.observed_at<=excluded.observed_at`, id, revision, removeQuotaKeys]);
  }
  if (quota) {
    statements.push([`INSERT INTO quota_snapshots VALUES (?,?,?,?,?)
      ON CONFLICT (device_id,account_scope_key) DO UPDATE SET account_alias=excluded.account_alias,
        observed_at=excluded.observed_at,windows_json=excluded.windows_json
      WHERE quota_snapshots.observed_at<excluded.observed_at`,
    id, quota.account, quota.alias, quota.observedAt, JSON.stringify(quota.windows)]);
  }
  const result = await db.batch(statements);
  return { accepted: events.length, updated: events.length ? result[eventStatement] : 0, serverTime: now };
}

const sums = `count(*) AS calls, sum(input_tokens) AS inputTokens, sum(cache_read_tokens) AS cacheReadTokens,
  sum(output_tokens) AS outputTokens, sum(thinking_tokens) AS thinkingTokens, sum(total_tokens) AS totalTokens,
  coalesce(sum(cost_usd),0) AS costUSD, sum(cost_usd IS NULL) AS unpricedCalls`;
const metrics = ['calls', 'inputTokens', 'cacheReadTokens', 'outputTokens', 'thinkingTokens', 'totalTokens', 'costUSD', 'unpricedCalls'];

function reportingRange(params, now) {
  const range = identifier(params.get('range') ?? 'today', /^(5h|today|7d|30d|month|all)$/, 'Invalid range');
  const scope = identifier(params.get('scope') ?? 'shared', /^(shared|personal|all)$/, 'Invalid scope');
  const offset = integer(Number(params.get('tzOffset') ?? 0), -840, 840, 'Invalid time-zone offset') * 60_000;
  const local = new Date(now + offset);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset;
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offset;
  const start = { '5h': now - 5 * HOUR, today: midnight, '7d': midnight - 6 * DAY,
    '30d': midnight - 29 * DAY, month: monthStart, all: 0 }[range];
  const interval = range === 'today' || range === '5h' ? HOUR : DAY;
  return { range, scope, offset, start, interval };
}

async function dashboard(db, params, now, publicView) {
  const { range, scope, offset, start, interval } = reportingRange(params, now);
  const clause = `FROM usage_events WHERE timestamp_ms>=? AND timestamp_ms<=?${scope === 'all' ? '' : ' AND pool_scope=?'}`;
  const args = scope === 'all' ? [start, now] : [start, now, scope];
  const [members, devices, totals, byMember, byAccount, byModel, trend, quotas] = await Promise.all([
    db.all(membersQuery),
    publicView ? [] : db.all(devicesQuery),
    db.all(`SELECT ${sums} ${clause}`, ...args),
    db.all(`SELECT member_id AS memberId,${sums} ${clause} GROUP BY member_id`, ...args),
    publicView ? [] : db.all(`SELECT member_id AS memberId,device_id AS deviceId,account_scope_key AS accountScopeKey,
      max(account_alias) AS accountAlias,pool_scope AS poolScope,${sums} ${clause}
      GROUP BY member_id,device_id,account_scope_key,pool_scope`, ...args),
    db.all(`SELECT member_id AS memberId,model,${sums} ${clause} GROUP BY member_id,model`, ...args),
    db.all(`SELECT CAST((timestamp_ms+?)/? AS INTEGER)*?-? AS timestamp,${sums} ${clause}
      GROUP BY timestamp ORDER BY timestamp DESC LIMIT 366`, offset, interval, interval, offset, ...args),
    db.all(`SELECT * FROM (
      SELECT q.account_scope_key AS accountScopeKey, q.account_alias AS accountAlias, q.observed_at AS observedAt,
        q.windows_json AS windows, d.device_name AS deviceName, m.name AS memberName,
        row_number() OVER (PARTITION BY q.account_scope_key ORDER BY q.observed_at DESC,q.device_id) AS rowNumber
      FROM quota_snapshots q JOIN devices d USING(device_id) JOIN members m ON m.id=d.member_id
      WHERE q.windows_json<>'[]'
    ) WHERE rowNumber=1 ORDER BY observedAt DESC`)
  ]);
  const total = Object.fromEntries(metrics.map(key => [key, totals[0]?.[key] ?? 0]));
  const memberUsage = new Map(byMember.map(row => [row.memberId, row]));
  const used = members.filter(member => !member.archived || memberUsage.has(member.id));
  const memberRows = used.map(member => {
    const aggregate = memberUsage.get(member.id);
    const tally = Object.fromEntries(metrics.map(key => [key, aggregate?.[key] ?? 0]));
    const deviceRows = new Map();
    for (const row of byAccount.filter(account => account.memberId === member.id)) {
      const device = devices.find(item => item.deviceId === row.deviceId);
      if (!deviceRows.has(row.deviceId)) {
        deviceRows.set(row.deviceId, { ...device, accounts: [], ...Object.fromEntries(metrics.map(key => [key, 0])) });
      }
      const summary = deviceRows.get(row.deviceId);
      summary.accounts.push(row);
      for (const key of metrics) summary[key] += row[key];
    }
    const models = byModel.filter(row => row.memberId === member.id).sort((a, b) => b.totalTokens - a.totalTokens);
    const identity = publicView
      ? { id: member.name, name: member.name, color: member.color, archived: member.archived }
      : member;
    return {
      ...identity, ...tally,
      tokenShare: total.totalTokens ? tally.totalTokens / total.totalTokens : 0,
      costShare: total.costUSD ? tally.costUSD / total.costUSD : null,
      devices: [...deviceRows.values()],
      models: publicView ? models.map(({ memberId, ...model }) => model) : models
    };
  });
  const quotaSnapshots = quotas.map(({ rowNumber, windows, observedAt, ...snapshot }) => ({
    ...(publicView ? {} : snapshot), observedAt, windows: JSON.parse(windows)
  }));
  return {
    scope, range, interval, total, members: memberRows, trend: trend.reverse(), quotaSnapshots,
    devices: devices.map(device => ({ ...device, online: now - device.lastSeenAt < 95_000 }))
  };
}

export async function handleRequest(request, { db, secret, html, publicRead = false, now = Date.now }) {
  const url = new URL(request.url);
  const method = request.method;
  const api = url.pathname;
  if (method === 'GET' && api === '/') {
    const page = publicRead ? html.replace('data-public-view="false"', 'data-public-view="true"') : html;
    return new Response(page, { headers: {
      ...jsonHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    } });
  }
  if (method === 'GET' && api === '/api/v1/health') return json({ ok: true, version: 1 });
  if (!api.startsWith('/api/v1/')) return json({ error: 'Not found' }, 404);
  const publicView = method === 'GET' && api === '/api/v1/public-dashboard';
  if (publicView && !publicRead) return json({ error: 'Not found' }, 404);
  if (!publicView) {
    if (!secret) return json({ error: 'Family secret is not configured' }, 503);
    if (!await authorize(request.headers.get('Authorization'), secret)) return json({ error: 'Invalid family secret' }, 401);
  }
  const time = now();
  try {
    if (method === 'GET' && api === '/api/v1/members') return json({ members: await db.all(membersQuery) });
    if (method === 'GET' && api === '/api/v1/devices') return json({ devices: await db.all(devicesQuery) });
    if (method === 'POST' && api === '/api/v1/members') return json(await saveMember(db, await readBody(request), null, time), 201);
    const memberMatch = api.match(/^\/api\/v1\/members\/([^/]+)$/);
    if (method === 'PATCH' && memberMatch) {
      return json(await saveMember(db, await readBody(request), identifier(memberMatch[1], DEVICE, 'Invalid member ID'), time));
    }
    if (method === 'POST' && api === '/api/v1/devices/register') {
      const body = await readBody(request);
      return json(await saveDevice(db, body, body.deviceId, time, true));
    }
    const deviceMatch = api.match(/^\/api\/v1\/devices\/([^/]+)$/);
    if (method === 'PATCH' && deviceMatch) return json(await saveDevice(db, await readBody(request), deviceMatch[1], time, false));
    if (method === 'POST' && api === '/api/v1/sync') return json(await sync(db, await readBody(request), time));
    if (publicView || (method === 'GET' && api === '/api/v1/dashboard')) {
      if (publicView) url.searchParams.set('scope', 'shared');
      const data = await dashboard(db, url.searchParams, time, publicView);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
      const etag = '"' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') + '"';
      const headers = { ETag: etag, ...(publicView ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) };
      if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ...jsonHeaders, ...headers } });
      return json(data, 200, headers);
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    console.error('Family database operation failed:', error.name);
    return json({ error: 'Database operation failed' }, 500);
  }
}
