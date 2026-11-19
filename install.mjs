#!/usr/bin/env node
'use strict';

// 跨平台安装器：Windows / macOS / Linux
// 用法：
//   node install.mjs                         目录安装（IDE 启动时扫描登记）
//   node install.mjs --vsix <file.vsix>      通过 IDE CLI 安装（推荐发行方式）
//   node install.mjs --extensions-root <dir> --cli <ide 可执行文件>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const src = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
const extId = manifest.publisher + '.' + manifest.name;
const version = manifest.version;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

function extensionRoots() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const out = [];
  if (process.platform === 'win32') {
    out.push(path.join(home, '.trae-cn', 'extensions'), path.join(home, '.trae', 'extensions'));
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      out.push(path.join(appData, n, 'extensions'));
    }
  } else if (process.platform === 'darwin') {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      out.push(path.join(home, 'Library', 'Application Support', n, 'extensions'));
    }
    out.push(path.join(home, '.trae-cn', 'extensions'), path.join(home, '.trae', 'extensions'));
  } else {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      out.push(path.join(home, '.config', n, 'extensions'));
    }
    out.push(path.join(home, '.trae-cn', 'extensions'), path.join(home, '.trae', 'extensions'));
  }
  return [...new Set(out)];
}

function findCli() {
  const explicit = argValue('--cli') || process.env.TRAE_CLI || null;
  // 显式指定时不再扫描 PATH：避免指定错误却误用其他 IDE
  if (explicit !== null) return fs.existsSync(explicit) ? explicit : null;
  const names = process.platform === 'win32'
    ? ['trae-cn.cmd', 'trae.cmd', 'code.cmd']
    : ['trae-cn', 'trae', 'code'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function runCli(cli, args) {
  // Windows 下 CLI 是 .cmd，Node 直接 spawn 会 ENOENT；统一经 shell 调用
  const line = `"${cli}" ${args.map((a) => `"${a}"`).join(' ')}`;
  return spawnSync(line, { shell: true, stdio: 'inherit' });
}

const vsix = argValue('--vsix');
if (vsix) {
  const cli = findCli();
  if (!cli) {
    console.error('未找到 IDE CLI。请用 --cli 指定 IDE 安装目录下的 CLI（Windows 为 bin\\trae-cn.cmd，macOS/Linux 为 bin/trae-cn），或在 IDE 里手动“从 VSIX 安装”。');
    process.exit(1);
  }
  const r = runCli(cli, ['--install-extension', path.resolve(vsix), '--force']);
  process.exit(r.status === 0 ? 0 : 1);
}

const explicitRoot = argValue('--extensions-root') || process.env.TRAE_EXTENSIONS_ROOT;
let root = explicitRoot ? path.resolve(explicitRoot) : null;
if (!root) {
  for (const c of extensionRoots()) {
    if (fs.existsSync(c)) { root = c; break; }
  }
}
if (!root) root = extensionRoots()[0];

const target = path.join(root, extId + '-' + version);
// 升级时清理同扩展的旧版本目录
for (const name of fs.readdirSync(root)) {
  if (!name.toLowerCase().startsWith(extId.toLowerCase() + '-')) continue;
  if (name === path.basename(target)) continue;
  fs.rmSync(path.join(root, name), { recursive: true, force: true });
}
fs.rmSync(target, { recursive: true, force: true });
copyDir(src, target);

console.log('Installed to ' + target);
console.log('Reload the IDE window. The bridge writes port/token to the system temp directory: trae-java-bridge\\');
console.log('发行安装建议：npx @vscode/vsce package 打包 VSIX 后执行 node install.mjs --vsix <file.vsix>，由 IDE 自行登记 enable/disable 状态。');