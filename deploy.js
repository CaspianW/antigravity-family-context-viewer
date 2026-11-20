#!/usr/bin/env node
'use strict';

/**
 * Antigravity Family Context Viewer — 跨平台自动化部署与更新入口 (deploy.js)
 *
 * 适用对象：Windows / macOS / Linux 上的 AI 智能体与人工一键执行。
 * 特性：
 * - 零外部依赖，仅使用 Node.js 内置模块与本仓库既有模块
 * - 支持 --pull 自动安全拉取仓库更新（仅检查已追踪文件，放行未追踪的 family-join.json）
 * - 支持 deploy.js 自更新后自动以 --no-reexec 语义重入新版脚本
 * - 自动校验 Node.js >= 22.4.0、探测 app.asar、保留本机 family_sync_config.json 与账本
 * - 支持 --dry-run 预检与 --json 结构化输出，精确判断宿主是否需要重启
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { findAsarPath, getStateDir } = require('./asar-engine');
const { getRendererBuildId } = require('./install');
const { safeWriteJsonSync } = require('./meter-storage');

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 4;

const BACKEND_FILES = [
  'meter-main.js',
  'meter-core.js',
  'meter-collector.js',
  'meter-accounts.js',
  'meter-family-sync.js',
  'meter-storage.js',
  'meter-proxy.js',
  'meter-cli-launcher.js',
  'meter-context-unlock.js',
  'meter-enhance.js',
  'modular-installer.js',
  'modules-config.js',
  'asar-engine.js',
  'local-api.js',
  'live-host.js',
  'macos-binary-utils.js',
  'i18n/zh-CN.json',
  'i18n/i18n-runtime.js'
];

const BACKEND_FILE_SET = new Set(BACKEND_FILES);

const ASAR_LOOKUP_HINTS = {
  win32: [
    '%LOCALAPPDATA%\\Programs\\antigravity\\resources\\app.asar',
    'C:\\Program Files\\antigravity\\resources\\app.asar',
    'C:\\Program Files\\Google Antigravity\\resources\\app.asar'
  ],
  darwin: [
    '/Applications/Antigravity.app/Contents/Resources/app.asar',
    '~/Applications/Antigravity.app/Contents/Resources/app.asar',
    '/Applications/Google Antigravity.app/Contents/Resources/app.asar'
  ],
  linux: [
    '~/Antigravity/**/resources/app.asar',
    '/opt/antigravity/resources/app.asar',
    '/opt/Antigravity/resources/app.asar',
    '~/.local/share/antigravity/resources/app.asar'
  ]
};

function printDeployUsage(write = (s) => process.stdout.write(s)) {
  write(
`用法: node deploy.js [选项]

选项:
  --pull            安装前在干净的工作区执行 git pull --ff-only
  --build           强制从 src/renderer/ 重建 meter-renderer.js
  --path <file>     指定 Antigravity app.asar（或应用根目录）路径
  --backup <file>   指定纯净原版 app.asar 备份文件路径
  --port <port>     指定 Antigravity CDP 调试端口
  --force           强制执行 ASAR 覆盖校验与安装
  --dry-run         仅执行环境、Git 与家庭配置预检，不写入磁盘
  --skip-status     安装后跳过 node cli.js status 检查
  --json            以单个 JSON 对象输出结构化结果（供 Agent 解析）
  -h, --help        显示本帮助信息
`
  );
}

function parseDeployArgs(argv = []) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      pull: { type: 'boolean', default: false },
      build: { type: 'boolean', default: false },
      path: { type: 'string' },
      backup: { type: 'string' },
      port: { type: 'string' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'skip-status': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  });

  return {
    pull: Boolean(values.pull),
    build: Boolean(values.build),
    path: values.path || null,
    backup: values.backup || null,
    port: values.port || null,
    force: Boolean(values.force),
    dryRun: Boolean(values['dry-run']),
    skipStatus: Boolean(values['skip-status']),
    json: Boolean(values.json),
    help: Boolean(values.help)
  };
}

function checkNodeVersion(versionStr = process.versions.node) {
  const raw = String(versionStr || '').trim().replace(/^v/i, '');
  const parts = raw.split('.');
  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1] || '0', 10);
  const ok =
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR));
  return {
    ok,
    version: raw || String(versionStr || ''),
    minimum: `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`
  };
}

function computeBackendFingerprint(rootDir = __dirname) {
  const hash = crypto.createHash('sha256');
  for (const relPath of BACKEND_FILES) {
    const fullPath = path.join(rootDir, ...relPath.split('/'));
    if (!fs.existsSync(fullPath)) continue;
    hash.update(relPath + '\0');
    hash.update(fs.readFileSync(fullPath));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * 仅读取非敏感的家庭同步状态摘要；绝不暴露 serverUrl、familySecret、memberId、deviceId 或邮箱。
 */
function inspectFamilyConfig(stateDir) {
  const fallback = { configured: false, enabled: false, sharedAccountCount: 0 };
  if (!stateDir) return fallback;
  const configPath = path.join(stateDir, 'family_sync_config.json');
  try {
    if (!fs.existsSync(configPath)) return fallback;
    const raw = fs.readFileSync(configPath, 'utf8').trim();
    if (!raw) return fallback;
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return fallback;
    const rules = cfg.accountRules && typeof cfg.accountRules === 'object' ? Object.values(cfg.accountRules) : [];
    const sharedAccountCount = rules.filter((r) => r && r.mode === 'shared').length;
    return {
      configured: Boolean(cfg.serverUrl && cfg.familySecret && cfg.memberId),
      enabled: Boolean(cfg.enabled),
      sharedAccountCount
    };
  } catch {
    return fallback;
  }
}

function runGit(rootDir, gitArgs, runner = spawnSync, env = process.env) {
  return runner('git', ['-C', rootDir, ...gitArgs], {
    encoding: 'utf8',
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function readGitHeadShort(rootDir, runner = spawnSync, env = process.env) {
  if (!fs.existsSync(path.join(rootDir, '.git'))) return null;
  try {
    const res = runGit(rootDir, ['rev-parse', '--short', 'HEAD'], runner, env);
    if (res && res.status === 0 && !res.error) {
      return String(res.stdout || '').trim() || null;
    }
  } catch {}
  return null;
}

function checkGitWorkingTree(rootDir, runner = spawnSync, env = process.env) {
  if (!fs.existsSync(path.join(rootDir, '.git'))) {
    const err = new Error('当前目录不是 Git 仓库（缺少 .git），无法执行 --pull。请从 Git 克隆仓库，或去掉 --pull 直接部署本地目录。');
    err.code = 'NOT_A_GIT_REPO';
    throw err;
  }
  const statusRes = runGit(rootDir, ['status', '--porcelain', '-uno'], runner, env);
  if (statusRes.error || statusRes.status !== 0) {
    const detail = String(statusRes.stderr || statusRes.error?.message || 'git status failed').trim();
    const err = new Error(`检查 Git 工作区状态失败: ${detail}`);
    err.code = 'GIT_STATUS_FAILED';
    throw err;
  }
  const dirtyFiles = String(statusRes.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (dirtyFiles.length > 0) {
    const err = new Error(
      `检测到已追踪文件存在未提交改动，已中止 --pull（请勿自动丢弃本地改动，先由用户确认）:\n${dirtyFiles.join('\n')}`
    );
    err.code = 'GIT_DIRTY';
    err.dirtyFiles = dirtyFiles;
    throw err;
  }
  return { clean: true, dirtyFiles: [] };
}

function pullUpdates(rootDir, runner = spawnSync, env = process.env) {
  checkGitWorkingTree(rootDir, runner, env);

  const beforeShortRes = runGit(rootDir, ['rev-parse', '--short', 'HEAD'], runner, env);
  const beforeFullRes = runGit(rootDir, ['rev-parse', 'HEAD'], runner, env);
  const beforeCommit = beforeShortRes.status === 0 ? String(beforeShortRes.stdout || '').trim() : null;
  const beforeSha = beforeFullRes.status === 0 ? String(beforeFullRes.stdout || '').trim() : null;

  const pullRes = runGit(rootDir, ['pull', '--ff-only'], runner, env);
  if (pullRes.error || pullRes.status !== 0) {
    const detail = String(pullRes.stderr || pullRes.stdout || pullRes.error?.message || 'git pull failed').trim();
    const err = new Error(`git pull --ff-only 失败: ${detail}`);
    err.code = 'GIT_PULL_FAILED';
    throw err;
  }

  const afterShortRes = runGit(rootDir, ['rev-parse', '--short', 'HEAD'], runner, env);
  const afterFullRes = runGit(rootDir, ['rev-parse', 'HEAD'], runner, env);
  const afterCommit = afterShortRes.status === 0 ? String(afterShortRes.stdout || '').trim() : beforeCommit;
  const afterSha = afterFullRes.status === 0 ? String(afterFullRes.stdout || '').trim() : beforeSha;

  let changedFiles = [];
  if (beforeSha && afterSha && beforeSha !== afterSha) {
    const diffRes = runGit(rootDir, ['diff', '--name-only', beforeSha, afterSha], runner, env);
    if (diffRes && diffRes.status === 0) {
      changedFiles = String(diffRes.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\\/g, '/'))
        .filter(Boolean);
    }
  }

  const backendFilesChanged = changedFiles.some((file) => BACKEND_FILE_SET.has(file));
  return {
    pulled: true,
    updated: Boolean(beforeSha && afterSha && beforeSha !== afterSha),
    beforeCommit,
    afterCommit,
    changedFiles,
    backendFilesChanged
  };
}

function parseInstallMeta(stdout = '') {
  const lines = String(stdout || '').split(/\r?\n/);
  const prefix = '__AG_INSTALL_META__=';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(line.slice(prefix.length));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function stripInstallMetaLines(stdout = '') {
  return String(stdout || '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('__AG_INSTALL_META__='))
    .join('\n')
    .trimEnd();
}

function parseStatusJson(stdout = '') {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

function classifyInstallError(combinedOutput = '') {
  const text = String(combinedOutput || '');
  if (/EBUSY|EPERM|EACCES|resource busy|被运行中的\s*Antigravity\s*锁定/i.test(text)) {
    return 'ASAR_LOCKED';
  }
  if (/Could not auto-detect|Could not find app\.asar/i.test(text)) {
    return 'ASAR_NOT_FOUND';
  }
  return 'INSTALL_FAILED';
}

function evaluateRestartRequired({
  liveRunning = false,
  liveInjected = false,
  hasStaleMainProcess = false,
  backendSource = null,
  backendChanged = false
} = {}) {
  if (!liveRunning) {
    return { restartRequired: false, reason: 'client_not_running' };
  }
  if (!liveInjected) {
    return { restartRequired: true, reason: 'live_hot_inject_unavailable' };
  }
  if (hasStaleMainProcess) {
    return { restartRequired: true, reason: 'stale_main_process_version' };
  }
  if (backendChanged && backendSource !== 'live-host') {
    return { restartRequired: true, reason: 'backend_code_updated' };
  }
  return { restartRequired: false, reason: 'live_up_to_date' };
}

function readJsonQuietly(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readPackageVersion(rootDir) {
  const pkg = readJsonQuietly(path.join(rootDir, 'package.json'));
  return pkg && typeof pkg.version === 'string' ? pkg.version : null;
}

function formatAsarSearchHints(platform = process.platform) {
  const hints = ASAR_LOOKUP_HINTS[platform] || ASAR_LOOKUP_HINTS.linux;
  return hints.map((p) => `  - ${p}`).join('\n');
}

function formatErrorGuidance(errorCode, message, platform = process.platform) {
  if (errorCode === 'ASAR_LOCKED') {
    return (
      `${message}\n\n` +
      '处理指引：Antigravity 正在运行并锁定了 app.asar（Windows 上最常见）。\n' +
      '严禁在 Antigravity 会话内部强制关闭或杀死 Antigravity 进程。\n' +
      '请先请用户手动完全退出所有 Antigravity 窗口（含系统托盘图标中的“退出”），然后重新运行 node deploy.js。'
    );
  }
  if (errorCode === 'ASAR_NOT_FOUND') {
    return (
      `${message}\n\n` +
      `常见 app.asar 位置 (${platform})：\n${formatAsarSearchHints(platform)}\n` +
      '找到实际路径后请执行：node deploy.js --path "<app.asar 路径>"'
    );
  }
  return message;
}

function emitOutput(result, opts, outStream, errStream) {
  if (opts && opts.json) {
    outStream.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (!result.ok) {
    errStream.write(`❌ 部署失败 [${result.errorCode || 'DEPLOY_FAILED'}]: ${result.message}\n`);
    return;
  }

  const lines = [];
  if (result.dryRun) {
    lines.push('🔍 [Dry-Run 预检完成] 未修改任何磁盘文件或 Git 状态：');
  } else {
    lines.push('✅ [Antigravity 对话上下文查看器] 部署流程完成：');
  }
  lines.push(`  - 插件版本: v${result.version || 'unknown'}${result.commit ? ` (${result.commit})` : ''}`);
  if (result.pull && result.pull.pulled) {
    lines.push(
      `  - 代码拉取: ${result.pull.updated ? `${result.pull.beforeCommit || '?'} -> ${result.pull.afterCommit || '?'}` : '已是最新提交'} (涉及 ${result.pull.changedFiles.length} 个文件)`
    );
  }
  if (result.git && result.dryRun) {
    lines.push(`  - Git 状态: ${result.git.isRepo ? (result.git.clean ? '已追踪工作区干净' : `存在未提交改动 (${result.git.dirtyFiles.length} 项)`) : '非 Git 目录'}`);
  }
  lines.push(`  - 目标 ASAR: ${result.asarPath}`);
  if (!result.dryRun) {
    lines.push(`  - 写入状态: ${result.asarPatched ? '已写入并校验通过' : '未确认 (请检查 status 输出)'}`);
    const hotStatus = result.installMeta?.liveInjected
      ? (result.installMeta.backendHotReloaded ? '渲染层与后台均已热生效' : '渲染层已热加载')
      : '未热注入（将在下次启动 Antigravity 时生效）';
    lines.push(`  - 热加载状态: ${hotStatus}`);
    lines.push(
      `  - 宿主重启要求: ${result.restartRequired ? `需要用户完全退出并重启 Antigravity (${result.restartReason})` : `无需重启 (${result.restartReason})`}`
    );
  } else {
    lines.push(`  - 预计后台变更: ${result.backendChanged ? '是（涉及主进程/核心模块，运行中客户端建议重启）' : '否'}`);
  }
  const fam = result.familySync || { configured: false, enabled: false, sharedAccountCount: 0 };
  lines.push(
    `  - 家庭组同步: ${fam.configured ? (fam.enabled ? `已配置并开启 (${fam.sharedAccountCount} 个共享账号)` : `已配置但未开启 (${fam.sharedAccountCount} 个共享账号)`) : '未配置（保留本地仅统计或后续使用 setup-family.js 接入）'}`
  );
  outStream.write(lines.join('\n') + '\n');
}

function buildForwardedFlags(opts, { includeInstallOnly = false } = {}) {
  const args = [];
  if (opts.path) args.push('--path', opts.path);
  if (opts.port) args.push('--port', opts.port);
  if (includeInstallOnly) {
    if (opts.backup) args.push('--backup', opts.backup);
    if (opts.force) args.push('--force');
  }
  return args;
}

function failDeploy(opts, { errorCode, message, exitCode = 1, extra = {} }, outStream, errStream, platform) {
  const guidance = formatErrorGuidance(errorCode, message, platform);
  const result = {
    ok: false,
    exitCode,
    errorCode,
    message: guidance,
    ...extra
  };
  emitOutput(result, opts, outStream, errStream);
  return result;
}

function loadPullFromEnv(env) {
  if (env.AG_DEPLOY_REEXEC !== '1' || env.AG_DEPLOY_PULLED !== '1') return null;
  let changedFiles = [];
  try {
    const parsed = JSON.parse(env.AG_DEPLOY_CHANGED_FILES || '[]');
    if (Array.isArray(parsed)) changedFiles = parsed;
  } catch {}
  const beforeCommit = env.AG_DEPLOY_BEFORE_COMMIT || null;
  const afterCommit = env.AG_DEPLOY_AFTER_COMMIT || null;
  return {
    pulled: true,
    updated: Boolean(beforeCommit && afterCommit && beforeCommit !== afterCommit),
    beforeCommit,
    afterCommit,
    changedFiles,
    backendFilesChanged: changedFiles.some((f) => BACKEND_FILE_SET.has(f))
  };
}

function maybeBuildRenderer(opts, rootDir, deps, outStream) {
  const rendererBundlePath = path.join(rootDir, 'meter-renderer.js');
  const rendererSrcDir = path.join(rootDir, 'src', 'renderer');
  const shouldBuild = Boolean(opts.build || (!fs.existsSync(rendererBundlePath) && fs.existsSync(rendererSrcDir)));
  if (!shouldBuild) return false;

  const buildFn = deps.buildRenderer || require('./scripts/build-renderer').buildRenderer;
  if (opts.json) {
    // 静默捕获构建日志，保证 --json stdout 严格为单个合法 JSON
    const origLog = console.log;
    console.log = () => {};
    try {
      buildFn({ rootDir });
    } finally {
      console.log = origLog;
    }
  } else {
    outStream.write('🛠️ 正在构建渲染层 bundle (meter-renderer.js)...\n');
    buildFn({ rootDir });
  }
  return true;
}

function resolvePullStep(opts, rootDir, argv, deps, outStream, errStream) {
  const env = deps.env || process.env;
  const runSpawn = deps.spawnSync || spawnSync;
  const execPath = deps.execPath || process.execPath;
  const platform = deps.platform || process.platform;

  const reexecPull = loadPullFromEnv(env);
  if (reexecPull) return { pullInfo: reexecPull };
  if (opts.dryRun || !opts.pull) return { pullInfo: null };

  let pullInfo;
  try {
    pullInfo = pullUpdates(rootDir, runSpawn, env);
  } catch (err) {
    return {
      failure: failDeploy(
        opts,
        { errorCode: err.code || 'GIT_PULL_FAILED', message: err.message, extra: { dirtyFiles: err.dirtyFiles || undefined } },
        outStream,
        errStream,
        platform
      )
    };
  }

  if (pullInfo.changedFiles.includes('deploy.js') && env.AG_DEPLOY_REEXEC !== '1') {
    const childArgv = argv.filter((arg) => arg !== '--pull');
    const reexecRes = runSpawn(execPath, [path.join(rootDir, 'deploy.js'), ...childArgv], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...env,
        AG_DEPLOY_REEXEC: '1',
        AG_DEPLOY_PULLED: '1',
        AG_DEPLOY_BEFORE_COMMIT: pullInfo.beforeCommit || '',
        AG_DEPLOY_AFTER_COMMIT: pullInfo.afterCommit || '',
        AG_DEPLOY_CHANGED_FILES: JSON.stringify(pullInfo.changedFiles)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (reexecRes.stdout) outStream.write(reexecRes.stdout);
    if (reexecRes.stderr) errStream.write(reexecRes.stderr);
    const parsed = opts.json ? parseStatusJson(reexecRes.stdout) : null;
    const exitCode = typeof reexecRes.status === 'number' ? reexecRes.status : 1;
    return {
      reexecResult: parsed
        ? { ...parsed, reexeced: true, exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : exitCode }
        : { ok: exitCode === 0, reexeced: true, exitCode }
    };
  }

  return { pullInfo };
}

function readDryRunGitInfo(rootDir, runSpawn, env) {
  const isRepo = fs.existsSync(path.join(rootDir, '.git'));
  if (!isRepo) return { isRepo: false, clean: null, dirtyFiles: [] };
  try {
    checkGitWorkingTree(rootDir, runSpawn, env);
    return { isRepo: true, clean: true, dirtyFiles: [] };
  } catch (err) {
    return { isRepo: true, clean: false, dirtyFiles: err.dirtyFiles || [], gitError: err.code || err.message };
  }
}

function runDeploy(argv = process.argv.slice(2), deps = {}) {
  const rootDir = deps.rootDir ? path.resolve(deps.rootDir) : __dirname;
  const stateDir = deps.stateDir ? path.resolve(deps.stateDir) : getStateDir();
  const execPath = deps.execPath || process.execPath;
  const env = deps.env || process.env;
  const runSpawn = deps.spawnSync || spawnSync;
  const findAsarFn = deps.findAsarPath || findAsarPath;
  const getRendererBuildIdFn = deps.getRendererBuildId || getRendererBuildId;
  const outStream = deps.stdout || process.stdout;
  const errStream = deps.stderr || process.stderr;
  const platform = deps.platform || process.platform;

  let opts;
  try {
    opts = parseDeployArgs(argv);
  } catch (err) {
    const rawJson = argv.includes('--json');
    return failDeploy({ json: rawJson }, { errorCode: 'INVALID_ARGS', message: err.message }, outStream, errStream, platform);
  }

  if (opts.help) {
    if (opts.json) {
      outStream.write(JSON.stringify({ ok: true, help: true, exitCode: 0 }) + '\n');
    } else {
      printDeployUsage((s) => outStream.write(s));
    }
    return { ok: true, help: true, exitCode: 0 };
  }

  const nodeCheck = checkNodeVersion(deps.nodeVersion || process.versions.node);
  if (!nodeCheck.ok) {
    return failDeploy(
      opts,
      {
        errorCode: 'NODE_VERSION_UNSUPPORTED',
        message: `需要 Node.js >= ${nodeCheck.minimum}，当前版本为 v${nodeCheck.version}。`,
        extra: { node: nodeCheck }
      },
      outStream,
      errStream,
      platform
    );
  }

  const deployStatePath = path.join(stateDir, 'deploy-state.json');
  const prevDeployState = readJsonQuietly(deployStatePath);
  const prevInstallManifest = readJsonQuietly(path.join(stateDir, 'installation.json'));

  const pullStep = resolvePullStep(opts, rootDir, argv, deps, outStream, errStream);
  if (pullStep.failure) return pullStep.failure;
  if (pullStep.reexecResult) return pullStep.reexecResult;
  const pullInfo = pullStep.pullInfo;

  let asarPath;
  try {
    asarPath = findAsarFn(opts.path);
  } catch (err) {
    return failDeploy(opts, { errorCode: 'ASAR_NOT_FOUND', message: err.message }, outStream, errStream, platform);
  }

  const pkgVersion = readPackageVersion(rootDir);
  let rendererBuildId = getRendererBuildIdFn(path.join(rootDir, 'meter-renderer.js'));
  const backendFingerprint = computeBackendFingerprint(rootDir);
  const currentCommit = (pullInfo && pullInfo.afterCommit) || readGitHeadShort(rootDir, runSpawn, env);
  const backendChanged = Boolean(
    (pullInfo && pullInfo.backendFilesChanged) ||
    !prevInstallManifest ||
    (prevDeployState && prevDeployState.lastBackendFingerprint !== backendFingerprint) ||
    (!prevDeployState && prevInstallManifest)
  );
  const familySync = inspectFamilyConfig(stateDir);

  if (opts.dryRun) {
    const result = {
      ok: true,
      dryRun: true,
      exitCode: 0,
      node: nodeCheck,
      version: pkgVersion,
      commit: currentCommit,
      asarPath,
      backendFingerprint,
      rendererBuildId,
      backendChanged,
      familySync,
      git: readDryRunGitInfo(rootDir, runSpawn, env),
      previousDeploy: prevDeployState ? { lastVersion: prevDeployState.lastVersion || null, lastCommit: prevDeployState.lastCommit || null } : null
    };
    emitOutput(result, opts, outStream, errStream);
    return result;
  }

  let builtRenderer = false;
  try {
    builtRenderer = maybeBuildRenderer(opts, rootDir, deps, outStream);
    if (builtRenderer) rendererBuildId = getRendererBuildIdFn(path.join(rootDir, 'meter-renderer.js'));
  } catch (buildErr) {
    return failDeploy(
      opts,
      { errorCode: buildErr.code || 'BUILD_RENDERER_FAILED', message: buildErr.message },
      outStream,
      errStream,
      platform
    );
  }

  const installArgs = [
    path.join(rootDir, 'cli.js'),
    'install',
    '--enable-meter',
    ...buildForwardedFlags(opts, { includeInstallOnly: true })
  ];
  const installRes = runSpawn(execPath, installArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...env, AG_EMIT_INSTALL_META: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (!opts.json) {
    const cleanOut = stripInstallMetaLines(installRes.stdout);
    if (cleanOut) outStream.write(cleanOut + '\n');
    if (installRes.stderr) errStream.write(installRes.stderr);
  }

  if (installRes.error || installRes.status !== 0) {
    const combinedErr = [installRes.stderr, installRes.stdout, installRes.error?.message].filter(Boolean).join('\n');
    return failDeploy(
      opts,
      {
        errorCode: classifyInstallError(combinedErr),
        message: combinedErr.trim() || `cli.js install exited with code ${installRes.status}`,
        exitCode: typeof installRes.status === 'number' && installRes.status !== 0 ? installRes.status : 1,
        extra: { asarPath, version: pkgVersion, commit: currentCommit }
      },
      outStream,
      errStream,
      platform
    );
  }

  const installMeta = parseInstallMeta(installRes.stdout);

  let statusReport = null;
  if (!opts.skipStatus) {
    const statusArgs = [path.join(rootDir, 'cli.js'), 'status', ...buildForwardedFlags(opts)];
    const statusRes = runSpawn(execPath, statusArgs, { cwd: rootDir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (statusRes && statusRes.status === 0) statusReport = parseStatusJson(statusRes.stdout);
  }

  safeWriteJsonSync(deployStatePath, {
    lastCommit: currentCommit,
    lastVersion: pkgVersion,
    lastBackendFingerprint: backendFingerprint,
    lastRendererBuildId: rendererBuildId,
    lastAsarPath: asarPath,
    lastDeployedAt: new Date().toISOString()
  });

  const liveRunning = statusReport?.liveWindow ? Boolean(statusReport.liveWindow.running) : Boolean(installMeta?.liveInjected);
  const liveInjected = installMeta ? Boolean(installMeta.liveInjected) : Boolean(statusReport?.liveWindow?.active);
  const backendSource = installMeta?.backendSource || statusReport?.versions?.effectiveBackendSource || null;
  const restart = evaluateRestartRequired({
    liveRunning,
    liveInjected,
    hasStaleMainProcess: Boolean(installMeta?.hasStaleMainProcess),
    backendSource,
    backendChanged
  });

  const asarPatched = statusReport ? Boolean(statusReport.asarPatched) : true;
  const result = {
    ok: true,
    exitCode: 0,
    version: pkgVersion,
    commit: currentCommit,
    asarPath,
    asarPatched,
    pulled: Boolean(pullInfo && pullInfo.pulled),
    pull: pullInfo,
    builtRenderer,
    backendFingerprint,
    rendererBuildId,
    backendChanged,
    installMeta,
    status: statusReport,
    restartRequired: restart.restartRequired,
    restartReason: restart.reason,
    familySync,
    deployStatePath
  };

  emitOutput(result, opts, outStream, errStream);
  return result;
}

if (require.main === module) {
  const result = runDeploy(process.argv.slice(2));
  if (result && typeof result.exitCode === 'number' && result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

module.exports = {
  BACKEND_FILES,
  parseDeployArgs,
  checkNodeVersion,
  computeBackendFingerprint,
  inspectFamilyConfig,
  checkGitWorkingTree,
  pullUpdates,
  parseInstallMeta,
  parseStatusJson,
  classifyInstallError,
  evaluateRestartRequired,
  runDeploy
};
