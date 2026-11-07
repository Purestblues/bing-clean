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

async function askPage(type) {
  const tab = await activeTab();
  if (!tab || !tab.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 渲染 */
function renderStats(page) {
  $('statAds').textContent = page ? page.ads : '–';
  $('statBlocked').textContent = page ? page.blocked : '–';
  $('statResults').textContent = page ? page.results : '–';
}

function renderList(page) {
  const hits = new Map();
  if (page && Array.isArray(page.hosts)) {
    for (const h of page.hosts) hits.set(h.key, h.count);
  }

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
    const tab = await activeTab();
    if (!isBingSearch(tab && tab.url)) {
      flash('请先打开一个 Bing 搜索结果页');
      return;
    }
    const diag = await askPage('bcl:diag');
    if (!diag) {
      flash('页面没响应，刷新一下再试');
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

/* ---------------------------------------------------------------- 启动 */

(async function main() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  await load();
  renderSwitches();
  wireSwitches();
  wireAddForm();
  await wireDiag();

  const tab = await activeTab();
  const page = isBingSearch(tab && tab.url) ? await askPage('bcl:stats') : null;
  $('hint').hidden = !!page;
  renderStats(page);
  renderList(page);
})();
