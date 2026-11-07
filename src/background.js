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

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(DEFAULTS);
  // 补齐缺失项，不覆盖用户已有的黑名单
  const next = {
    blocklist: Array.isArray(cur.blocklist) ? cur.blocklist : DEFAULTS.blocklist,
    settings: { ...DEFAULTS.settings, ...(cur.settings && typeof cur.settings === 'object' ? cur.settings : {}) }
  };
  await chrome.storage.sync.set(next);

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
