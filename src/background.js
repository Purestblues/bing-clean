/**
 * Service worker：只干三件事 —— 写默认配置、给工具栏图标挂角标、转发统计。
 * 不碰页面 DOM，不加载远程代码。
 */
'use strict';

const DEFAULTS = {
  blocklist: [],
  settings: {
    hideAds: true,
    hideRailAds: true,
    showBlockBtn: true,
    showToast: true
  }
};

/**
 * 只补缺失的键，绝不覆盖用户已有数据。
 *
 * 这里必须用 get(null)：传一个带默认值的对象时，「没存过」与「读失败」会得到同样的
 * 结果，而后面又要拿着这个结果写回 storage —— 那就成了「把默认值盖在用户数据上」。
 * 同样地，缺什么补什么，不要无脑 set 整个对象。
 */
chrome.runtime.onInstalled.addListener(async () => {
  let cur = {};
  try {
    cur = (await chrome.storage.sync.get(null)) || {};
  } catch {
    cur = {};
  }

  const next = {};
  if (!Array.isArray(cur.blocklist)) next.blocklist = [];
  if (!cur.settings || typeof cur.settings !== 'object') {
    next.settings = { ...DEFAULTS.settings };
  } else {
    // 旧版本可能少几个开关：只在真缺键时补写，键齐全就不动用户的选择
    const missing = Object.keys(DEFAULTS.settings).some((k) => !(k in cur.settings));
    if (missing) next.settings = { ...DEFAULTS.settings, ...cur.settings };
  }

  if (Object.keys(next).length) {
    try {
      await chrome.storage.sync.set(next);
    } catch { /* 隐私模式或 sync 不可用时忽略，content script 自己会用默认值兜底 */ }
  }

  chrome.action.setBadgeBackgroundColor({ color: '#c62828' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'bcl:count') return;

  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') return;

  const n = (msg.ads || 0) + (msg.blocked || 0);
  chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n) : '' }).catch(() => {});
  sendResponse({ ok: true });
  return false;
});

// 换页时先把角标清掉，别让上一页的数字挂在新页面上
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});
