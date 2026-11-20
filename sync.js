'use strict';

// JDT LS 文档一致性兜底：外部写入（脚本/AI/git）不会触发 didChange，
// JDT 的工作副本可能停留在旧内容。这里在诊断查询与文件监听两条路径上
// 共用同一个“比较 → 重读磁盘 → 等待诊断”的同步动作。

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

// 下面这些默认值都可由扩展设置覆盖：traeJavaBridge.sync.* / traeJavaBridge.project.*
const DEFAULT_MAX_FILE_KB = 2048;
const DEFAULT_DIRTY_LIMIT = 20;
const DEFAULT_DIRTY_MAX = 2000;
const DEFAULT_BUILD_IDLE_MS = 2000;
const DEFAULT_BUILD_MIN_GAP_MS = 5000;
const DEFAULT_BUILD_TIMEOUT_MS = 120000;
const CIRCUIT_WINDOW_MS = 10000;
const DEFAULT_SELF_WRITE_GRACE_MS = 1500;
const DEFAULT_REVERT_TIMEOUT_MS = 5000;
const DEFAULT_AUTO_CONFIG_MIN_FILES = 50;
const DEFAULT_RELOAD_QUIET_MS = 800;
const DEFAULT_RELOAD_TIMEOUT_MS = 15000;
const MAX_REFRESH_WAIT_MS = 60000;

function num(value, fallback, min) {
  const n = Number(value);
  return Number.isFinite(n) && n >= (min == null ? 0 : min) ? n : fallback;
}

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
}

function samePath(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function consistency(state, extra) {
  const e = extra || {};
  return {
    state,
    stale: e.stale === true,
    dirty: e.dirty === true,
    reloaded: e.reloaded === true,
    reason: e.reason || null,
  };
}

function parseExclude(value) {
  return String(value || '')
    .split(/[,;/\\]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function createSyncEngine(options) {
  const getRoots = options.getRoots;
  const getConfig = options.getConfig;
  const log = options.log || (() => {});
  const onStatsChanged = options.onStatsChanged || (() => {});

  function cfgNumber(key, fallback, min) {
    return num(getConfig()[key], fallback, min);
  }

  // key（Windows 小写绝对路径）→ 每个文件的一致性状态
  const registry = new Map();
  // 同一文件并发请求合并：后到者等待同一结果
  const inflight = new Map();
  // 外部变更但未打开的文件：项目级标记可能滞后
  const projectDirty = new Set();
  // 兜底路径自己写盘后产生的监听事件，短时间内忽略
  const selfWrites = new Map();
  const pending = new Map();

  const stats = {
    lastSyncAt: null,
    lastSyncFile: null,
    reloadedCount: 0,
    dirtyConflicts: 0,
    noopChecks: 0,
    circuitBroken: 0,
    checks: 0,
    lastBuildAt: null,
    lastBuildMode: null,
    lastBuildError: null,
    lastModelRefreshAt: null,
  };

  let watcher = null;
  let debounceTimer = null;
  let buildTimer = null;
  let building = false;
  let buildQueued = false;
  let buildQueuedConfig = false;
  let pendingConfigRefresh = false;
  let projectDirtySince = 0;
  let syncingCount = 0;
  let refreshActivity = null;
  let disposed = false;

  function currentActivity() {
    if (refreshActivity) return refreshActivity;
    return syncingCount > 0 ? 'syncing' : 'idle';
  }

  function setRefreshActivity(kind) {
    if (refreshActivity === kind) return;
    refreshActivity = kind;
    onStatsChanged();
  }

  function keyOf(file) {
    const p = path.resolve(file);
    return process.platform === 'win32' ? p.toLowerCase() : p;
  }

  function entryFor(key) {
    let entry = registry.get(key);
    if (!entry) {
      entry = {
        diskMtime: 0,
        diskSize: -1,
        docVersion: -1,
        lastSyncAt: 0,
        failedAt: 0,
        syncTimes: [],
        circuitUntil: 0,
      };
      registry.set(key, entry);
    }
    return entry;
  }

  function remember(key, stat, doc) {
    const entry = entryFor(key);
    entry.diskMtime = stat.mtimeMs;
    entry.diskSize = stat.size;
    entry.docVersion = doc.version;
  }

  function findDocument(file) {
    const wanted = path.resolve(file);
    return vscode.workspace.textDocuments.find(
      (d) => d.uri && d.uri.scheme === 'file' && samePath(d.uri.fsPath, wanted),
    ) || null;
  }

  function isExcluded(file, excludeValue) {
    const excluded = parseExclude(excludeValue);
    if (!excluded.length) return false;
    const target = path.resolve(file);
    for (const root of getRoots() || []) {
      if (!root) continue;
      const rel = path.relative(path.resolve(root), target);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const segments = rel.split(/[\\/]+/).map((s) => s.toLowerCase());
      // 只看目录段，文件名本身不参与排除
      for (let i = 0; i < segments.length - 1; i++) {
        if (excluded.includes(segments[i])) return true;
      }
    }
    return false;
  }

  function noteProjectDirty(file) {
    const max = cfgNumber('dirtyMaxFiles', DEFAULT_DIRTY_MAX, 100);
    if (projectDirty.size < max) {
      projectDirty.add(path.resolve(file));
      if (!projectDirtySince) projectDirtySince = Date.now();
    }
  }

  function clearProjectDirty() {
    projectDirty.clear();
    projectDirtySince = 0;
  }

  function projectState() {
    const cfg = getConfig();
    if (!cfg.enabled || !projectDirty.size) {
      return {
        state: 'current',
        needsRefresh: false,
        changedFiles: [],
        truncated: false,
        changedCount: 0,
        dirtySince: null,
        refreshHint: null,
      };
    }
    const files = [...projectDirty].sort();
    const limit = cfgNumber('changedFilesLimit', DEFAULT_DIRTY_LIMIT, 1);
    return {
      state: 'stale',
      needsRefresh: true,
      changedCount: files.length,
      changedFiles: files.slice(0, limit),
      truncated: files.length > limit,
      dirtySince: new Date(projectDirtySince || Date.now()).toISOString(),
      refreshHint: 'java_diagnostics {refresh:"auto"}；仍陈旧时用 refresh:"config" 强制完整重载',
    };
  }

  // 首选只读重载：revert 只更新编辑器文本模型，不写磁盘
  async function applyDiskContent(doc, diskText) {
    const uri = doc.uri;
    const expected = normalizeText(diskText);
    // 旧版 IDE 的 revert 可能只作用于活动编辑器：活动编辑器有别的脏文件时不冒这个险
    const active = vscode.window && vscode.window.activeTextEditor;
    const activeOtherDirty = active && active.document && active.document.uri
      && !samePath(active.document.uri.fsPath, uri.fsPath) && active.document.isDirty;
    if (!activeOtherDirty) {
      try {
        await withTimeout(
          vscode.commands.executeCommand('workbench.action.files.revert', uri),
          cfgNumber('revertTimeoutMs', DEFAULT_REVERT_TIMEOUT_MS, 500),
          'revert',
        );
      } catch (_) { /* 交给下面的校验与兜底 */ }
      for (let i = 0; i < 4; i++) {
        if (!doc.isDirty && normalizeText(doc.getText()) === expected) return true;
        await delay(50);
      }
    }
    if (doc.isDirty) return false;

    // 兜底：整篇替换 + 保存。仅在 revert 不可用时使用，并记录自写事件
    try {
      const text = doc.getText();
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), diskText);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) return false;
      if (normalizeText(doc.getText()) !== expected) return false;
      const saved = await doc.save();
      if (!saved) return false;
      selfWrites.set(keyOf(uri.fsPath), Date.now());
      log('revert 不可用，已用整篇替换兜底：' + path.basename(uri.fsPath));
      return true;
    } catch (e) {
      log('整篇替换兜底失败: ' + e.message);
      return false;
    }
  }

  // 在重读前先订阅，避免 JDT 抢在订阅前发布诊断导致误判超时
  function createDiagnosticsProbe(uri) {
    let hit = false;
    let resolveHit = null;
    let cleaned = false;
    const hitPromise = new Promise((resolve) => { resolveHit = resolve; });
    const listener = vscode.languages.onDidChangeDiagnostics((event) => {
      for (const changed of (event && event.uris) || []) {
        if (changed.scheme === uri.scheme && samePath(changed.fsPath, uri.fsPath)) {
          hit = true;
          resolveHit(true);
          return;
        }
      }
    });
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      listener.dispose();
    }
    return {
      wait(timeoutMs) {
        if (hit) {
          cleanup();
          return Promise.resolve(true);
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            cleanup();
            resolve(false);
          }, Math.max(200, timeoutMs));
          hitPromise.then(() => {
            clearTimeout(timer);
            cleanup();
            resolve(true);
          });
        });
      },
      dispose: cleanup,
    };
  }

  async function doSync(file, key, opts) {
    const cfg = getConfig();
    const waitDiagnostics = !opts || opts.waitDiagnostics !== false;
    stats.checks++;
    if (!cfg.enabled) {
      stats.noopChecks++;
      return consistency('current', { reason: '已关闭自动同步（traeJavaBridge.sync.enabled=false）' });
    }
    let stat;
    try { stat = fs.statSync(file); } catch (_) {
      registry.delete(key);
      return consistency('not_open', { reason: '磁盘上不存在该文件' });
    }
    if (isExcluded(file, cfg.exclude)) {
      stats.noopChecks++;
      return consistency('not_open', { reason: '文件位于监听排除目录' });
    }
    const doc = findDocument(file);
    if (!doc) {
      // 查询路径不记录项目级脏标记：文件未打开本身不算外部变更
      stats.noopChecks++;
      return consistency('not_open', { reason: '文件未打开，诊断来自 JDT 磁盘模型' });
    }
    if (doc.isDirty) {
      stats.dirtyConflicts++;
      return consistency('dirty', { dirty: true, reason: '编辑器有未保存修改，未做同步' });
    }
    const entry = entryFor(key);
    // 快速路径：磁盘与编辑器自上次检查后都没变
    if (entry.diskMtime === stat.mtimeMs && entry.diskSize === stat.size && entry.docVersion === doc.version) {
      stats.noopChecks++;
      return consistency('current');
    }
    if (stat.size > cfgNumber('maxFileSizeKb', DEFAULT_MAX_FILE_KB, 16) * 1024) {
      stats.noopChecks++;
      return consistency('unknown', { stale: true, reason: '文件过大，跳过一致性比较' });
    }
    if (entry.failedAt && Date.now() - entry.failedAt < cfg.cooldownMs) {
      stats.noopChecks++;
      return consistency('unknown', { stale: true, reason: '上次同步失败，冷却中' });
    }
    let diskText;
    try {
      diskText = fs.readFileSync(file, 'utf8');
    } catch (e) {
      entry.failedAt = Date.now();
      return consistency('unknown', { stale: true, reason: '读取磁盘失败：' + e.message });
    }
    if (diskText.includes('\uFFFD')) {
      return consistency('unknown', { stale: true, reason: '文件不是 UTF-8，未做比较' });
    }
    const expected = normalizeText(diskText);
    if (normalizeText(doc.getText()) === expected) {
      remember(key, stat, doc);
      stats.noopChecks++;
      return consistency('current');
    }

    const now = Date.now();
    if (entry.circuitUntil && now < entry.circuitUntil) {
      stats.noopChecks++;
      return consistency('unknown', { stale: true, reason: '该文件同步过于频繁，已暂停自动同步' });
    }
    entry.syncTimes = entry.syncTimes.filter((t) => now - t < CIRCUIT_WINDOW_MS);
    if (entry.syncTimes.length >= cfg.maxPer10s) {
      entry.circuitUntil = now + CIRCUIT_WINDOW_MS;
      stats.circuitBroken++;
      stats.noopChecks++;
      log('熔断：10 秒内同步次数超限 ' + file);
      onStatsChanged();
      return consistency('unknown', { stale: true, reason: '该文件 10 秒内同步次数超限，已熔断' });
    }
    // 应用前再确认一次，避免覆盖用户刚输入的修改
    if (doc.isDirty) {
      stats.dirtyConflicts++;
      return consistency('dirty', { dirty: true, reason: '编辑器有未保存修改，未做同步' });
    }
    entry.syncTimes.push(now);
    // 后台监听路径不需要等待诊断：批量重读时逐个等待会放大总耗时
    syncingCount++;
    onStatsChanged();
    let probe = null;
    let applied = false;
    let fresh = true;
    try {
      probe = waitDiagnostics ? createDiagnosticsProbe(doc.uri) : null;
      applied = await applyDiskContent(doc, diskText);
      if (applied && probe) fresh = await probe.wait(cfg.timeoutMs);
    } finally {
      if (!applied && probe) probe.dispose();
      syncingCount--;
      onStatsChanged();
    }
    if (!applied) {
      entry.failedAt = Date.now();
      log('重读磁盘失败：' + file);
      return consistency('unknown', { stale: true, reason: '重读磁盘失败（编辑器拒绝更新）' });
    }
    entry.failedAt = 0;
    entry.lastSyncAt = Date.now();
    stats.lastSyncAt = new Date();
    stats.lastSyncFile = file;
    stats.reloadedCount++;
    let after = stat;
    try { after = fs.statSync(file); } catch (_) { /* 保持旧值 */ }
    remember(key, after, doc);
    onStatsChanged();
    log('已重读 ' + path.basename(file) + (probe && !fresh ? '（等待诊断刷新超时）' : ''));
    return consistency('reloaded', {
      reloaded: true,
      stale: !fresh,
      reason: probe && !fresh ? '已重读磁盘，但等待诊断刷新超时' : null,
    });
  }

  // 查询路径与监听路径共用；同一文件并发调用合并成一次
  function syncIfNeeded(file, opts) {
    const p = path.resolve(file);
    const key = keyOf(p);
    if (inflight.has(key)) return inflight.get(key);
    const promise = doSync(p, key, opts || {})
      .catch((e) => {
        stats.noopChecks++;
        log('同步异常: ' + e.message);
        return consistency('unknown', { stale: true, reason: '同步异常：' + e.message });
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  function schedule(uri, kind) {
    const file = uri && uri.fsPath;
    if (!file) return;
    const key = keyOf(file);
    pending.set(key, { file, kind });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { flush(); }, Math.max(50, getConfig().debounceMs || 300));
  }

  async function flush() {
    debounceTimer = null;
    const items = [...pending.values()];
    pending.clear();
    const cfg = getConfig();
    if (!cfg.enabled || !items.length) return;
    for (const item of items) {
      if (isExcluded(item.file, cfg.exclude)) continue;
      const key = keyOf(item.file);
      const selfWriteAt = selfWrites.get(key);
      if (selfWriteAt && Date.now() - selfWriteAt < cfgNumber('selfWriteGraceMs', DEFAULT_SELF_WRITE_GRACE_MS, 100)) continue;
      if (item.kind === 'delete') {
        registry.delete(key);
        noteProjectDirty(item.file);
        continue;
      }
      if (!findDocument(item.file)) {
        noteProjectDirty(item.file);
        continue;
      }
      await syncIfNeeded(item.file, { waitDiagnostics: false });
    }
    if (projectDirty.size && cfg.autoBuild) {
      scheduleBuild(projectDirty.size >= cfgNumber('autoConfigMinFiles', DEFAULT_AUTO_CONFIG_MIN_FILES, 1));
    }
    onStatsChanged();
  }

  // 查找构建文件：工作区根优先；仓库根 + 后端子目录布局时向下找一层（最多 3 层）
  // 传构建文件 URI 才能让 java.projectConfiguration.update 定位到具体项目
  function projectBuildFiles() {
    const out = [];
    const seen = new Set();
    const excluded = new Set(parseExclude(getConfig().exclude));
    let visited = 0;
    function add(uri) {
      const key = keyOf(uri.fsPath);
      if (seen.has(key) || out.length >= 8) return;
      seen.add(key);
      out.push(uri);
    }
    function walk(dir, depth) {
      if (depth < 0 || out.length >= 8 || visited > 500) return;
      visited++;
      for (const name of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
        const p = path.join(dir, name);
        try {
          if (fs.existsSync(p)) { add(vscode.Uri.file(p)); return; }
        } catch (_) { /* ignore */ }
      }
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name.toLowerCase();
        if (name.startsWith('.') || excluded.has(name)) continue;
        walk(path.join(dir, entry.name), depth - 1);
      }
    }
    for (const root of getRoots() || []) {
      if (root) walk(path.resolve(root), 2);
    }
    return out;
  }

  // 项目重载是异步通知，只能以诊断变化后的静默窗口作为完成信号
  function waitForWorkspaceDiagnosticsQuiet(timeoutMs) {
    return new Promise((resolve) => {
      let quietTimer = null;
      let finished = false;
      const listener = vscode.languages.onDidChangeDiagnostics(() => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(true), cfgNumber('reloadQuietMs', DEFAULT_RELOAD_QUIET_MS, 100));
      });
      const hard = setTimeout(() => finish(false), Math.max(1000, timeoutMs));
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(hard);
        if (quietTimer) clearTimeout(quietTimer);
        listener.dispose();
        resolve(ok);
      }
    });
  }

  async function compileWorkspace() {
    const ok = await withTimeout(
      vscode.commands.executeCommand('java.workspace.compile', false),
      cfgNumber('buildTimeoutMs', DEFAULT_BUILD_TIMEOUT_MS, 5000),
      '增量构建',
    );
    if (ok === false) throw new Error('增量构建返回失败');
  }

  async function updateProjectConfiguration(waitMs) {
    const files = projectBuildFiles();
    if (!files.length) throw new Error('未找到 pom.xml / build.gradle，无法重载项目');
    const quiet = waitForWorkspaceDiagnosticsQuiet(waitMs);
    for (const uri of files) {
      await withTimeout(
        vscode.commands.executeCommand('java.projectConfiguration.update', uri),
        10000,
        '项目重载',
      );
    }
    const completed = await quiet;
    return { completed, files: files.map((f) => f.fsPath) };
  }

  function scheduleBuild(forceConfig) {
    if (forceConfig === true) pendingConfigRefresh = true;
    if (buildTimer) clearTimeout(buildTimer);
    // 空闲 2s 后再刷新，并限制两次刷新的最小间隔，避免连续保存引发构建风暴
    const since = stats.lastBuildAt ? Date.now() - stats.lastBuildAt.getTime() : Infinity;
    const wait = Math.max(
      cfgNumber('autoBuildIdleMs', DEFAULT_BUILD_IDLE_MS, 200),
      cfgNumber('autoBuildMinGapMs', DEFAULT_BUILD_MIN_GAP_MS, 0) - since,
    );
    buildTimer = setTimeout(() => {
      const useConfig = pendingConfigRefresh;
      pendingConfigRefresh = false;
      runBuild(useConfig);
    }, wait);
  }

  async function runBuild(forceConfig) {
    buildTimer = null;
    if (!projectDirty.size) return;
    if (building) {
      buildQueued = true;
      buildQueuedConfig = buildQueuedConfig || forceConfig === true;
      return;
    }
    building = true;
    const batch = [...projectDirty];
    clearProjectDirty();
    const useConfig = forceConfig === true
      || batch.length >= cfgNumber('autoConfigMinFiles', DEFAULT_AUTO_CONFIG_MIN_FILES, 1);
    setRefreshActivity(useConfig ? 'reloading' : 'building');
    try {
      if (useConfig) {
        const r = await updateProjectConfiguration(cfgNumber('reloadTimeoutMs', DEFAULT_RELOAD_TIMEOUT_MS, 1000));
        stats.lastBuildMode = 'config';
        stats.lastBuildError = r.completed ? null : '项目重载仍在进行（等待诊断静默超时）';
      } else {
        await compileWorkspace();
        stats.lastBuildMode = 'build';
        stats.lastBuildError = null;
      }
      stats.lastBuildAt = new Date();
      stats.lastModelRefreshAt = new Date();
    } catch (e) {
      stats.lastBuildAt = new Date();
      stats.lastBuildMode = useConfig ? 'config' : 'build';
      stats.lastBuildError = e.message;
      for (const f of batch) noteProjectDirty(f);
      log('项目刷新失败: ' + e.message);
    } finally {
      building = false;
      setRefreshActivity(null);
      onStatsChanged();
      if (buildQueued) {
        buildQueued = false;
        const cfg = buildQueuedConfig;
        buildQueuedConfig = false;
        scheduleBuild(cfg);
      } else if (projectDirty.size && getConfig().autoBuild) {
        scheduleBuild(projectDirty.size >= cfgNumber('autoConfigMinFiles', DEFAULT_AUTO_CONFIG_MIN_FILES, 1));
      }
    }
  }

  // 对外的显式刷新入口：build=增量编译，config=完整重载，auto=按变更规模选择
  async function refreshProject(mode, timeoutMs) {
    const requested = ['auto', 'build', 'config'].includes(mode) ? mode : 'auto';
    const defaultWait = cfgNumber('reloadTimeoutMs', DEFAULT_RELOAD_TIMEOUT_MS, 1000);
    const waitMs = Math.max(1000, Math.min(Number(timeoutMs) || defaultWait, MAX_REFRESH_WAIT_MS));
    const started = Date.now();
    const actions = [];
    let completed = true;
    let error = null;
    let used = (requested === 'config'
      || (requested === 'auto'
        && projectDirty.size >= cfgNumber('autoConfigMinFiles', DEFAULT_AUTO_CONFIG_MIN_FILES, 1))) ? 'config' : 'build';
    setRefreshActivity(used === 'config' ? 'reloading' : 'building');
    try {
      if (used === 'config') {
        const r = await updateProjectConfiguration(waitMs);
        completed = r.completed;
        actions.push('projectConfiguration.update', ...r.files);
      } else {
        await compileWorkspace();
        actions.push('workspace.compile');
      }
    } catch (e) {
      error = e.message;
      // 增量编译失败时升级为完整重载
      if (used === 'build') {
        try {
          setRefreshActivity('reloading');
          const r = await updateProjectConfiguration(waitMs);
          used = 'config';
          completed = r.completed;
          actions.push('projectConfiguration.update', ...r.files);
          error = null;
        } catch (e2) {
          error = e.message + '；升级重载失败：' + e2.message;
        }
      }
    }
    setRefreshActivity(null);
    if (!error) {
      clearProjectDirty();
      stats.lastBuildAt = new Date();
      stats.lastBuildMode = used;
      stats.lastBuildError = completed ? null : '项目重载仍在进行（等待诊断静默超时）';
      stats.lastModelRefreshAt = new Date();
    } else {
      stats.lastBuildError = error;
    }
    onStatsChanged();
    return {
      ok: !error,
      requested,
      mode: used,
      actions,
      completed,
      timedOut: !completed,
      durationMs: Date.now() - started,
      error,
      projectDirty: projectState(),
      lastModelRefreshAt: stats.lastModelRefreshAt ? stats.lastModelRefreshAt.toISOString() : null,
    };
  }

  function refreshWatcher() {
    if (watcher) {
      watcher.dispose();
      watcher = null;
    }
    if (disposed || !getConfig().enabled) return;
    watcher = vscode.workspace.createFileSystemWatcher('**/*.java');
    watcher.onDidChange((uri) => schedule(uri, 'change'));
    watcher.onDidCreate((uri) => schedule(uri, 'create'));
    watcher.onDidDelete((uri) => schedule(uri, 'delete'));
  }

  function describe() {
    const cfg = getConfig();
    const project = projectState();
    return {
      enabled: cfg.enabled,
      autoBuild: cfg.autoBuild,
      activity: currentActivity(),
      checks: stats.checks,
      reloadedCount: stats.reloadedCount,
      dirtyConflicts: stats.dirtyConflicts,
      noopChecks: stats.noopChecks,
      circuitBroken: stats.circuitBroken,
      lastSyncAt: stats.lastSyncAt ? stats.lastSyncAt.toISOString() : null,
      lastSyncFile: stats.lastSyncFile,
      lastBuildAt: stats.lastBuildAt ? stats.lastBuildAt.toISOString() : null,
      lastBuildMode: stats.lastBuildMode,
      lastBuildError: stats.lastBuildError,
      lastModelRefreshAt: stats.lastModelRefreshAt ? stats.lastModelRefreshAt.toISOString() : null,
      openDocuments: registry.size,
      pendingEvents: pending.size,
      projectDirty: project,
    };
  }

  function dispose() {
    disposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (buildTimer) clearTimeout(buildTimer);
    debounceTimer = null;
    buildTimer = null;
    if (watcher) watcher.dispose();
    watcher = null;
    pending.clear();
    inflight.clear();
    syncingCount = 0;
    refreshActivity = null;
  }

  return { syncIfNeeded, projectState, refreshProject, refreshWatcher, describe, dispose };
}

module.exports = { createSyncEngine, normalizeText };