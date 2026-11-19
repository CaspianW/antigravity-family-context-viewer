'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { parseArgs } = require('node:util');
const { getStateDir } = require('./asar-engine');
const { getPricingLedgerPath, buildAccountScopeKey } = require('./meter-collector');
const { getSharedAccountsManager } = require('./meter-accounts');
const { createFamilySync } = require('./meter-family-sync');

function readJoinFile(file) {
  const candidates = [
    path.resolve('family-join.json'),
    path.join(__dirname, 'family-join.json'),
    path.join(__dirname, '..', 'family-join.json')
  ];
  const filename = file ? path.resolve(file) : candidates.find(candidate => fs.existsSync(candidate));
  if (!filename) throw new Error('请把管理员私发的 family-join.json 放进解压后的安装目录，或用 --join 指定路径。');
  let join;
  try {
    join = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    throw new Error('无法读取加入配置，请检查该文件是否为有效的 family-join.json。');
  }
  if (typeof join?.serverUrl !== 'string' || typeof join.familySecret !== 'string' || !join.familySecret) {
    throw new Error('加入配置缺少服务器地址或家庭组密钥。');
  }
  return { serverUrl: join.serverUrl, familySecret: join.familySecret };
}

async function getSelections(options, members, accounts, currentMemberId) {
  if (!accounts.length) throw new Error('请先打开 Antigravity 并登录要同步的账号，再重新运行安装脚本。');
  const currentMember = members.find(member => member.id === currentMemberId && !member.archived);
  const activeMembers = members.filter(member => !member.archived);
  let memberName = options.member;
  let account = options.account ? accounts.find(item => item.key === options.account ||
    item.key === buildAccountScopeKey(options.account)) : null;
  if (options.account && !account) throw new Error('指定的账号不在这台电脑的已检测账号列表中。');
  if (!options.member || !account) {
    if (!process.stdin.isTTY) throw new Error('请在终端运行以选择成员和上报账号，或传入 --member 和 --account。');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!options.member) {
        if (activeMembers.length) console.log('已有成员  ' + activeMembers.map(member => member.name).join('、'));
        const previous = currentMember ? '（直接回车沿用 ' + currentMember.name + '）' : '';
        memberName = (await prompt.question('输入你的成员显示名' + previous + ' > ')).trim() || currentMember?.name;
      }
      if (!account) {
        console.log('选择一项自动上报到家庭用量看板的 Antigravity 账号。');
        for (const [index, item] of accounts.entries()) {
          console.log((index + 1) + '. ' + item.label + (item.active ? '（当前登录）' : ''));
        }
        const index = Number((await prompt.question('输入账号编号 > ')).trim()) - 1;
        account = Number.isInteger(index) ? accounts[index] : null;
      }
    } finally {
      prompt.close();
    }
  }
  memberName = memberName?.trim();
  if (!memberName || memberName.length > 64 || /[@\u0000-\u001f\u007f]/.test(memberName)) {
    throw new Error('成员显示名需为 1 至 64 个字符，请使用昵称。');
  }
  if (!account) throw new Error('请选择要上报的账号编号。');
  const sameName = members.find(member => member.name.toLowerCase() === memberName.toLowerCase());
  if (sameName?.archived) throw new Error('该成员已归档，请在管理页恢复成员后再安装。');
  return { memberName, existingMember: sameName, account };
}

async function createOrFindMember(action, join, memberName) {
  try {
    return await action('createMember', { ...join, name: memberName });
  } catch (error) {
    if (!error.message.startsWith('Family server HTTP 409')) throw error;
    const { members } = await action('connect', join);
    const member = members.find(item => !item.archived && item.name.toLowerCase() === memberName.toLowerCase());
    if (!member) throw error;
    return member;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      join: { type: 'string' },
      member: { type: 'string' },
      account: { type: 'string' },
      path: { type: 'string' }
    }
  });
  if (values.help) {
    console.log('node setup-family.js [--join <family-join.json>] [--path <app.asar>]');
    console.log('可选非交互参数 --member <显示名> --account <本机账号邮箱或账号键>');
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 4)) throw new Error('请使用 Node.js 22.4 或更高版本。');

  const join = readJoinFile(values.join);
  const engine = createFamilySync({ stateDir: getStateDir(), ledgerPath: getPricingLedgerPath() });
  const action = async (name, fields = {}) => {
    const result = await engine.action({ ...fields, action: name });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  try {
    const { members } = await action('connect', join);
    await getSharedAccountsManager().detectCurrentActiveAccount();
    const local = await action('overview');
    const { memberName, existingMember, account } = await getSelections(values, members, local.accounts, local.memberId);

    const args = [path.join(__dirname, 'cli.js'), 'install', '--enable-meter'];
    if (values.path) args.push('--path', path.resolve(values.path));
    const install = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (install.error || install.status !== 0) {
      throw new Error('桌面插件安装失败。请按上面的安装器提示处理后重试。');
    }

    const member = existingMember ?? await createOrFindMember(action, join, memberName);
    await action('save', { ...join, memberId: member.id, sharedAccountKey: account.key, enabled: true });
    console.log('自动上报已开启  ' + member.name + ' · ' + account.label);
    try {
      await action('sync');
      console.log('同步服务连接成功。新产生且归属于所选账号的用量会自动上报。');
    } catch (error) {
      console.log('首次同步未完成，插件运行时会继续重试。' + error.message);
    }
    console.log('若当前窗口还没看到「家庭组」页签，请重启 Antigravity。');
  } finally {
    engine.stop();
  }
}

main().catch(error => {
  console.error('设置未完成。' + error.message);
  process.exitCode = 1;
});
