'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { getAppDataDir, isIsolatedTestPath } = require('./asar-engine');

const LOOPBACK_ORIGIN_RE = /^https?:\/\/127\.0\.0\.1:(\d+)$/;

/**
 * 常用本地调试候选端口（兼容 antigravity-hans / 手动 --remote-debugging-port 启动场景）
 */
const HANS_CANDIDATE_PORTS = [58321, 58322, 58323, 58324, 58325];

function isIsolatedTestContext(options = {}) {
  return Boolean(
    (options && (options.appDataDir || options.homeDir || options.platform)) ||
    process.env.AG_METER_TEST_MODE === '1' ||
    process.env.NODE_ENV === 'test' ||
    isIsolatedTestPath(process.env.APPDATA) ||
    isIsolatedTestPath(process.env.AG_METER_STATE_DIR)
  );
}

function isPidAlive(pid, customCheck = null) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (typeof customCheck === 'function') {
    try {
      return Boolean(customCheck(n));
    } catch {
      return false;
    }
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * 解析 Antigravity daemon 目录路径。
 * 严格隔离测试门禁：测试模式或传入隔离 appDataDir/platform 且未显式指定 daemonDir/agDir/homeDir 时返回 null，
 * 绝不读取宿主机真实的 ~/.gemini/antigravity/daemon。
 */
function resolveDaemonDir(options = {}) {
  if (options && typeof options.daemonDir === 'string' && options.daemonDir.trim()) {
    return path.resolve(options.daemonDir.trim());
  }
  if (options && typeof options.agDir === 'string' && options.agDir.trim()) {
    return path.join(path.resolve(options.agDir.trim()), 'daemon');
  }
  if (options && typeof options.homeDir === 'string' && options.homeDir.trim()) {
    return path.join(path.resolve(options.homeDir.trim()), '.gemini', 'antigravity', 'daemon');
  }
  if ((options && options.allowHostDaemon === false) || isIsolatedTestContext(options)) {
    return null;
  }
  return path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
}

function normalizeLoopbackOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') return null;
  try {
    const parsed = new URL(rawOrigin.trim());
    const origin = parsed.origin;
    const m = origin.match(LOOPBACK_ORIGIN_RE);
    if (!m) return null;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return origin;
  } catch {
    return null;
  }
}

function parseExplicitPort(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function inspectDevToolsActivePort(options = {}) {
  const portFile = path.join(getAppDataDir(options), 'Antigravity', 'DevToolsActivePort');
  try {
    const raw = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { exists: true, valid: false, port: null, error: null };
    }
    return { exists: true, valid: true, port, error: null };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, valid: false, port: null, error: null };
    }
    return { exists: false, valid: false, port: null, error };
  }
}

function getDevToolsActivePort(options = {}) {
  const info = inspectDevToolsActivePort(options);
  return info.valid ? info.port : null;
}

/**
 * 按优先级生成候选 CDP 端口列表：
 * 1. 显式传入的 options.port 或环境变量 AG_CDP_PORT
 * 2. 候选回环端口 (58321..58325，仅在非隔离生产环境启用)
 * 3. DevToolsActivePort 文件记录的端口
 */
function getCandidateCdpPorts(options = {}) {
  const ports = [];
  const add = p => {
    const valid = parseExplicitPort(p);
    if (valid && !ports.includes(valid)) ports.push(valid);
  };

  const explicit = parseExplicitPort(options.port ?? process.env.AG_CDP_PORT);
  if (explicit) {
    add(explicit);
    if (options.strictPort === true) return ports;
  }

  const inIsolatedTest =
    Boolean(options && (options.appDataDir || options.homeDir || options.platform)) ||
    process.env.AG_METER_TEST_MODE === '1' ||
    isIsolatedTestPath(process.env.APPDATA) ||
    isIsolatedTestPath(process.env.AG_METER_STATE_DIR);

  if (!inIsolatedTest && options.includeCandidatePorts !== false) {
    for (const p of HANS_CANDIDATE_PORTS) add(p);
  }

  const activePort = getDevToolsActivePort(options);
  if (activePort) add(activePort);

  return ports;
}

function request(url, body, token, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(
      url,
      {
        agent: false,
        rejectUnauthorized: false,
        method: body ? 'POST' : 'GET',
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Connect-Protocol-Version': '1',
              'x-codeium-csrf-token': token
            }
          : {}
      },
      response => {
        let text = '';
        response.on('data', chunk => (text += chunk));
        response.on('end', () =>
          response.statusCode === 200
            ? resolve(text)
            : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
        );
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Local API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

function fetchJsonList(port, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/list',
        agent: false
      },
      res => {
        let text = '';
        res.on('data', chunk => (text += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            const parsed = JSON.parse(text);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP port probe timeout')));
    req.on('error', reject);
  });
}

/**
 * 探测并定位包含 Antigravity 本地主窗口页面的 CDP 端口与页面列表
 */
async function discoverAntigravityCdp(options = {}) {
  const explicit = parseExplicitPort(options.port ?? process.env.AG_CDP_PORT);
  const inIsolatedTest =
    Boolean(options && (options.appDataDir || options.homeDir || options.platform)) ||
    process.env.AG_METER_TEST_MODE === '1' ||
    isIsolatedTestPath(process.env.APPDATA) ||
    isIsolatedTestPath(process.env.AG_METER_STATE_DIR);

  const portFileInfo = inspectDevToolsActivePort(options);
  if (portFileInfo.error) {
    throw portFileInfo.error;
  }

  const candidatePorts = [];
  const addPort = p => {
    const valid = parseExplicitPort(p);
    if (valid && !candidatePorts.includes(valid)) candidatePorts.push(valid);
  };

  if (explicit) {
    addPort(explicit);
  }
  if (!explicit || options.strictPort !== true) {
    if (portFileInfo.valid) addPort(portFileInfo.port);
    if (!inIsolatedTest && options.includeCandidatePorts !== false) {
      for (const p of HANS_CANDIDATE_PORTS) addPort(p);
    }
  }

  if (candidatePorts.length === 0) {
    if (portFileInfo.exists && !portFileInfo.valid) {
      throw new Error('Antigravity 本地连接信息无效，请重新打开客户端');
    }
    throw new Error('Antigravity 本地连接尚未就绪，请稍后重试');
  }

  const timeoutMs = options.timeoutMs || 1500;
  let anyPortResponded = false;

  for (const port of candidatePorts) {
    try {
      const allPages = await fetchJsonList(port, timeoutMs);
      anyPortResponded = true;
      const matchedPages = allPages.filter(
        item => item && item.type === 'page' && Boolean(normalizeLoopbackOrigin(item.url))
      );
      if (matchedPages.length > 0) {
        return {
          port,
          page: matchedPages[0],
          pages: matchedPages,
          allPages
        };
      }
    } catch {
      // 探测下一个候选端口
    }
  }

  if (anyPortResponded) {
    throw new Error('未找到 Antigravity 主窗口，请等待窗口加载后重试');
  }
  if (portFileInfo.exists && !portFileInfo.valid) {
    throw new Error('Antigravity 本地连接信息无效，请重新打开客户端');
  }
  throw new Error('Antigravity 本地连接尚未就绪，请稍后重试');
}

/**
 * 零依赖 RFC 6455 WebSocket 客户端（不发送 Origin 头，仅允许连接本机回环地址，兼容未开启 --remote-allow-origins=* 的 Electron CDP）
 */
function connectCdpWebSocket(wsUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(wsUrl);
    } catch (e) {
      return reject(new Error(`Invalid WebSocket URL: ${wsUrl}`));
    }
    if (parsed.protocol !== 'ws:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) {
      return reject(new Error('仅允许连接本机回环 CDP WebSocket 地址'));
    }
    const port = Number(parsed.port || 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return reject(new Error('无效的本机 CDP 端口'));
    }
    const host = '127.0.0.1';
    const reqPath = (parsed.pathname || '/') + (parsed.search || '');
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const socket = net.connect(port, host);
    const timeoutMs = options.timeoutMs || 5000;
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let closed = false;

    const listeners = {
      message: [],
      close: [],
      error: []
    };

    const emit = (type, arg) => {
      for (const fn of listeners[type] || []) {
        try {
          fn(arg);
        } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (!handshakeDone) {
        socket.destroy();
        reject(new Error('CDP WebSocket handshake timeout'));
      }
    }, timeoutMs);

    function sendFrame(opcode, payloadBuf) {
      if (closed || socket.destroyed) return;
      const mask = crypto.randomBytes(4);
      const len = payloadBuf.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | len;
        mask.copy(header, 2);
      } else if (len < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        masked[i] = payloadBuf[i] ^ mask[i & 3];
      }
      socket.write(Buffer.concat([header, masked]));
    }

    let fragmentedOpcode = 0;
    let fragmentedChunks = [];

    function processFrames() {
      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const fin = (firstByte & 0x80) !== 0;
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLen = isMasked ? 4 : 0;
        if (buffer.length < offset + maskLen + payloadLen) return;

        let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (isMasked) {
          const mask = buffer.subarray(offset, offset + 4);
          const unmasked = Buffer.alloc(payloadLen);
          for (let i = 0; i < payloadLen; i++) {
            unmasked[i] = payload[i] ^ mask[i & 3];
          }
          payload = unmasked;
        }
        buffer = buffer.subarray(offset + maskLen + payloadLen);

        if (opcode === 0x8) {
          // Close frame
          closed = true;
          try {
            sendFrame(0x8, Buffer.alloc(0));
          } catch {}
          socket.end();
          emit('close');
          return;
        } else if (opcode === 0x9) {
          // Ping -> Pong
          sendFrame(0x0a, payload);
        } else if (opcode === 0x0a) {
          // Pong
        } else if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            emit('message', { data: payload.toString('utf8') });
          } else {
            fragmentedOpcode = opcode;
            fragmentedChunks = [payload];
          }
        } else if (opcode === 0x0 && fragmentedOpcode !== 0) {
          fragmentedChunks.push(payload);
          if (fin) {
            const full = Buffer.concat(fragmentedChunks);
            fragmentedOpcode = 0;
            fragmentedChunks = [];
            emit('message', { data: full.toString('utf8') });
          }
        }
      }
    }

    const wsClient = {
      send(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        sendFrame(0x1, buf);
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          sendFrame(0x8, Buffer.alloc(0));
        } catch {}
        socket.end();
        setTimeout(() => {
          if (!socket.destroyed) socket.destroy();
        }, 100).unref();
      },
      addEventListener(type, fn) {
        if (listeners[type]) listeners[type].push(fn);
      }
    };

    socket.on('connect', () => {
      // 严禁附带 Origin 请求头，防止未加 --remote-allow-origins=* 时被 Chromium 拒绝返回 403
      const reqLines = [
        `GET ${reqPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ];
      socket.write(reqLines.join('\r\n'));
    });

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString('utf8');
        buffer = buffer.subarray(headerEnd + 4);
        clearTimeout(timer);

        const firstLine = headerText.split('\r\n')[0] || '';
        if (!firstLine.includes('101')) {
          socket.destroy();
          return reject(new Error(`CDP WebSocket handshake failed: ${firstLine}`));
        }
        const acceptMatch = headerText.match(/Sec-WebSocket-Accept:\s*([^\r\n]+)/i);
        if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
          socket.destroy();
          return reject(new Error('CDP WebSocket invalid Sec-WebSocket-Accept'));
        }
        handshakeDone = true;
        resolve(wsClient);
        if (buffer.length > 0) processFrames();
      } else {
        processFrames();
      }
    });

    socket.on('error', err => {
      clearTimeout(timer);
      if (!handshakeDone) {
        reject(err);
      } else {
        emit('error', err);
      }
    });

    socket.on('close', () => {
      clearTimeout(timer);
      closed = true;
      if (!handshakeDone) {
        reject(new Error('CDP WebSocket closed before handshake completed'));
      } else {
        emit('close');
      }
    });
  });
}

/**
 * 创建带请求/响应关联的轻量 CDP 会话客户端
 */
async function createCdpClient(wsUrl, options = {}) {
  const ws = await connectCdpWebSocket(wsUrl, options);
  let seq = 0;
  const pending = new Map();

  ws.addEventListener('message', event => {
    try {
      const msg = JSON.parse(event.data);
      if (msg && msg.id && pending.has(msg.id)) {
        const item = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.error) {
          item.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          item.resolve(msg.result);
        }
      }
    } catch {}
  });

  ws.addEventListener('close', () => {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error('CDP connection closed'));
    }
    pending.clear();
  });

  return {
    ws,
    call(method, params = {}, callTimeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP call timeout: ${method}`));
          }
        }, callTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    evaluate(expression, opts = {}) {
      return this.call(
        'Runtime.evaluate',
        {
          expression,
          returnByValue: opts.returnByValue !== false,
          awaitPromise: opts.awaitPromise !== false
        },
        opts.timeoutMs || 8000
      );
    },
    async evaluateValue(expression, opts = {}) {
      const res = await this.evaluate(expression, opts);
      if (res && res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP eval exception';
        throw new Error(desc);
      }
      return res?.result?.value;
    },
    close() {
      ws.close();
    }
  };
}

/**
 * 优先级 ①：读取 Electron 主进程内存中的 authBootstrap / languageServer 活跃 LS 端口与 CSRF 凭证（v2.34.0+ 免 CDP）
 */
function readMainProcessLsAuth(options = {}) {
  if (options && options.allowMainProcessAuth === false) return null;
  let authMod = options?.authBootstrapModule || null;
  let lsMod = options?.languageServerModule || null;
  if (!authMod && !lsMod) {
    const inElectron = Boolean(typeof process !== 'undefined' && process.versions && process.versions.electron);
    if (inElectron || options?.forceTryRequireMainModules === true) {
      try { authMod = require('./authBootstrap'); } catch {}
      try { lsMod = require('./languageServer'); } catch {}
    }
  }
  if (!authMod && !lsMod) return null;

  const rawPort = (typeof authMod?.getActiveLsPort === 'function' ? authMod.getActiveLsPort() : null)
    ?? (typeof lsMod?.getLsPort === 'function' ? lsMod.getLsPort() : null);
  const port = parseExplicitPort(rawPort);
  const rawBaseUrl = (typeof authMod?.getActiveLsBaseUrl === 'function' ? authMod.getActiveLsBaseUrl() : null)
    || (typeof lsMod?.getLsBaseUrl === 'function' ? lsMod.getLsBaseUrl() : null)
    || (port ? `https://127.0.0.1:${port}` : null);
  const origin = normalizeLoopbackOrigin(rawBaseUrl);
  const rawCsrf = (typeof authMod?.getActiveLsCsrfToken === 'function' ? authMod.getActiveLsCsrfToken() : '')
    || (typeof lsMod?.getLsCsrfToken === 'function' ? lsMod.getLsCsrfToken() : '');
  const csrfToken = typeof rawCsrf === 'string' ? rawCsrf.trim() : '';

  if (!origin && !csrfToken) return null;
  let resolvedPort = port;
  if (!resolvedPort && origin) {
    try { resolvedPort = parseExplicitPort(new URL(origin).port); } catch {}
  }
  return {
    origin: origin || null,
    origins: origin ? [origin] : [],
    port: resolvedPort || null,
    csrfToken,
    source: 'main_process_auth_bootstrap'
  };
}

/**
 * 优先级 ②：扫描 ~/.gemini/antigravity/daemon/hub_*.json 中 PID 存活的语言服务实例（按 mtimeMs 降序）
 */
function discoverDaemonHubInstances(options = {}) {
  const daemonDir = resolveDaemonDir(options);
  if (!daemonDir) return [];
  const results = [];
  try {
    if (!fs.existsSync(daemonDir)) return results;
    const files = fs.readdirSync(daemonDir);
    for (const name of files) {
      if (!/^hub_.*\.json$/i.test(name)) continue;
      const filePath = path.join(daemonDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!raw || typeof raw !== 'object') continue;
        const pid = Number(raw.pid);
        if (Number.isInteger(pid) && pid > 0 && !isPidAlive(pid, options?.isPidAlive)) {
          continue;
        }
        const httpsPort = parseExplicitPort(raw.httpsPort);
        const httpPort = parseExplicitPort(raw.httpPort);
        const csrfToken = typeof raw.csrfToken === 'string' ? raw.csrfToken.trim() : '';
        const origins = [];
        if (httpsPort) origins.push(`https://127.0.0.1:${httpsPort}`);
        if (httpPort) origins.push(`http://127.0.0.1:${httpPort}`);
        if (!origins.length) continue;
        if (options?.requireCsrf !== false && !csrfToken) continue;
        results.push({
          pid: Number.isInteger(pid) && pid > 0 ? pid : null,
          httpsPort: httpsPort || null,
          httpPort: httpPort || null,
          origin: origins[0],
          origins,
          lsVersion: typeof raw.lsVersion === 'string' && raw.lsVersion.trim() ? raw.lsVersion.trim() : null,
          csrfToken,
          filePath,
          mtimeMs: Number(stat.mtimeMs || 0),
          source: 'daemon_hub'
        });
      } catch {}
    }
  } catch {}
  results.sort((a, b) => (b.mtimeMs - a.mtimeMs) || ((b.pid || 0) - (a.pid || 0)));
  return results;
}

async function extractAppConfigViaCdp(page) {
  if (!page || !page.webSocketDebuggerUrl) return null;
  let client;
  try {
    client = await createCdpClient(page.webSocketDebuggerUrl, { timeoutMs: 3000 });
    const res = await client.call(
      'Runtime.evaluate',
      {
        expression:
          '(() => { try { const cfg = window.__APP_CONFIG__ || null; let lsToken = ""; try { lsToken = window.localStorage ? (window.localStorage.getItem("agy_session_csrf_token") || "") : ""; } catch {} const cfgToken = (cfg && typeof cfg.csrfToken === "string") ? cfg.csrfToken.trim() : ""; const storedToken = typeof lsToken === "string" ? lsToken.trim() : ""; const csrfToken = cfgToken || storedToken || ""; if (!cfg && !csrfToken) return null; return { hasConfig: true, csrfToken, source: cfgToken ? "cdp_app_config" : (storedToken ? "cdp_local_storage" : "cdp_app_config") }; } catch (e) { return null; } })()',
        returnByValue: true
      },
      3000
    );
    return res?.result?.value || null;
  } catch {
    return null;
  } finally {
    if (client) client.close();
  }
}

/**
 * 免 CDP 统一 LS 端点与 CSRF 凭据解析器（供 local-api / meter-collector / meter-accounts / live-host 复用）
 * 优先级：
 * ① Electron 主进程 authBootstrap / languageServer 内存凭据
 * ② daemon/hub_*.json 存活 PID（匹配指定 origin 或按最新 mtime）
 * ③ 旧版 GET / HTML window.__APP_CONFIG__.csrfToken（仅在已知 origin 时尝试）
 * ④ CDP 运行时 window.__APP_CONFIG__.csrfToken || localStorage.getItem('agy_session_csrf_token')
 */
async function resolveLsAuth(rawOriginOrOpts = null, maybeOptions = {}) {
  let rawOrigin = rawOriginOrOpts;
  let options = maybeOptions || {};
  if (rawOriginOrOpts && typeof rawOriginOrOpts === 'object') {
    options = rawOriginOrOpts;
    rawOrigin = options.origin ?? null;
  }
  const hasExplicitOrigin = rawOrigin !== undefined && rawOrigin !== null && String(rawOrigin).trim() !== '';
  const targetOrigin = hasExplicitOrigin ? normalizeLoopbackOrigin(String(rawOrigin)) : null;
  if (hasExplicitOrigin && !targetOrigin) {
    throw new Error('非法的本机回环页面地址');
  }

  // ① Electron 主进程内存 authBootstrap / languageServer
  const mainAuth = readMainProcessLsAuth(options);
  if (mainAuth && mainAuth.csrfToken && mainAuth.origin) {
    if (!targetOrigin || mainAuth.origin === targetOrigin) {
      const resolvedOrigin = targetOrigin || mainAuth.origin;
      return {
        origin: resolvedOrigin,
        origins: [resolvedOrigin],
        csrfToken: mainAuth.csrfToken,
        hasConfig: true,
        source: mainAuth.source,
        port: mainAuth.port,
        lsVersion: null,
        pid: null
      };
    }
  }

  // ② daemon/hub_*.json 存活实例
  const hubs = discoverDaemonHubInstances({ ...options, requireCsrf: true });
  if (hubs.length > 0) {
    const matchedHub = targetOrigin
      ? hubs.find(h => h.origins.includes(targetOrigin))
      : hubs[0];
    if (matchedHub && matchedHub.csrfToken) {
      const resolvedOrigin = targetOrigin || matchedHub.origin;
      const allOrigins = Array.from(new Set(hubs.map(h => h.origin).filter(Boolean)));
      return {
        origin: resolvedOrigin,
        origins: targetOrigin ? [resolvedOrigin] : (allOrigins.length ? allOrigins : [resolvedOrigin]),
        csrfToken: matchedHub.csrfToken,
        hasConfig: true,
        source: matchedHub.source,
        pid: matchedHub.pid,
        lsVersion: matchedHub.lsVersion,
        httpsPort: matchedHub.httpsPort,
        httpPort: matchedHub.httpPort
      };
    }
  }

  // ③ 旧版 GET / HTML window.__APP_CONFIG__.csrfToken
  let hasConfig = false;
  let htmlError = null;
  const page = options.page || null;
  if (targetOrigin && options.allowHtmlFallback !== false) {
    const reqFn = typeof options.requestFn === 'function' ? options.requestFn : request;
    try {
      const html = await reqFn(targetOrigin + '/', null, null, options.timeoutMs);
      const config = typeof html === 'string'
        ? html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s)
        : null;
      if (config) {
        hasConfig = true;
        const parsed = JSON.parse(config[1]);
        const htmlToken = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
        if (htmlToken) {
          return {
            origin: targetOrigin,
            origins: [targetOrigin],
            csrfToken: htmlToken,
            hasConfig: true,
            source: 'html_app_config'
          };
        }
      }
    } catch (err) {
      htmlError = err;
    }
  }

  // ④ CDP 页面运行时 __APP_CONFIG__.csrfToken || localStorage['agy_session_csrf_token']
  if (page && page.webSocketDebuggerUrl && options.allowCdpFallback !== false) {
    const extractFn = typeof options.extractAppConfigViaCdp === 'function'
      ? options.extractAppConfigViaCdp
      : extractAppConfigViaCdp;
    const cdpCfg = await extractFn(page);
    if (cdpCfg && cdpCfg.hasConfig) {
      hasConfig = true;
      const cdpToken = typeof cdpCfg.csrfToken === 'string' ? cdpCfg.csrfToken.trim() : '';
      if (cdpToken) {
        return {
          origin: targetOrigin,
          origins: targetOrigin ? [targetOrigin] : [],
          csrfToken: cdpToken,
          hasConfig: true,
          source: cdpCfg.source || 'cdp_app_config'
        };
      }
    }
  }

  return {
    origin: targetOrigin,
    origins: targetOrigin ? [targetOrigin] : [],
    csrfToken: '',
    hasConfig,
    htmlError,
    source: null
  };
}

/**
 * 解析并缓存或实时提取指定本地页面原点的 CSRF Token 并构造 RPC 客户端。
 */
async function connectOrigin(rawOrigin, page = null, origins = null, extraMeta = {}) {
  const origin = normalizeLoopbackOrigin(rawOrigin);
  if (!origin) {
    throw new Error('非法的本机回环页面地址');
  }
  const authOptions = (extraMeta && typeof extraMeta.authOptions === 'object' && extraMeta.authOptions)
    ? extraMeta.authOptions
    : {};
  const resolved = await resolveLsAuth(origin, { ...authOptions, page });
  if (!resolved.csrfToken) {
    if (resolved.htmlError && (!page || !page.webSocketDebuggerUrl) && !resolved.hasConfig) {
      throw resolved.htmlError;
    }
    if (!resolved.hasConfig) {
      throw new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
    }
    throw new Error('Antigravity 本地鉴权信息尚未就绪，请稍后重试');
  }

  let activeToken = resolved.csrfToken;
  let activeAuthSource = resolved.source;

  return {
    origin,
    page,
    authSource: activeAuthSource,
    ...(extraMeta.port ? { port: extraMeta.port } : {}),
    ...(Array.isArray(extraMeta.pages) ? { pages: extraMeta.pages } : {}),
    ...(resolved.lsVersion ? { lsVersion: resolved.lsVersion } : {}),
    ...(resolved.pid ? { lsPid: resolved.pid } : {}),
    origins: Array.isArray(origins) && origins.length ? origins : [origin],
    call: async (method, body) => {
      const url = `${origin}/exa.language_server_pb.LanguageServerService/${method}`;
      const rpcReqFn = typeof authOptions.requestFn === 'function' ? authOptions.requestFn : request;
      try {
        const rawResp = await rpcReqFn(url, body, activeToken);
        return typeof rawResp === 'string' ? JSON.parse(rawResp) : rawResp;
      } catch (err) {
        if (err && /HTTP 40[13]\b/.test(String(err.message || ''))) {
          const refreshed = await resolveLsAuth(origin, { ...authOptions, page, forceRefresh: true });
          if (refreshed && refreshed.csrfToken && refreshed.csrfToken !== activeToken) {
            activeToken = refreshed.csrfToken;
            activeAuthSource = refreshed.source;
            const retryResp = await rpcReqFn(url, body, activeToken);
            return typeof retryResp === 'string' ? JSON.parse(retryResp) : retryResp;
          }
        }
        throw err;
      }
    }
  };
}

/**
 * 连接到本地 Antigravity LanguageServerService。
 * 支持直接传入已知 `options.origin` 免 CDP/DevToolsActivePort 直连，亦可通过 CDP 或 v2.34.0+ 免 CDP 凭据（authBootstrap / daemon hub_*.json）发现运行实例。
 */
async function connect(options = {}) {
  if (
    options &&
    options.origin !== undefined &&
    options.origin !== null &&
    String(options.origin).trim() !== ''
  ) {
    const explicitOrigin = normalizeLoopbackOrigin(options.origin);
    if (!explicitOrigin) {
      throw new Error('非法的本机回环页面地址');
    }
    return connectOrigin(explicitOrigin, null, [explicitOrigin], { authOptions: options });
  }
  try {
    const { port, page, pages } = await discoverAntigravityCdp(options);
    const origins = Array.from(
      new Set((Array.isArray(pages) ? pages : [page]).map(item => normalizeLoopbackOrigin(item?.url)).filter(Boolean))
    );
    const targetOrigin = normalizeLoopbackOrigin(page.url);
    return connectOrigin(targetOrigin, page, origins, { port, pages, authOptions: options });
  } catch (cdpErr) {
    if (options && options.strictPort === true) {
      throw cdpErr;
    }
    const fallbackAuth = await resolveLsAuth(null, {
      ...options,
      allowHtmlFallback: false,
      allowCdpFallback: false
    });
    if (fallbackAuth && fallbackAuth.origin && fallbackAuth.csrfToken) {
      return connectOrigin(fallbackAuth.origin, null, fallbackAuth.origins, { authOptions: options });
    }
    throw cdpErr;
  }
}

module.exports = {
  connect,
  connectOrigin,
  normalizeLoopbackOrigin,
  parseExplicitPort,
  getAppDataDir,
  getDevToolsActivePort,
  getCandidateCdpPorts,
  discoverAntigravityCdp,
  connectCdpWebSocket,
  createCdpClient,
  isIsolatedTestContext,
  resolveDaemonDir,
  readMainProcessLsAuth,
  discoverDaemonHubInstances,
  resolveLsAuth,
  HANS_CANDIDATE_PORTS
};
