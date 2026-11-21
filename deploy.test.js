'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
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
} = require('./deploy');

function makeTempDir(prefix = 'ag-deploy-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMemoryStream() {
  let buf = '';
  return {
    write(chunk) {
      buf += String(chunk);
      return true;
    },
    read() {
      return buf;
    }
  };
}

function runGitChecked(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res;
}

test('parseDeployArgs parses all flags and rejects invalid options', () => {
  const parsed = parseDeployArgs([
    '--pull',
    '--build',
    '--path', '/custom/app.asar',
    '--backup', '/custom/base.asar',
    '--port', '9222',
    '--force',
    '--dry-run',
    '--skip-status',
    '--json'
  ]);
  assert.deepEqual(parsed, {
    pull: true,
    build: true,
    path: '/custom/app.asar',
    backup: '/custom/base.asar',
    port: '9222',
    force: true,
    dryRun: true,
    skipStatus: true,
    json: true,
    help: false
  });

  const helpShort = parseDeployArgs(['-h']);
  assert.equal(helpShort.help, true);

  assert.throws(() => parseDeployArgs(['--unknown-flag']));
  assert.throws(() => parseDeployArgs(['--path']));
  assert.throws(() => parseDeployArgs(['positional-arg']));
});

test('checkNodeVersion enforces >= 22.4.0', () => {
  assert.equal(checkNodeVersion('20.18.0').ok, false);
  assert.equal(checkNodeVersion('22.3.9').ok, false);
  assert.equal(checkNodeVersion('22.4.0').ok, true);
  assert.equal(checkNodeVersion('v22.4.1').ok, true);
  assert.equal(checkNodeVersion('24.0.0').ok, true);
});

test('computeBackendFingerprint is deterministic, reacts to backend edits, and ignores non-backend files', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'meter-core.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# hello\n');
    fs.mkdirSync(path.join(dir, 'i18n'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'i18n', 'zh-CN.json'), '{"k":"v"}\n');

    const fp1 = computeBackendFingerprint(dir);
    const fp2 = computeBackendFingerprint(dir);
    assert.equal(fp1, fp2);
    assert.match(fp1, /^[0-9a-f]{16}$/);

    // Modifying non-backend files must not change backend fingerprint
    fs.writeFileSync(path.join(dir, 'README.md'), '# changed doc\n');
    fs.writeFileSync(path.join(dir, 'deploy.js'), '// unrelated\n');
    assert.equal(computeBackendFingerprint(dir), fp1);

    // Modifying any BACKEND_FILES member must change fingerprint
    fs.writeFileSync(path.join(dir, 'meter-core.js'), 'const a = 2;\n');
    const fp3 = computeBackendFingerprint(dir);
    assert.notEqual(fp3, fp1);
    assert.ok(BACKEND_FILES.includes('meter-core.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectFamilyConfig handles missing/configured files and never exposes secrets or emails', () => {
  const stateDir = makeTempDir();
  try {
    assert.deepEqual(inspectFamilyConfig(stateDir), {
      configured: false,
      enabled: false,
      sharedAccountCount: 0
    });

    const cfgPath = path.join(stateDir, 'family_sync_config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      enabled: true,
      serverUrl: 'https://secret-family.example.pages.dev',
      familySecret: 'super-secret-family-key-24-chars',
      memberId: '11111111-2222-3333-4444-555555555555',
      deviceId: 'device-1234',
      accountRules: {
        acct_1111111111111111: { mode: 'shared', alias: 'Main' },
        acct_2222222222222222: { mode: 'personal_local_only', alias: 'Private' },
        acct_3333333333333333: { mode: 'shared', alias: 'Backup' }
      },
      extraEmail: 'private-user@example.com'
    }));

    const summary = inspectFamilyConfig(stateDir);
    assert.deepEqual(summary, {
      configured: true,
      enabled: true,
      sharedAccountCount: 2
    });
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes('pages.dev'), false);
    assert.equal(serialized.includes('super-secret'), false);
    assert.equal(serialized.includes('11111111-2222'), false);
    assert.equal(serialized.includes('device-1234'), false);
    assert.equal(serialized.includes('private-user@example.com'), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('evaluateRestartRequired covers all 5 decision branches', () => {
  assert.deepEqual(
    evaluateRestartRequired({ liveRunning: false, liveInjected: false, backendChanged: true }),
    { restartRequired: false, reason: 'client_not_running' }
  );
  assert.deepEqual(
    evaluateRestartRequired({ liveRunning: true, liveInjected: false, backendChanged: false }),
    { restartRequired: true, reason: 'live_hot_inject_unavailable' }
  );
  assert.deepEqual(
    evaluateRestartRequired({ liveRunning: true, liveInjected: true, hasStaleMainProcess: true, backendChanged: false }),
    { restartRequired: true, reason: 'stale_main_process_version' }
  );
  assert.deepEqual(
    evaluateRestartRequired({
      liveRunning: true,
      liveInjected: true,
      hasStaleMainProcess: false,
      backendSource: 'electron-ipc',
      backendChanged: true
    }),
    { restartRequired: true, reason: 'backend_code_updated' }
  );
  assert.deepEqual(
    evaluateRestartRequired({
      liveRunning: true,
      liveInjected: true,
      hasStaleMainProcess: false,
      backendSource: 'live-host',
      backendChanged: true
    }),
    { restartRequired: false, reason: 'live_up_to_date' }
  );
  assert.deepEqual(
    evaluateRestartRequired({
      liveRunning: true,
      liveInjected: true,
      hasStaleMainProcess: false,
      backendSource: 'electron-ipc',
      backendChanged: false
    }),
    { restartRequired: false, reason: 'live_up_to_date' }
  );
});

test('parseInstallMeta, parseStatusJson, and classifyInstallError parse CLI outputs reliably', () => {
  const stdout = [
    'some progress log',
    '__AG_INSTALL_META__={"meterVersion":"0.8.8","liveInjected":true,"backendSource":"electron-ipc","hasStaleMainProcess":false}'
  ].join('\n');
  assert.deepEqual(parseInstallMeta(stdout), {
    meterVersion: '0.8.8',
    liveInjected: true,
    backendSource: 'electron-ipc',
    hasStaleMainProcess: false
  });
  assert.equal(parseInstallMeta('no meta line'), null);

  assert.deepEqual(parseStatusJson('{"asarPatched":true,"liveWindow":{"running":true}}'), {
    asarPatched: true,
    liveWindow: { running: true }
  });

  assert.equal(classifyInstallError('Error: EBUSY: resource busy or locked, copyfile'), 'ASAR_LOCKED');
  assert.equal(classifyInstallError('文件正被运行中的 Antigravity 锁定'), 'ASAR_LOCKED');
  assert.equal(classifyInstallError('Could not auto-detect Antigravity installation (app.asar).'), 'ASAR_NOT_FOUND');
  assert.equal(classifyInstallError('Checksum mismatch'), 'INSTALL_FAILED');
});

test('git working tree checks & pullUpdates work with temp bare remote and ignore untracked family-join.json', () => {
  const sandbox = makeTempDir('ag-deploy-git-');
  const bareDir = path.join(sandbox, 'remote.git');
  const seedDir = path.join(sandbox, 'seed');
  const cloneDir = path.join(sandbox, 'clone');

  try {
    fs.mkdirSync(bareDir, { recursive: true });
    runGitChecked(['init', '--bare', '-b', 'main'], bareDir);

    fs.mkdirSync(seedDir, { recursive: true });
    runGitChecked(['init', '-b', 'main'], seedDir);
    runGitChecked(['config', 'user.name', 'Test User'], seedDir);
    runGitChecked(['config', 'user.email', 'test@example.com'], seedDir);
    fs.writeFileSync(path.join(seedDir, 'meter-core.js'), 'const v = 1;\n');
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'init\n');
    runGitChecked(['add', '.'], seedDir);
    runGitChecked(['commit', '-m', 'init'], seedDir);
    runGitChecked(['remote', 'add', 'origin', bareDir], seedDir);
    runGitChecked(['push', '-u', 'origin', 'main'], seedDir);

    runGitChecked(['clone', bareDir, cloneDir], sandbox);

    // 1. Untracked file (e.g. family-join.json) must NOT block checkGitWorkingTree
    fs.writeFileSync(path.join(cloneDir, 'family-join.json'), '{"serverUrl":"https://x.pages.dev"}\n');
    assert.deepEqual(checkGitWorkingTree(cloneDir), { clean: true, dirtyFiles: [] });

    // 2. Modified tracked file must abort with GIT_DIRTY
    fs.writeFileSync(path.join(cloneDir, 'README.md'), 'dirty edit\n');
    assert.throws(
      () => checkGitWorkingTree(cloneDir),
      (err) => err.code === 'GIT_DIRTY' && Array.isArray(err.dirtyFiles) && err.dirtyFiles.some((l) => l.includes('README.md'))
    );
    // Restore tracked file cleanly
    runGitChecked(['checkout', '--', 'README.md'], cloneDir);

    // 3. Push a new backend commit to bare remote and pullUpdates from cloneDir
    fs.writeFileSync(path.join(seedDir, 'meter-core.js'), 'const v = 2;\n');
    runGitChecked(['commit', '-am', 'update backend'], seedDir);
    runGitChecked(['push', 'origin', 'main'], seedDir);

    const pullRes = pullUpdates(cloneDir);
    assert.equal(pullRes.pulled, true);
    assert.equal(pullRes.updated, true);
    assert.notEqual(pullRes.beforeCommit, pullRes.afterCommit);
    assert.deepEqual(pullRes.changedFiles, ['meter-core.js']);
    assert.equal(pullRes.backendFilesChanged, true);
    // Ensure untracked family-join.json is still intact
    assert.equal(fs.existsSync(path.join(cloneDir, 'family-join.json')), true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('runDeploy --dry-run --json reports preflight without modifying disk or calling install', () => {
  const rootDir = makeTempDir('ag-deploy-root-');
  const stateDir = makeTempDir('ag-deploy-state-');
  const fakeAsar = path.join(rootDir, 'app.asar');
  try {
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.8.8' }));
    fs.writeFileSync(path.join(rootDir, 'meter-renderer.js'), '// renderer\n');
    fs.writeFileSync(path.join(rootDir, 'meter-core.js'), '// core\n');
    fs.writeFileSync(fakeAsar, 'fake-asar');
    fs.writeFileSync(path.join(stateDir, 'family_sync_config.json'), JSON.stringify({
      enabled: true,
      serverUrl: 'https://private-test.pages.dev',
      familySecret: 'secret-token-value-at-least-24-bytes',
      memberId: '11111111-2222-3333-4444-555555555555',
      accountRules: { acct_0123456789abcdef: { mode: 'shared' } }
    }));

    let spawnCalled = false;
    const out = makeMemoryStream();
    const err = makeMemoryStream();
    const res = runDeploy(['--dry-run', '--json'], {
      rootDir,
      stateDir,
      findAsarPath: () => fakeAsar,
      spawnSync: () => {
        spawnCalled = true;
        throw new Error('spawnSync should not be called');
      },
      stdout: out,
      stderr: err
    });

    assert.equal(spawnCalled, false);
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.asarPath, fakeAsar);
    assert.equal(res.familySync.configured, true);
    assert.equal(res.familySync.sharedAccountCount, 1);

    const jsonOut = JSON.parse(out.read());
    assert.equal(jsonOut.ok, true);
    assert.equal(jsonOut.dryRun, true);
    assert.equal(out.read().includes('pages.dev'), false);
    assert.equal(out.read().includes('secret-token'), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'deploy-state.json')), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runDeploy forwards --enable-meter/--path/--port, writes deploy-state.json, and tracks restartRequired accurately', () => {
  const rootDir = makeTempDir('ag-deploy-root-');
  const stateDir = makeTempDir('ag-deploy-state-');
  const fakeAsar = path.join(rootDir, 'custom-app.asar');
  try {
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.8.8' }));
    fs.writeFileSync(path.join(rootDir, 'meter-renderer.js'), '// renderer\n');
    fs.writeFileSync(path.join(rootDir, 'meter-core.js'), '// core\n');
    fs.writeFileSync(fakeAsar, 'fake-asar');

    const calls = [];
    const mockSpawn = (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes('install')) {
        return {
          status: 0,
          stdout: [
            'installed ok',
            '__AG_INSTALL_META__={"meterVersion":"0.8.8","liveInjected":true,"backendHotReloaded":false,"backendSource":"electron-ipc","hasStaleMainProcess":false}'
          ].join('\n'),
          stderr: ''
        };
      }
      if (args.includes('status')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            pluginVersion: '0.8.8',
            asarPatched: true,
            versions: { effectiveBackendSource: 'electron-ipc' },
            liveWindow: { running: true, active: true }
          }),
          stderr: ''
        };
      }
      throw new Error('Unexpected spawn args: ' + args.join(' '));
    };

    const out1 = makeMemoryStream();
    const res1 = runDeploy(['--path', fakeAsar, '--port', '9222', '--json'], {
      rootDir,
      stateDir,
      findAsarPath: (p) => p,
      spawnSync: mockSpawn,
      stdout: out1,
      stderr: makeMemoryStream()
    });

    assert.equal(res1.ok, true);
    assert.equal(res1.asarPatched, true);
    assert.equal(res1.backendChanged, true);
    assert.equal(res1.restartRequired, true);
    assert.equal(res1.restartReason, 'backend_code_updated');

    const installCall = calls.find((c) => c.args.includes('install'));
    assert.ok(installCall.args.includes('--enable-meter'));
    assert.ok(installCall.args.includes('--path'));
    assert.ok(installCall.args.includes(fakeAsar));
    assert.ok(installCall.args.includes('--port'));
    assert.ok(installCall.args.includes('9222'));

    assert.equal(fs.existsSync(path.join(stateDir, 'deploy-state.json')), true);

    // Second deploy with identical backend files (and installation.json present) should report backendChanged=false
    fs.writeFileSync(path.join(stateDir, 'installation.json'), JSON.stringify({ meterVersion: '0.8.8' }));
    const res2 = runDeploy(['--path', fakeAsar, '--json'], {
      rootDir,
      stateDir,
      findAsarPath: (p) => p,
      spawnSync: mockSpawn,
      stdout: makeMemoryStream(),
      stderr: makeMemoryStream()
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.backendChanged, false);
    assert.equal(res2.restartRequired, false);
    assert.equal(res2.restartReason, 'live_up_to_date');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runDeploy classifies EBUSY/ASAR lock failures cleanly without altering state', () => {
  const rootDir = makeTempDir('ag-deploy-root-');
  const stateDir = makeTempDir('ag-deploy-state-');
  const fakeAsar = path.join(rootDir, 'app.asar');
  try {
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.8.8' }));
    fs.writeFileSync(path.join(rootDir, 'meter-renderer.js'), '// renderer\n');
    fs.writeFileSync(fakeAsar, 'fake-asar');

    const out = makeMemoryStream();
    const err = makeMemoryStream();
    const res = runDeploy(['--json'], {
      rootDir,
      stateDir,
      findAsarPath: () => fakeAsar,
      spawnSync: () => ({
        status: 1,
        stdout: '',
        stderr: '❌ 执行失败: 无法写入目标文件 (app.asar)：文件正被运行中的 Antigravity 锁定。'
      }),
      stdout: out,
      stderr: err
    });

    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'ASAR_LOCKED');
    assert.equal(res.exitCode, 1);
    const parsed = JSON.parse(out.read());
    assert.equal(parsed.errorCode, 'ASAR_LOCKED');
    assert.equal(fs.existsSync(path.join(stateDir, 'deploy-state.json')), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runDeploy rejects unsupported Node versions cleanly', () => {
  const out = makeMemoryStream();
  const err = makeMemoryStream();
  const res = runDeploy(['--json'], {
    nodeVersion: '20.18.0',
    stdout: out,
    stderr: err
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'NODE_VERSION_UNSUPPORTED');
  assert.equal(res.exitCode, 1);
  assert.equal(JSON.parse(out.read()).errorCode, 'NODE_VERSION_UNSUPPORTED');
});

test('runDeploy re-execs without --pull when git pull updates deploy.js', () => {
  const rootDir = makeTempDir('ag-deploy-reexec-');
  const stateDir = makeTempDir('ag-deploy-state-');
  try {
    fs.mkdirSync(path.join(rootDir, '.git'));
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.8.8' }));
    fs.writeFileSync(path.join(rootDir, 'deploy.js'), '// updated\n');

    let revCount = 0;
    const childCalls = [];
    const mockSpawn = (cmd, args, opts) => {
      if (cmd === 'git') {
        if (args.includes('status')) return { status: 0, stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short')) {
          revCount++;
          return { status: 0, stdout: revCount <= 1 ? 'aaa1111\n' : 'bbb2222\n', stderr: '' };
        }
        if (args.includes('rev-parse')) {
          return { status: 0, stdout: revCount <= 1 ? 'aaaa1111aaaa1111\n' : 'bbbb2222bbbb2222\n', stderr: '' };
        }
        if (args.includes('pull')) return { status: 0, stdout: 'Updating\n', stderr: '' };
        if (args.includes('diff')) return { status: 0, stdout: 'deploy.js\nmeter-core.js\n', stderr: '' };
      }
      childCalls.push({ cmd, args, env: opts.env });
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, exitCode: 0, pulled: true, restartRequired: true }),
        stderr: ''
      };
    };

    const out = makeMemoryStream();
    const res = runDeploy(['--pull', '--json'], {
      rootDir,
      stateDir,
      execPath: 'node',
      env: {},
      spawnSync: mockSpawn,
      stdout: out,
      stderr: makeMemoryStream()
    });

    assert.equal(res.ok, true);
    assert.equal(res.reexeced, true);
    assert.equal(childCalls.length, 1);
    assert.equal(childCalls[0].args.includes('--pull'), false);
    assert.equal(childCalls[0].args.includes('--json'), true);
    assert.equal(childCalls[0].env.AG_DEPLOY_REEXEC, '1');
    assert.equal(childCalls[0].env.AG_DEPLOY_PULLED, '1');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('evaluateRestartRequired and runDeploy require restart when v2.34.0 CDP is disabled but daemonLs is running (including --skip-status)', () => {
  assert.deepEqual(
    evaluateRestartRequired({
      liveRunning: false,
      daemonLsRunning: true,
      liveInjected: false
    }),
    { restartRequired: true, reason: 'live_hot_inject_unavailable' }
  );
  assert.deepEqual(
    evaluateRestartRequired({
      liveRunning: false,
      daemonLsRunning: false,
      liveInjected: false
    }),
    { restartRequired: false, reason: 'client_not_running' }
  );

  const rootDir = makeTempDir('ag-deploy-v234-root-');
  const stateDir = makeTempDir('ag-deploy-v234-state-');
  const fakeAsar = path.join(rootDir, 'app.asar');
  try {
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.8.8' }));
    fs.writeFileSync(path.join(rootDir, 'meter-renderer.js'), '// renderer\n');
    fs.writeFileSync(path.join(rootDir, 'meter-core.js'), '// core\n');
    fs.writeFileSync(fakeAsar, 'fake-asar');

    // Case 1: 正常跑 status，v2.34.0 默认无 CDP (liveWindow.running=false)，但 daemonLs.running=true
    const resWithStatus = runDeploy(['--path', fakeAsar, '--json'], {
      rootDir,
      stateDir,
      findAsarPath: (p) => p,
      spawnSync: (_cmd, args) => {
        if (args.includes('install')) {
          return {
            status: 0,
            stdout: '__AG_INSTALL_META__={"meterVersion":"0.8.8","liveInjected":false,"daemonLsRunning":true,"backendHotReloaded":false,"backendSource":null,"hasStaleMainProcess":false}\n',
            stderr: ''
          };
        }
        if (args.includes('status')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              pluginVersion: '0.8.8',
              asarPatched: true,
              daemonLs: { running: true, pid: 12345, origin: 'https://127.0.0.1:40799', lsVersion: '2.34.0' },
              liveWindow: { running: false, cdpDisabled: true, lsRunningViaDaemon: true }
            }),
            stderr: ''
          };
        }
        throw new Error('Unexpected spawn args: ' + args.join(' '));
      },
      stdout: makeMemoryStream(),
      stderr: makeMemoryStream()
    });
    assert.equal(resWithStatus.ok, true);
    assert.equal(resWithStatus.restartRequired, true);
    assert.equal(resWithStatus.restartReason, 'live_hot_inject_unavailable');

    // Case 2: --skip-status 场景下，仅凭 installMeta.daemonLsRunning=true 也必须准确提示需重启
    const resSkipStatus = runDeploy(['--path', fakeAsar, '--skip-status', '--json'], {
      rootDir,
      stateDir,
      findAsarPath: (p) => p,
      spawnSync: (_cmd, args) => {
        if (args.includes('install')) {
          return {
            status: 0,
            stdout: '__AG_INSTALL_META__={"meterVersion":"0.8.8","liveInjected":false,"daemonLsRunning":true,"backendHotReloaded":false,"backendSource":null,"hasStaleMainProcess":false}\n',
            stderr: ''
          };
        }
        throw new Error('Unexpected spawn args: ' + args.join(' '));
      },
      stdout: makeMemoryStream(),
      stderr: makeMemoryStream()
    });
    assert.equal(resSkipStatus.ok, true);
    assert.equal(resSkipStatus.status, null);
    assert.equal(resSkipStatus.restartRequired, true);
    assert.equal(resSkipStatus.restartReason, 'live_hot_inject_unavailable');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
