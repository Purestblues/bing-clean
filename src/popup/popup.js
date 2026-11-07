/**
 * 弹窗：开关、本页统计、黑名单增删、诊断导出。
 * 唯一的真源是 chrome.storage.sync；页面里的 content script 靠 onChanged 跟随，
 * 所以这里改完不用再单独通知页面（除了开关需要立刻重扫一次）。
 */
'use strict';

const DEFAULTS = {
  blocklist: [],
  settings: { hideAds: true, hideRailAds: true, showBlockBtn: true, showToast: true }
};

const OPTIONS = ['hideAds', 'hideRailAds', 'showBlockBtn', 'showToast'];

const $ = (id) => document.getElementById(id);

let state = {
  blocklist: [],
  settings: { ...DEFAULTS.settings }
};

/* ---------------------------------------------------------------- 存储 */

async function load() {
  const v = await chrome.storage.sync.get(DEFAULTS);
  state.blocklist = Array.isArray(v.blocklist) ? v.blocklist : [];
  state.settings = { ...DEFAULTS.settings, ...(v.settings || {}) };
}

async function persistBlocklist() {
  await chrome.storage.sync.set({ blocklist: state.blocklist });
}

async function persistSettings() {
  await chrome.storage.sync.set({ settings: state.settings });
}

/* ------------------------------------------------------------ 当前标签页 */

/**
 * 注意：不要用 tab.url 判断「是不是 Bing 搜索页」。
 * 弹窗里的 chrome.tabs.query 返回的 tab 可能干脆没有 url 字段（没 host 权限、
 * 或者弹窗不是用户点击打开的——实测程序化 chrome.action.openPopup() 就是这种），
 * 旧版因此把每一页都判成「不是 Bing 页」，统计永远显示 –。
 * 正确做法是先直接问内容脚本：能回话就说明是 Bing 页且脚本在跑。
 */
let tabId = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isBingSearch(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /(^|\.)bing\.com$/i.test(u.hostname) && u.pathname.startsWith('/search');
  } catch {
    return false;
  }
}

/** 发消息给页面。内容脚本不存在时 lastError 会抛，这里统一收成 null。 */
function askTab(id, type) {
  return new Promise((resolve) => {
    if (typeof id !== 'number') { resolve(null); return; }
    try {
      chrome.tabs.sendMessage(id, { type }, (res) => {
        void chrome.runtime.lastError; // 读一次，消掉控制台里的未处理错误
        resolve(res || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** tab.url 拿不到时，退而用 scripting 读一次 location.href（Bing 页一定有 host 权限） */
async function probeUrl(id) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => location.href });
    return (res && res.result) || null;
  } catch {
    return null;
  }
}

/** 扩展被重载后旧标签页里的内容脚本会失效，这里把三个文件补注入一遍 */
async function reinject(id) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      files: ['src/content/sites.js', 'src/content/rules.js', 'src/content/content.js']
    });
    return true;
  } catch {
    return false;
  }
}

const HINTS = {
  'not-bing': '当前标签页不是 Bing 搜索结果页，统计不可用。',
  'no-script': '本页的屏蔽脚本没跑起来，刷新一下页面（F5）就能看到统计。'
};

/**
 * 定位「可统计的那一页」。顺序很重要：先问页面，再判 URL，最后补注入。
 * @returns {Promise<{page: object|null, why?: string}>}
 */
async function resolvePage() {
  const tab = await activeTab();
  const id = tab && tab.id;
  if (typeof id !== 'number') return { page: null, why: 'not-bing' };

  const first = await askTab(id, 'bcl:stats');
  if (first) {
    tabId = id;
    return { page: first };
  }

  const url = (tab && tab.url) || (await probeUrl(id));
  if (!isBingSearch(url)) return { page: null, why: 'not-bing' };

  // 是 Bing 搜索页但脚本没响应：补注入后再问一次
  if (await reinject(id)) {
    const again = await askTab(id, 'bcl:stats');
    if (again) {
      tabId = id;
      return { page: again };
    }
  }
  return { page: null, why: 'no-script' };
}

/** 对已经确认过的那一页发消息；tabId 丢了就重新解析一次 */
async function askPage(type) {
  const res = await askTab(tabId, type);
  if (res) return res;
  const again = await resolvePage();
  return again.page ? askTab(tabId, type) : null;
}

/* ---------------------------------------------------------------- 渲染 */
function renderStats(page) {
  $('statAds').textContent = page ? page.ads : '\u2013';
  $('statBlocked').textContent = page ? page.blocked : '\u2013';
  $('statResults').textContent = page ? page.results : '\u2013';
}

function renderList(page) {
  const hits = new Map();
  if (page && Array.isArray(page.hosts)) {
    for (const h of page.hosts) hits.set(h.key, h.count);
  }

  // 实时推送会反复调用这里，签名没变就别重建 DOM（重建会打断正在点的 ×）
  const sig = state.blocklist.join('|') + '#' +
    [...hits.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e.join(':')).join(',');
  if (sig === renderList._sig) return;
  renderList._sig = sig;

  const list = $('list');
  list.textContent = '';
  $('empty').hidden = state.blocklist.length > 0;
  $('blCount').textContent = state.blocklist.length ? `${state.blocklist.length} 个站点` : '';

  for (const domain of state.blocklist) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'domain';
    name.textContent = domain;
    name.title = domain;
    li.appendChild(name);

    const n = hits.get(domain);
    if (n) {
      const badge = document.createElement('span');
      badge.className = 'hit';
      badge.textContent = `本页 ${n} 条`;
      li.appendChild(badge);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = `不再屏蔽 ${domain}`;
    del.textContent = '×';
    del.addEventListener('click', async () => {
      state.blocklist = state.blocklist.filter((d) => d !== domain);
      await persistBlocklist();
      renderList(await askPage('bcl:stats'));
      flash(`已取消屏蔽 ${domain}`);
    });
    li.appendChild(del);

    list.appendChild(li);
  }
}

function renderSwitches() {
  for (const key of OPTIONS) {
    $(`opt-${key}`).checked = !!state.settings[key];
  }
}

function flash(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { box.hidden = true; }, 1800);
}

/* ---------------------------------------------------------------- 交互 */

function wireSwitches() {
  for (const key of OPTIONS) {
    $(`opt-${key}`).addEventListener('change', async (e) => {
      state.settings[key] = e.target.checked;
      await persistSettings();
      // 关掉「去广告」要让已隐藏的广告重新出现，所以立刻让页面重扫
      await askPage('bcl:rescan');
      renderStats(await askPage('bcl:stats'));
    });
  }
}

function wireAddForm() {
  const form = $('addForm');
  const input = $('addInput');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;

    // 与 content script 共用同一套归一逻辑（sites.js 是纯函数，直接复用它）
    const key = normalizeEntry(raw);
    if (!key) {
      flash('这个地址看起来不像域名');
      return;
    }
    if (state.blocklist.includes(key)) {
      flash(`${key} 已经在名单里了`);
      input.value = '';
      return;
    }
    state.blocklist.push(key);
    await persistBlocklist();
    input.value = '';
    renderList(await askPage('bcl:stats'));
    flash(`已屏蔽 ${key}`);
  });
}

/**
 * 归一提交的域名。直接复用 content/sites.js 的同一份实现（popup.html 已引入），
 * 不在这里另写一份，避免两边规则跑偏。
 */
function normalizeEntry(raw) {
  return globalThis.BCLSites.entryFromUserInput(raw);
}

async function wireDiag() {
  $('diagBtn').addEventListener('click', async () => {
    const diag = await askPage('bcl:diag');
    if (!diag) {
      flash('本页没响应，刷新一下页面再试');
      return;
    }
    const text = JSON.stringify(diag, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      flash('诊断 JSON 已复制，可以直接贴给我');
    } catch {
      // 剪贴板被拒（弹窗失焦）时退化成控制台输出
      console.log('[bing-clean] diag', text);
      flash('剪贴板不可用，已打到控制台');
    }
  });
}

/* ------------------------------------------------------ 实时统计（推送） */

/**
 * 内容脚本每次扫描完都会 broadcast 一份 bcl:count（内容脚本 → 所有扩展上下文），
 * 弹窗只要收下来就地重绘就行 —— 不再需要「打开时问一次」那种快照式统计。
 * 只认当前这一页发来的消息，别的标签页的数字不串台。
 */
function wireLiveStats() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'bcl:count') return;
    const from = sender && sender.tab && sender.tab.id;
    if (typeof tabId !== 'number' || from !== tabId) return;
    $('hint').hidden = true;
    renderStats(msg);
    renderList(msg);
  });
}

/* ---------------------------------------------------------------- 启动 */

(async function main() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  await load();
  renderSwitches();
  wireSwitches();
  wireAddForm();
  wireLiveStats();
  wireDiag();

  // 名单是本地状态，先把它们画出来；统计要等页面应答，不能拖着名单一起转圈
  renderList(null);

  const { page, why } = await resolvePage();
  const hint = $('hint');
  hint.hidden = !!page;
  if (!page) hint.textContent = HINTS[why] || HINTS['not-bing'];
  renderStats(page);
  renderList(page);
})();
