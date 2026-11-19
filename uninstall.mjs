#!/usr/bin/env node
'use strict';

// 卸载器：优先用 IDE CLI 卸载（会同步清理扩展登记状态）；无 CLI 时回退到目录删除 + 登记表清理。
// 用法：node uninstall.mjs [--extensions-root <dir>] [--cli <ide 可执行文件>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const manifest = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const extId = manifest.publisher + '.' + manifest.name;

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

function stripRegistry(root) {
  const file = path.join(root, 'extensions.json');
  if (!fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.extensions || []);
    const kept = list.filter((e) => {
      const id = e.identifier && (e.identifier.id || e.identifier.value);
      return id !== extId;
    });
    if (kept.length === list.length) return;
    if (Array.isArray(data)) fs.writeFileSync(file, JSON.stringify(kept), 'utf8');
    else { data.extensions = kept; fs.writeFileSync(file, JSON.stringify(data), 'utf8'); }
    console.log('Removed registry entry from ' + file);
  } catch (e) {
    console.log('Skip registry cleanup: ' + e.message);
  }
}

function runCli(cli, args) {
  // Windows 下 CLI 是 .cmd，Node 直接 spawn 会 ENOENT；统一经 shell 调用
  const line = `"${cli}" ${args.map((a) => `"${a}"`).join(' ')}`;
  return spawnSync(line, { shell: true, stdio: 'inherit' });
}

const explicitRoot = argValue('--extensions-root') || process.env.TRAE_EXTENSIONS_ROOT;
const roots = explicitRoot ? [path.resolve(explicitRoot)] : extensionRoots();

const cli = findCli();
if (cli) {
  console.log('Uninstalling via ' + cli);
  const r = runCli(cli, ['--uninstall-extension', extId]);
  if (r.status === 0) {
    console.log('Uninstalled ' + extId + '. Reload the IDE window.');
  } else {
    console.log('CLI uninstall failed; fallback to directory cleanup.');
  }
}

let removed = 0;
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const name of fs.readdirSync(root)) {
    if (!name.toLowerCase().startsWith(extId.toLowerCase() + '-')) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    removed++;
    console.log('Removed ' + path.join(root, name));
  }
  stripRegistry(root);
}

// 清理桥接文件（按本项目 schema 识别，避免误删其他扩展的会合文件）
const bridgeDir = process.env.TRAE_JAVA_BRIDGE_DIR
  || process.env.JAVA_NAV_BRIDGE_DIR
  || path.join(os.tmpdir(), 'trae-java-bridge');
try {
  if (fs.existsSync(bridgeDir)) {
    for (const name of fs.readdirSync(bridgeDir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(bridgeDir, name);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const ours = data.port && data.token && data.pid && data.workspaceFolders && data.startedAt;
        if (!ours) continue;
        fs.unlinkSync(file);
        console.log('Removed bridge file ' + file);
      } catch (_) { /* ignore */ }
    }
    if (!fs.readdirSync(bridgeDir).length) fs.rmdirSync(bridgeDir);
  }
} catch (_) { /* ignore */ }

console.log(removed || cli ? 'Done. Reload the IDE window.' : 'Extension directory not found; nothing to remove.');