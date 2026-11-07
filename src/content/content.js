/**
 * 胶水层：storage、MutationObserver、隐藏、按钮注入、撤销、统计上报。
 * 规则判定全在 rules.js，站点归一在 sites.js，这里只负责「做事」。
 */
(function () {
  'use strict';

  // 同一份脚本在同一页重复注入时只跑一遍（弹窗的补注入会走到这里）。
  // 扩展重载后旧标签页里的脚本虽然还在（chrome.* 已失效），但重新注入落的是新的隔离世界，
  // 这个标记不在里面，所以补注入能正常接管 —— 实测过，不需要额外的活体检查。
  if (window.__bclInjected) return;
  window.__bclInjected = true;

  var sites = globalThis.BCLSites;
  var rules = globalThis.BCLRules;
  if (!sites || !rules) return;

  var DEFAULTS = {
    blocklist: [],
    settings: {
      hideAds: true,      // 去掉广告
      hideRailAds: true,  // 去掉右侧栏广告
      showBlockBtn: true, // 结果显示「屏蔽此站」按钮
      showToast: true     // 操作后弹回执
    }
  };

  var state = {
    blocklist: [],
    settings: Object.assign({}, DEFAULTS.settings)
  };

  // 本页统计：用 WeakSet 保证同一个节点只计一次
  var seenAd = new WeakSet();
  var seenBlocked = new WeakSet();
  var stats = { ads: 0, blocked: 0 };
  var lastDiag = [];
  var hostIndex = new Map(); // 站点键 -> 命中条数（给按钮做「会一起屏蔽」提示）

  var scanTimer = null;
  var observer = null;
  var booted = false;

  /* ------------------------------------------------------------------ storage */

  function loadSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(DEFAULTS, function (v) {
          if (chrome.runtime.lastError) {
            chrome.storage.local.get(DEFAULTS, function (v2) {
              resolve(v2 || DEFAULTS);
            });
            return;
          }
          resolve(v || DEFAULTS);
        });
      } catch (e) {
        resolve(DEFAULTS);
      }
    });
  }

  function saveBlocklist(list) {
    state.blocklist = list.slice();
    try {
      chrome.storage.sync.set({ blocklist: state.blocklist });
    } catch (e) { /* 隐私模式下可能失败，内存态仍然生效 */ }
  }

  function applySettingsToDocument() {
    var el = document.documentElement;
    if (!el) return;
    if (state.settings.hideAds) el.removeAttribute('data-bcl-no-ads');
    else el.setAttribute('data-bcl-no-ads', '');
  }

  /* --------------------------------------------------------------- 扫描与隐藏 */

  function hide(el, kind, key) {
    if (!el || el.nodeType !== 1) return;
    var set = kind === 'ad' ? seenAd : seenBlocked;
    if (set.has(el)) return;
    set.add(el);
    el.setAttribute(kind === 'ad' ? 'data-bcl-ad' : 'data-bcl-hidden', key || '1');
    if (kind === 'ad') stats.ads++;
    else stats.blocked++;
  }

  function isRail(el) {
    return !!(el.closest && el.closest('#b_context, aside, #b_right'));
  }

  /** 广告组被整组拿掉后，把空容器收起，避免页面上留一道空白 */
  function collapseEmptyGroups() {
    var groups = document.querySelectorAll('#b_topw, ol.b_results_eml');
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var visible = false;
      for (var j = 0; j < g.children.length; j++) {
        var c = g.children[j];
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE') continue;
        if (!c.hasAttribute('data-bcl-ad') && !c.hasAttribute('data-bcl-hidden')) { visible = true; break; }
      }
      if (visible) g.removeAttribute('data-bcl-empty');
      else g.setAttribute('data-bcl-empty', '1');
    }
  }

  function ensureRelative(li) {
    try {
      if (getComputedStyle(li).position === 'static') li.style.position = 'relative';
    } catch (e) { /* noop */ }
  }

  function makeBlockButton(host) {
    var key = sites.siteKey(host) || host;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bcl-block';
    btn.dataset.bclKey = key;
    btn.title = '屏蔽 ' + key + '（含它的所有子域名），并记住这个选择';
    btn.innerHTML = '<span class="bcl-block-ico" aria-hidden="true">🚫</span><span>屏蔽 ' + escapeHtml(key) + '</span>';
    return btn;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function syncButtonRepeat(li, host) {
    var btn = li.querySelector(':scope > .bcl-block');
    if (!btn) return;
    var key = btn.dataset.bclKey;
    var n = hostIndex.get(key) || 0;
    if (n > 1) btn.setAttribute('data-bcl-repeat', '1');
    else btn.removeAttribute('data-bcl-repeat');
  }

  function scan() {
    if (!document.body) return;
    var plan = rules.planScan(document);

    // 1) 广告
    if (state.settings.hideAds) {
      plan.ads.forEach(function (item) {
        if (!state.settings.hideRailAds && isRail(item.el)) return;
        hide(item.el, 'ad', item.reason);
      });
    }

    // 2) 结果卡片：黑名单优先，其次挂按钮
    hostIndex.clear();
    var cards = plan.results;
    for (var i = 0; i < cards.length; i++) {
      var host = cards[i].host;
      var key = sites.siteKey(host) || host;
      hostIndex.set(key, (hostIndex.get(key) || 0) + 1);
    }

    for (var j = 0; j < cards.length; j++) {
      var li = cards[j].el;
      var entry = sites.findBlocked(cards[j].host, state.blocklist);
      if (entry) {
        hide(li, 'block', entry);
        continue;
      }
      if (!state.settings.showBlockBtn) continue;
      if (!li.classList.contains('bcl-li')) {
        li.classList.add('bcl-li');
        ensureRelative(li);
      }
      if (!li.querySelector(':scope > .bcl-block')) {
        li.appendChild(makeBlockButton(cards[j].host));
      }
      syncButtonRepeat(li, cards[j].host);
    }

    if (!booted) {
      booted = true;
      document.documentElement.setAttribute('data-bcl-ready', '1');
    }
    collapseEmptyGroups();
    report();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      try { scan(); } catch (e) { console.warn('[bing-clean] 扫描失败', e); }
    }, 40);
  }

  /**
   * 扫描完就广播一份完整统计。
   * 除给 service worker 算角标，弹窗也靠它实时刷新（不再靠「打开弹窗时问一次」）。
   */
  function report() {
    try {
      var payload = buildStats();
      payload.type = 'bcl:count';
      chrome.runtime.sendMessage(payload);
    } catch (e) { /* service worker 未醒或已失效，忽略 */ }
  }

  /* ------------------------------------------------------------------- 交互 */

  function addBlock(key) {
    if (!key) return;
    var list = state.blocklist.slice();
    if (list.indexOf(key) === -1) list.push(key);
    saveBlocklist(list);
    rescanBlocked();
  }

  function removeBlock(key) {
    saveBlocklist(state.blocklist.filter(function (k) { return k !== key; }));
    rescanBlocked();
  }

  /** 黑名单变化后把误隐藏的恢复、该隐藏的藏掉 */
  function rescanBlocked() {
    var nodes = document.querySelectorAll('[data-bcl-hidden]');
    for (var i = 0; i < nodes.length; i++) {
      var li = nodes[i];
      var host = li.querySelector('cite') ? sites.normalizeHost(li.querySelector('cite').textContent) : null;
      if (!host) {
        var a = li.querySelector('h2 a[href]');
        if (a) { try { host = sites.normalizeHost(new URL(a.getAttribute('href')).hostname); } catch (e) { host = null; } }
      }
      var entry = host ? sites.findBlocked(host, state.blocklist) : null;
      if (!entry) {
        li.removeAttribute('data-bcl-hidden');
        seenBlocked.delete(li);
        stats.blocked = Math.max(0, stats.blocked - 1);
      } else if (entry !== li.getAttribute('data-bcl-hidden')) {
        li.setAttribute('data-bcl-hidden', entry);
      }
    }
    scheduleScan();
  }

  function showToast(text, actionLabel, onAction, ms) {
    if (!document.body) return;
    var old = document.querySelector('.bcl-toast');
    if (old) old.remove();

    var box = document.createElement('div');
    box.className = 'bcl-toast';
    box.setAttribute('role', 'status');

    var msg = document.createElement('span');
    msg.className = 'bcl-toast-text';
    msg.textContent = text;
    box.appendChild(msg);

    if (actionLabel) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bcl-toast-btn';
      btn.textContent = actionLabel;
      btn.addEventListener('click', function () {
        box.remove();
        onAction();
      });
      box.appendChild(btn);
    }

    document.body.appendChild(box);
    setTimeout(function () { if (box.isConnected) box.remove(); }, ms || 6500);
  }

  // 用捕获阶段接点击，抢在 Bing 自己的委托处理前面
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.bcl-block') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var key = btn.dataset.bclKey;
    addBlock(key);
    if (state.settings.showToast) {
      showToast('已屏蔽 ' + key + '（含子域名）', '撤销', function () {
        removeBlock(key);
        showToast('已恢复显示 ' + key);
      });
    }
  }, true);

  /* ------------------------------------------------------------------- 观察 */

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        // 自己注入按钮引起的改动不必重扫
        if (mutations[i].target && mutations[i].target.classList &&
            mutations[i].target.classList.contains('bcl-li')) continue;
        scheduleScan();
        return;
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /**
   * 定时补扫：Bing 的广告位很多是“先占位骨架、再异步填内容”，
   * 也可能在按钮注入引发的那一轮 mutation 里静默插入，光靠 observer 会漏。
   * 只补前 8 秒，成本可控。
   */
  function startSweeps() {
    var n = 0;
    var timer = setInterval(function () {
      scheduleScan();
      if (++n >= 8) clearInterval(timer);
    }, 1000);

    // bfcache 恢复 / 前进后退时重扫一遍（这些路径不会重跑 content script）
    window.addEventListener('pageshow', scheduleScan);
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleScan();
    });
  }

  /* ------------------------------------------------------------------- 消息 */

  function buildStats() {
    var hosts = [];
    hostIndex.forEach(function (n, key) { hosts.push({ key: key, count: n }); });
    hosts.sort(function (a, b) { return b.count - a.count; });
    return {
      ads: stats.ads,
      blocked: stats.blocked,
      results: document.querySelectorAll('#b_results > li.bcl-li').length,
      hosts: hosts,
      blocklist: state.blocklist.slice(),
      settings: state.settings
    };
  }

  function buildDiag() {
    var plan = rules.planScan(document);
    var describe = function (el) {
      if (!el || !el.tagName) return '';
      var cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).join('.');
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
    };
    var snippet = function (el, n) {
      // 必须用 rules.readableText：Bing 把样式表写在结果 li 里，textContent 会以 CSS 开头
      return rules.readableText(el).replace(/\s+/g, ' ').trim().slice(0, n || 90);
    };

    /**
     * 导出结构快照：把噪声（style/script/svg/img/base64）剥掉后的 outerHTML。
     * 用户反馈「还有广告」时，就靠这个字段直接看真实标记，不用再猜。
     */
    var stripHtml = function (el, max) {
      var clone;
      try { clone = el.cloneNode(true); } catch (e) { return ''; }
      var junk = clone.querySelectorAll('style,script,noscript,svg,img,iframe,video,source,link,meta,br');
      for (var i = junk.length - 1; i >= 0; i--) {
        if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
      }
      var nodes = clone.querySelectorAll('[style]');
      for (var j = 0; j < nodes.length; j++) nodes[j].removeAttribute('style');
      return clone.outerHTML
        .replace(/data:[a-z+\/-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:…')
        .replace(/\s+/g, ' ')
        .slice(0, max || 1600);
    };

    /** 卡片里是否有 shadow root —— 真有的话标签可能藏在里层，现成的 querySelector 拿不到 */
    var shadowInfo = function (el) {
      var all = el.querySelectorAll('*');
      var hosts = [];
      for (var i = 0; i < all.length && hosts.length < 3; i++) {
        if (all[i].shadowRoot) {
          hosts.push(all[i].tagName.toLowerCase() +
            (all[i].className && typeof all[i].className === 'string'
              ? '.' + all[i].className.trim().split(/\s+/).slice(0, 3).join('.') : ''));
        }
      }
      return hosts;
    };

    // 没被判为广告的结果卡片：广告漏判一律从里查（用户反馈滤不掉时靠它定位）
    // 先收结果列表里的候选，再收侧栏，避免报告被「相关搜索」的 li 挤满。
    var unmatched = [];
    var seenLi = new Set();
    var groups = [
      '#b_results > li, #b_topw > li',
      '#b_content ol > li, #b_context > li, #b_context li, aside li'
    ];
    for (var g = 0; g < groups.length; g++) {
      var lis = document.querySelectorAll(groups[g]);
      for (var i = 0; i < lis.length && unmatched.length < 16; i++) {
        var li = lis[i];
        if (seenLi.has(li)) continue;
        seenLi.add(li);
        if (li.hasAttribute('data-bcl-ad')) continue;
        if (li.hasAttribute('data-bcl-hidden')) continue;
        var item = {
          tag: li.tagName.toLowerCase(),
          cls: li.getAttribute('class') || '',
          text: snippet(li)
        };

        // 广告模板可能把「广告」渲染成伪元素/背景图，DOM 里根本没有这两个字，
        // 所以这里对每张卡片都附结构快照，而不是只对含广告词的卡片附。
        item.attrs = [].map.call(li.attributes, function (a) { return a.name; }).slice(0, 12);
        item.links = [].map.call(li.querySelectorAll('a[href]'), function (a) {
          var h = a.getAttribute('href') || '';
          return h.slice(0, 70);
        }).slice(0, 8);
        var aria = li.querySelector('h2 a[aria-label], .tilk[aria-label]');
        if (aria) item.aria = aria.getAttribute('aria-label');
        var shadow = shadowInfo(li);
        if (shadow.length) item.shadow = shadow;
        item.html = stripHtml(li, 1600);

        unmatched.push(item);
      }
    }

    // 页面骨架概况：确认结果列表到底在哪
    var structure = {
      hasBResults: !!document.getElementById('b_results'),
      hasBTopw: !!document.getElementById('b_topw'),
      olCount: document.querySelectorAll('#b_content ol').length,
      olIds: [].map.call(document.querySelectorAll('#b_content ol'), function (o) {
        return (o.id || '(no-id)') + ':' + o.children.length;
      }).slice(0, 12),
      styleBlocks: document.querySelectorAll('#b_results li style, #b_topw li style').length,
      mainChildren: document.querySelector('#b_content > main')
        ? [].map.call(document.querySelector('#b_content > main').children, function (c) { return describe(c); }).slice(0, 12)
        : []
    };

    return {
      url: location.href,
      version: (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ''),
      structure: structure,
      ads: plan.ads.map(function (a) {
        return { selector: describe(a.el), reason: a.reason, text: snippet(a.el, 80) };
      }),
      unmatched: unmatched,
      results: plan.results.map(function (r) { return { selector: describe(r.el), host: r.host, key: sites.siteKey(r.host) }; })
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'bcl:stats') {
      // 先同步扫一遍，保证弹窗拿到的数字是当下的
      try { scan(); } catch (e) { /* 页面结构异常时忽略 */ }
      sendResponse(buildStats());
      return true;
    }
    if (msg.type === 'bcl:diag') {
      try {
        sendResponse(buildDiag());
      } catch (e) {
        sendResponse({ error: String(e && e.message || e), url: location.href });
      }
      return true;
    }
    if (msg.type === 'bcl:rescan') {
      applySettingsToDocument();
      rescanBlocked();
      sendResponse({ ok: true });
      return true;
    }
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync' && area !== 'local') return;
    if (changes.blocklist) {
      state.blocklist = changes.blocklist.newValue || [];
      rescanBlocked();
    }
    if (changes.settings) {
      state.settings = Object.assign({}, DEFAULTS.settings, changes.settings.newValue || {});
      applySettingsToDocument();
      scheduleScan();
    }
  });

  /* ------------------------------------------------------------------- 启动 */

  loadSettings().then(function (v) {
    state.blocklist = Array.isArray(v.blocklist) ? v.blocklist : [];
    state.settings = Object.assign({}, DEFAULTS.settings, v.settings || {});
    applySettingsToDocument();
    startObserver();
    startSweeps();
    scheduleScan();
    // Bing 会把首屏结果分几批塞进来，补两次扫描兜住慢加载
    setTimeout(scheduleScan, 400);
    setTimeout(scheduleScan, 1500);
  });
})();
