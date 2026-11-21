'use strict';

const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const { createSyncEngine } = require('./sync');

let server = null;
let bridgeFile = null;
let token = null;
let statusBar = null;
let requestCount = 0;
let lastRequestAt = null;
let lastRequestError = null;
const notified = new Set();
let consecutiveErrors = 0;

function bridgeDir() {
  return process.env.TRAE_JAVA_BRIDGE_DIR || path.join(os.tmpdir(), 'trae-java-bridge');
}

function bridgeFileName(root) {
  // 文件名带 pid：同一工作区开多个窗口时不会互相覆盖
  return hashRoot(root) + '-' + process.pid + '.json';
}

function findJarUnder(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  const jars = entries.filter((e) => e.isFile() && /^lombok.*\.jar$/i.test(e.name));
  if (jars.length) return path.join(dir, jars[0].name);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findJarUnder(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

function lombokInfo() {
  const lombokExt = vscode.extensions.getExtension('vscjava.vscode-lombok')
    || vscode.extensions.getExtension('gabrielbb.vscode-lombok');
  const rh = vscode.extensions.getExtension('redhat.java');
  let agentJar = process.env.LOMBOK_JAR || null;
  if (agentJar && !fs.existsSync(agentJar)) agentJar = null;
  if (!agentJar && rh) agentJar = findJarUnder(path.join(rh.extensionPath, 'lombok'), 1);
  if (!agentJar && lombokExt) agentJar = findJarUnder(lombokExt.extensionPath, 2);
  return {
    extension: lombokExt ? lombokExt.id : null,
    agentJar,
  };
}

function workspaceRoots() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.map((f) => f.uri.fsPath);
}

function firstRoot() {
  const roots = workspaceRoots();
  return roots.length ? roots[0] : null;
}

function hashRoot(root) {
  return crypto.createHash('sha1').update(root || 'workspace').digest('hex').slice(0, 12);
}

function severityName(sev) {
  return { 0: 'error', 1: 'warning', 2: 'info', 3: 'hint' }[sev] || String(sev);
}

function uriToFile(uri) {
  if (!uri) return null;
  try { return uri.fsPath || fileURLToPath(uri); } catch (_) { return String(uri); }
}

// 相对路径兼容两种常见写法：相对工作区根，或“工程目录名/相对路径”（工作区本身就是工程根时）
function pathCandidates(file) {
  if (path.isAbsolute(file)) return [file];
  const root = firstRoot() || process.cwd();
  const out = [path.resolve(root, file)];
  const base = path.basename(root);
  const normalized = String(file).replace(/\\/g, '/');
  if (normalized === base || normalized.startsWith(base + '/')) {
    const rest = normalized.slice(base.length).replace(/^\/+/, '');
    out.push(path.resolve(root, rest || '.'));
  }
  out.push(path.resolve(path.dirname(root), file));
  return [...new Set(out)];
}

// 返回第一个存在的候选；都不存在时返回最佳猜测，由调用方决定是报错还是返回 missing
function resolveFileBest(file) {
  if (!file) throw new Error('缺少 file 参数');
  const candidates = pathCandidates(file);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return { file: c, exists: true }; } catch (_) { /* ignore */ }
  }
  return { file: candidates[0], exists: false };
}

function resolveFile(file) {
  const r = resolveFileBest(file);
  if (!r.exists) throw new Error('文件不存在: ' + r.file);
  return r.file;
}

function toUri(file) {
  return vscode.Uri.file(resolveFile(file));
}

function fileExists(file) {
  try { return !!file && fs.existsSync(file); } catch (_) { return false; }
}

function toPosition(line, column) {
  const ln = Number(line);
  const col = Number(column);
  if (!Number.isFinite(ln) || ln < 1) throw new Error('line 必须从 1 开始');
  if (!Number.isFinite(col) || col < 1) throw new Error('column 必须从 1 开始');
  return new vscode.Position(ln - 1, col - 1);
}

function locationToJson(uri, range) {
  return {
    file: uriToFile(uri),
    line: range && range.start ? range.start.line + 1 : null,
    column: range && range.start ? range.start.character + 1 : null,
    endLine: range && range.end ? range.end.line + 1 : null,
    endColumn: range && range.end ? range.end.character + 1 : null,
  };
}

function normalizeLocations(result) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out = [];
  for (const item of arr) {
    if (!item) continue;
    if (item.targetUri && item.targetRange) {
      out.push(locationToJson(item.targetUri, item.targetRange));
    } else if (item.uri && item.range) {
      out.push(locationToJson(item.uri, item.range));
    } else if (item.location && item.location.uri) {
      out.push(locationToJson(item.location.uri, item.location.range));
    }
  }
  return out;
}

// vscode.SymbolKind 从 0 开始（File=0），与 LSP 的 1 基编号不同，不要照搬 LSP 枚举
function symbolKindName(kind) {
  const names = {
    0: 'File', 1: 'Module', 2: 'Namespace', 3: 'Package', 4: 'Class', 5: 'Method',
    6: 'Property', 7: 'Field', 8: 'Constructor', 9: 'Enum', 10: 'Interface',
    11: 'Function', 12: 'Variable', 13: 'Constant', 14: 'String', 15: 'Number',
    16: 'Boolean', 17: 'Array', 18: 'Object', 19: 'Key', 20: 'Null', 21: 'EnumMember',
    22: 'Struct', 23: 'Event', 24: 'Operator', 25: 'TypeParameter',
  };
  return names[kind] || String(kind);
}

function diagnosticsToJson(uri, list) {
  return (list || []).map((d) => ({
    file: uriToFile(uri),
    line: d.range && d.range.start ? d.range.start.line + 1 : null,
    column: d.range && d.range.start ? d.range.start.character + 1 : null,
    severity: severityName(d.severity),
    message: d.message,
    source: d.source || '',
    code: d.code == null ? '' : String(d.code.value != null ? d.code.value : d.code),
  }));
}

function filterBySeverity(items, severity) {
  if (!severity || severity === 'all') return items;
  return items.filter((d) => d.severity === String(severity).toLowerCase());
}

// 给调用方一个可直接引用的口径：total 只统计本次返回的条目，allTotal 才是全部级别
function languageOf(file) {
  const base = String(file || '');
  const i = base.lastIndexOf('.');
  return i > -1 ? base.slice(i + 1).toLowerCase() : 'unknown';
}

function summarizeDiagnostics(items) {
  const bySeverity = {};
  const bySource = {};
  const byLanguage = {};
  const byCode = {};
  for (const d of items) {
    const source = d.source || 'unknown';
    bySeverity[d.severity] = (bySeverity[d.severity] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
    const lang = languageOf(d.file);
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
    const key = source + (d.code ? ':' + d.code : '');
    byCode[key] = (byCode[key] || 0) + 1;
  }
  return { bySeverity, bySource, byLanguage, byCode };
}

// 文件模式附带工作区残留计数：避免“该文件 0 条”被误读成“整个工作区已清零”
function workspaceDiagnosticTotals() {
  const all = [];
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    if (!uri || uri.scheme !== 'file') continue;
    all.push(...diagnosticsToJson(uri, list));
  }
  const summary = summarizeDiagnostics(all);
  return {
    total: all.length,
    bySeverity: summary.bySeverity,
    bySource: summary.bySource,
    byLanguage: summary.byLanguage,
  };
}

// IDE 命令在索引初始化阶段可能长时间不返回，必须设上限，避免 MCP/扩展一起挂住
function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function execCommand(label, command, ...args) {
  return withTimeout(vscode.commands.executeCommand(command, ...args), commandTimeout(), label);
}

async function handleApi(reqUrl) {
  const url = new URL(reqUrl, 'http://127.0.0.1');
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/health') {
    const rh = vscode.extensions.getExtension('redhat.java');
    return {
      ok: true,
      pid: process.pid,
      windowId: String(vscode.env.sessionId || process.pid),
      workspaces: workspaceRoots(),
      redhatJavaActive: !!(rh && rh.isActive),
      lombok: lombokInfo(),
      bridgeFile,
      sync: syncEngine.describe(),
    };
  }
  if (p === '/diagnostics') {
    const severity = q.get('severity') || 'all';
    const file = q.get('file');
    if (file) {
      const resolved = resolveFileBest(file);
      // 文件已被移动/删除：仍返回 200，但明确标记 missing，而不是 500 让调用方去猜
      if (!resolved.exists) {
        return {
          scope: 'file',
          file: resolved.file,
          severity,
          missing: true,
          total: 0,
          allTotal: 0,
          summary: summarizeDiagnostics([]),
          workspaceTotals: workspaceDiagnosticTotals(),
          items: [],
          consistency: {
            state: 'not_open',
            stale: false,
            dirty: false,
            reloaded: false,
            reason: '文件已不存在（可能被移动或删除）',
          },
        };
      }
      const uri = vscode.Uri.file(resolved.file);
      // 查询路径也做一致性检查：外部写入后先重读磁盘，再返回新鲜诊断
      const consistency = await syncEngine.syncIfNeeded(uri.fsPath);
      const all = diagnosticsToJson(uri, vscode.languages.getDiagnostics(uri));
      const items = filterBySeverity(all, severity);
      return {
        scope: 'file',
        file: uriToFile(uri),
        severity,
        missing: false,
        total: items.length,
        allTotal: all.length,
        summary: summarizeDiagnostics(items),
        workspaceTotals: workspaceDiagnosticTotals(),
        items,
        consistency,
      };
    }
    // 工作区模式过滤掉已删除/已移动文件残留的诊断，避免把幽灵条目当成真实错误
    const all = [];
    const missing = new Set();
    for (const [uri, list] of vscode.languages.getDiagnostics()) {
      if (!uri || uri.scheme !== 'file') continue;
      const target = uriToFile(uri);
      if (!fileExists(target)) {
        if (list && list.length) missing.add(target);
        continue;
      }
      all.push(...diagnosticsToJson(uri, list));
    }
    all.sort((a, b) => String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
    const filtered = filterBySeverity(all, severity);
    const missingFiles = [...missing].sort();
    return {
      scope: 'project',
      severity,
      total: filtered.length,
      allTotal: all.length,
      summary: summarizeDiagnostics(filtered),
      skippedMissing: missingFiles.length,
      missingFiles: missingFiles.slice(0, 20),
      missingTruncated: missingFiles.length > 20,
      items: filtered,
      consistency: syncEngine.projectState(),
    };
  }
  if (p === '/refresh') {
    // 显式刷新项目模型：build=增量编译，config=完整重载（projectConfiguration.update），auto=按变更规模选择
    const mode = q.get('mode') || 'auto';
    const timeout = Number(q.get('timeout')) || undefined;
    return await syncEngine.refreshProject(mode, timeout);
  }
  if (p === '/symbols') {
    const query = q.get('query') || '';
    const limit = Math.min(Number(q.get('limit')) || 50, 200);
    const result = await execCommand('workspace/symbol', 'vscode.executeWorkspaceSymbolProvider', query);
    const mapped = (result || []).map((s) => {
      const loc = s.location || {};
      return {
        name: s.name,
        kind: symbolKindName(s.kind),
        container: s.containerName || '',
        ...locationToJson(loc.uri, loc.range),
      };
    });
    // 索引里可能还留着已删除/已移动文件的旧位置，直接过滤掉
    const items = mapped.filter((i) => fileExists(i.file));
    return { count: items.length, skippedMissing: mapped.length - items.length, items: items.slice(0, limit) };
  }
  if (p === '/definition') {
    const result = await execCommand('definition', 'vscode.executeDefinitionProvider',
      toUri(q.get('file')), toPosition(q.get('line'), q.get('column')));
    const all = normalizeLocations(result);
    const items = all.filter((i) => fileExists(i.file));
    return { items, skippedMissing: all.length - items.length };
  }
  if (p === '/references') {
    const result = await execCommand('references', 'vscode.executeReferenceProvider',
      toUri(q.get('file')), toPosition(q.get('line'), q.get('column')));
    const raw = normalizeLocations(result);
    const all = raw.filter((i) => fileExists(i.file));
    // limit<=0 表示不截断；大仓库引用可能上千条，调用方可按需收窄
    const limit = Math.max(0, Number(q.get('limit')) || 0);
    const items = limit > 0 ? all.slice(0, limit) : all;
    return {
      count: all.length,
      returned: items.length,
      truncated: items.length < all.length,
      skippedMissing: raw.length - all.length,
      items,
    };
  }
  if (p === '/documentSymbols') {
    const resolved = resolveFileBest(q.get('file'));
    if (!resolved.exists) return { file: resolved.file, missing: true, count: 0, items: [] };
    const uri = vscode.Uri.file(resolved.file);
    const wantName = (q.get('name') || '').toLowerCase();
    const wantKind = (q.get('kind') || '').toLowerCase();
    const limit = Math.min(Number(q.get('limit')) || 200, 1000);
    const result = await execCommand('documentSymbols', 'vscode.executeDocumentSymbolProvider', uri);
    const flat = [];
    const walk = (nodes, container) => {
      for (const n of nodes || []) {
        const r = n.selectionRange || n.range;
        const raw = String(n.name || '');
        const params = raw.includes('(') ? raw.slice(raw.indexOf('(')) : '';
        flat.push({
          name: params ? raw.slice(0, raw.indexOf('(')) : raw,
          kind: params ? 'Method' : symbolKindName(n.kind),
          container: container || '',
          detail: params + (n.detail || ''),
          ...locationToJson(uri, r),
        });
        if (n.children) walk(n.children, n.name);
      }
    };
    walk(result, '');
    let items = flat;
    if (wantName) items = items.filter((i) => String(i.name).toLowerCase().includes(wantName));
    if (wantKind) items = items.filter((i) => String(i.kind).toLowerCase() === wantKind);
    return { count: items.length, items: items.slice(0, limit) };
  }
  if (p === '/hover') {
    const result = await execCommand('hover', 'vscode.executeHoverProvider',
      toUri(q.get('file')), toPosition(q.get('line'), q.get('column')));
    const text = (result || []).map((h) => {
      const c = h.contents || [];
      return c.map((x) => (typeof x === 'string' ? x : x.value || '')).join('\n');
    }).join('\n');
    return { text };
  }
  throw new Error('未知接口: ' + p);
}

let extensionVersion = null;

const CONFIG_SECTION = 'traeJavaBridge';

function config() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function isEnabled() {
  return config().get('enabled', true) !== false;
}

function numberSetting(key, fallback, min) {
  const n = Number(config().get(key));
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function syncConfig() {
  return {
    enabled: config().get('sync.enabled', true) !== false,
    debounceMs: numberSetting('sync.debounceMs', 300, 50),
    cooldownMs: numberSetting('sync.cooldownMs', 800, 0),
    maxPer10s: numberSetting('sync.maxPer10s', 3, 1),
    timeoutMs: numberSetting('sync.timeoutMs', 2000, 200),
    maxFileSizeKb: numberSetting('sync.maxFileSizeKb', 2048, 16),
    revertTimeoutMs: numberSetting('sync.revertTimeoutMs', 5000, 500),
    selfWriteGraceMs: numberSetting('sync.selfWriteGraceMs', 1500, 100),
    exclude: String(config().get('watch.exclude') || 'target/build/out/node_modules/.git'),
    autoBuild: config().get('project.autoBuild', true) !== false,
    autoBuildIdleMs: numberSetting('project.autoBuildIdleMs', 2000, 200),
    autoBuildMinGapMs: numberSetting('project.autoBuildMinGapMs', 5000, 0),
    autoConfigMinFiles: numberSetting('project.autoConfigMinFiles', 50, 1),
    buildTimeoutMs: numberSetting('project.buildTimeoutMs', 120000, 5000),
    reloadTimeoutMs: numberSetting('project.reloadTimeoutMs', 15000, 1000),
    reloadQuietMs: numberSetting('project.reloadQuietMs', 800, 100),
    refreshSettleMs: numberSetting('project.refreshSettleMs', 3000, 300),
    changedFilesLimit: numberSetting('project.changedFilesLimit', 20, 1),
    dirtyMaxFiles: numberSetting('project.dirtyMaxFiles', 2000, 100),
  };
}

const syncEngine = createSyncEngine({
  getRoots: workspaceRoots,
  getConfig: syncConfig,
  log: (msg) => console.log('[trae-java-bridge] ' + msg),
  onStatsChanged: () => updateStatusBar(),
});

function commandTimeout() {
  const fromConfig = Number(config().get('commandTimeout'));
  if (Number.isFinite(fromConfig) && fromConfig >= 1000) return fromConfig;
  const fromEnv = Number(process.env.TRAE_JAVA_BRIDGE_TIMEOUT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 15000;
}

function configuredPort() {
  const port = Number(config().get('port'));
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
}

function writeBridgeFile(port) {
  const roots = workspaceRoots();
  // 空窗口没有可用工作区，不写桥接文件，避免 MCP 误连到无关实例
  if (!roots.length) {
    if (bridgeFile) {
      try { fs.unlinkSync(bridgeFile); } catch (_) { /* ignore */ }
      bridgeFile = null;
    }
    return;
  }
  const dir = bridgeDir();
  fs.mkdirSync(dir, { recursive: true });
  const root = roots[0];
  const next = path.join(dir, bridgeFileName(root));
  const rh = vscode.extensions.getExtension('redhat.java');
  const lombok = lombokInfo();
  const payload = {
    port,
    token,
    pid: process.pid,
    windowId: String(vscode.env.sessionId || process.pid),
    workspaceFolders: roots,
    appName: vscode.env.appName || null,
    appHost: vscode.env.appHost || null,
    extensionVersion,
    redhatJavaPath: rh ? rh.extensionPath : null,
    redhatJavaActive: !!(rh && rh.isActive),
    lombokExtension: lombok.extension,
    lombokJar: lombok.agentJar,
    startedAt: new Date().toISOString(),
  };
  if (bridgeFile && bridgeFile !== next) {
    try { fs.unlinkSync(bridgeFile); } catch (_) { /* ignore */ }
  }
  bridgeFile = next;
  fs.writeFileSync(bridgeFile, JSON.stringify(payload, null, 2), 'utf8');
}

function refreshBridgeFile() {
  if (!server || !server.listening) return;
  try {
    writeBridgeFile(server.address().port);
  } catch (e) {
    console.error('[trae-java-bridge] refresh failed: ' + e.message);
  }
}

function activityName(activity) {
  return {
    idle: '空闲',
    syncing: '同步中',
    building: '增量构建',
    reloading: '项目重载',
  }[activity] || String(activity || '空闲');
}

function syncStatusLine() {
  const cfg = syncConfig();
  if (!cfg.enabled) return '同步：已关闭（traeJavaBridge.sync.enabled=false）';
  const s = syncEngine.describe();
  const parts = [
    '已重读 ' + s.reloadedCount + ' 次',
    '脏冲突 ' + s.dirtyConflicts,
    '无需动作 ' + s.noopChecks,
  ];
  if (s.circuitBroken) parts.push('熔断 ' + s.circuitBroken);
  const last = s.lastSyncAt ? '；最近 ' + new Date(s.lastSyncAt).toLocaleTimeString() : '';
  return '同步：' + parts.join('，') + last;
}

function modelStatusLine() {
  const cfg = syncConfig();
  if (!cfg.enabled) return '项目模型：自动刷新已关闭';
  const s = syncEngine.describe();
  const dirty = s.projectDirty && s.projectDirty.needsRefresh
    ? '待刷新（' + (s.projectDirty.changedCount || 0) + ' 个文件）'
    : '已同步';
  const mode = s.lastBuildMode ? '，最近方式 ' + s.lastBuildMode : '';
  const when = s.lastModelRefreshAt ? '，最近刷新 ' + new Date(s.lastModelRefreshAt).toLocaleTimeString() : '';
  return '项目模型：' + dirty + mode + when;
}

// 状态栏文字展示“当前在做什么”，端口只放在悬浮提示里
function bridgeStatus() {
  if (!server || !server.listening) {
    return { key: 'offline', icon: 'debug-disconnect', label: '离线', warn: true, activity: null };
  }
  if (lastRequestError) {
    return { key: 'error', icon: 'warning', label: '异常', warn: true, activity: null };
  }
  if (!syncConfig().enabled) {
    return { key: 'ok', icon: 'radio-tower', label: '正常（同步关闭）', warn: false, activity: null };
  }
  const s = syncEngine.describe();
  if (s.activity === 'reloading') return { key: 'reloading', icon: 'sync~spin', label: '重载中', warn: false, activity: s.activity };
  if (s.activity === 'building') return { key: 'building', icon: 'sync~spin', label: '构建中', warn: false, activity: s.activity };
  if (s.activity === 'syncing') return { key: 'syncing', icon: 'sync~spin', label: '同步中', warn: false, activity: s.activity };
  if (s.projectDirty && s.projectDirty.needsRefresh) {
    const n = s.projectDirty.changedCount || 0;
    return { key: 'stale', icon: 'warning', label: '待刷新' + (n ? '(' + n + ')' : ''), warn: true, activity: 'idle' };
  }
  return { key: 'ok', icon: 'radio-tower', label: '正常', warn: false, activity: 'idle' };
}

function updateStatusBar() {
  if (!statusBar) return;
  if (!isEnabled()) {
    statusBar.hide();
    return;
  }
  statusBar.show();
  const roots = workspaceRoots();
  const rh = vscode.extensions.getExtension('redhat.java');
  const lombok = lombokInfo();
  const status = bridgeStatus();
  const running = !!(server && server.listening);

  statusBar.text = '$(' + status.icon + ') JDT Bridge:' + status.label;
  statusBar.backgroundColor = status.warn
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;

  const lines = ['状态：' + status.label];
  if (running) lines.push('端口：' + server.address().port);
  lines.push(
    '同步活动：' + (status.activity ? activityName(status.activity) : '—'),
    '工作区：' + (roots.length ? roots.join(', ') : '（未打开文件夹）'),
    'redhat.java：' + (rh ? (rh.isActive ? '已激活' : '已安装未激活') : '未安装'),
  );
  if (running) {
    lines.push(
      'Lombok：' + (lombok.agentJar ? '已启用' : '未探测到'),
      '请求数：' + requestCount + (lastRequestAt ? '（最近 ' + lastRequestAt.toLocaleTimeString() + '）' : ''),
      '最近错误：' + (lastRequestError || '无'),
      syncStatusLine(),
      modelStatusLine(),
    );
  } else {
    lines.push('最近错误：' + (lastRequestError || '无'), syncStatusLine());
  }
  statusBar.tooltip = lines.join('\n');
}

async function showStatus() {
  const roots = workspaceRoots();
  const rh = vscode.extensions.getExtension('redhat.java');
  const lombok = lombokInfo();
  const running = !!(server && server.listening);
  const status = bridgeStatus();
  const items = [
    '状态：' + status.label,
    '同步活动：' + (status.activity ? activityName(status.activity) : '—'),
    '端口：' + (running ? server.address().port : '—'),
    '工作区：' + (roots.length ? roots.join(', ') : '（未打开文件夹）'),
    'redhat.java：' + (rh ? (rh.isActive ? '已激活' : '已安装未激活') : '未安装'),
    'Lombok：' + (lombok.agentJar ? lombok.agentJar : '未探测到'),
    '请求数：' + requestCount + (lastRequestAt ? '，最近 ' + lastRequestAt.toLocaleString() : ''),
    '最近错误：' + (lastRequestError || '无'),
    syncStatusLine(),
    modelStatusLine(),
    '桥接文件：' + (bridgeFile || '未写入'),
  ].map((label) => ({ label }));
  await vscode.window.showQuickPick(items, {
    title: 'Trae Java Bridge 状态',
    placeHolder: 'Esc 关闭；可从命令面板执行“重启桥接”',
  });
}

// 用 IDE 通知面板提示，而不是把异常抛给用户；同一问题每个窗口只提示一次
function notify(level, key, message, actions) {
  if (notified.has(key)) return;
  notified.add(key);
  const show = level === 'error' ? vscode.window.showErrorMessage
    : level === 'warning' ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;
  show(message, ...(actions || [])).then((choice) => {
    if (choice === '查看状态') showStatus();
    else if (choice === '重启桥接') restartBridge();
  });
}

function startServer() {
  token = crypto.randomBytes(24).toString('hex');
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    handleApi(req.url)
      .then((data) => {
        requestCount++;
        lastRequestAt = new Date();
        lastRequestError = null;
        consecutiveErrors = 0;
        notified.delete('requests-failing');
        updateStatusBar();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      })
      .catch((e) => {
        lastRequestAt = new Date();
        lastRequestError = e.message;
        consecutiveErrors++;
        if (consecutiveErrors >= numberSetting('notifyAfterErrors', 3, 1)) {
          notify('warning', 'requests-failing',
            'Trae Java Bridge：连续 ' + consecutiveErrors + ' 次请求失败（' + e.message + '）。JDT LS 可能尚未就绪。',
            ['查看状态', '重启桥接']);
        }
        updateStatusBar();
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(configuredPort(), '127.0.0.1', () => {
      const port = server.address().port;
      notified.delete('start-failed');
      writeBridgeFile(port);
      updateStatusBar();
      resolve(port);
    });
  });
}

function stopServer() {
  try { if (server) server.close(); } catch (_) { /* ignore */ }
  try { if (bridgeFile && fs.existsSync(bridgeFile)) fs.unlinkSync(bridgeFile); } catch (_) { /* ignore */ }
  try {
    const dir = bridgeDir();
    if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } catch (_) { /* ignore */ }
  server = null;
  bridgeFile = null;
  updateStatusBar();
}

function restartBridge() {
  const wasRunning = !!(server && server.listening);
  stopServer();
  if (!isEnabled()) {
    console.log('[trae-java-bridge] disabled by settings');
    if (wasRunning) {
      notify('info', 'bridge-disabled', 'Trae Java Bridge 已停用，MCP 将回退到独立 JDT LS。', ['查看状态']);
    }
    return;
  }
  startServer().then((port) => {
    console.log('[trae-java-bridge] listening on 127.0.0.1:' + port);
  }).catch((e) => {
    console.error('[trae-java-bridge] failed: ' + e.message);
    notify('error', 'start-failed',
      'Trae Java Bridge 启动失败：' + e.message +
      (e.code === 'EADDRINUSE' ? '（端口被占用，可在设置中把 port 改为 0）' : ''),
      ['查看状态', '重启桥接']);
  });
}

function activate(context) {
  extensionVersion = context.extension && context.extension.packageJSON
    ? context.extension.packageJSON.version || null
    : null;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'traeJavaBridge.showStatus';
  context.subscriptions.push(statusBar);
  updateStatusBar();
  context.subscriptions.push(vscode.commands.registerCommand('traeJavaBridge.showStatus', showStatus));
  context.subscriptions.push(vscode.commands.registerCommand('traeJavaBridge.restart', restartBridge));
  if (isEnabled()) {
    startServer().then((port) => {
      console.log('[trae-java-bridge] listening on 127.0.0.1:' + port);
    }).catch((e) => {
      console.error('[trae-java-bridge] failed: ' + e.message);
      notify('error', 'start-failed',
        'Trae Java Bridge 启动失败：' + e.message +
        (e.code === 'EADDRINUSE' ? '（端口被占用，可在设置中把 port 改为 0）' : ''),
        ['查看状态', '重启桥接']);
    });
  } else {
    console.log('[trae-java-bridge] disabled by settings');
  }
  // 工作区切换后重写桥接文件，避免 MCP 连到过期的工作区/端口
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    refreshBridgeFile();
    syncEngine.refreshWatcher();
    updateStatusBar();
  }));
  // 设置变更：enabled / port 需要重启监听；commandTimeout 下次请求即时生效
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(CONFIG_SECTION)) return;
    if (e.affectsConfiguration(CONFIG_SECTION + '.enabled')
      || e.affectsConfiguration(CONFIG_SECTION + '.port')) {
      restartBridge();
    } else {
      if (e.affectsConfiguration(CONFIG_SECTION + '.sync')
        || e.affectsConfiguration(CONFIG_SECTION + '.watch')
        || e.affectsConfiguration(CONFIG_SECTION + '.project')) {
        syncEngine.refreshWatcher();
      }
      updateStatusBar();
    }
  }));
  syncEngine.refreshWatcher();
  context.subscriptions.push({ dispose: () => syncEngine.dispose() });
  context.subscriptions.push({ dispose: stopServer });
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };