/**
 * Bing SERP 结构解析：哪些元素是广告，哪些元素是自然结果、属于哪个站点。
 *
 * 纯 DOM 逻辑，不碰 chrome.*，不写全局状态 —— 这样单测可以把本文件原样 eval 进
 * jsdom，测的就是上线那份代码。
 *
 * 选择器来源见 AGENTS.md「广告判定的信息来源」，全部在真实 cn.bing.com SERP 上核对过。
 */
(function (root) {
  'use strict';

  // Bing 广告专有 class。这些 token 在自然结果里从不出现（已用真实 SERP 全量比对）。
  // b_ads1line / ad_vsl / ad_vslWiderClk 是广告卡里「站内链接」那一排的 class ——
  // 曾经因为它们长得「泛」而被剔掉，结果整类广告漏判（真实案例：豆包工作版），现已加回。
  var AD_TOKENS = [
    'b_ad', 'b_ads', 'b_adTop', 'b_adBottom', 'b_adLastChild',
    'b_adProvider', 'b_adlabel', 'b_adTA', 'sb_adTA',
    'b_topTitleAd', 'b_ad_description', 'b_adscv', 'b_adTopIcon',
    'b_ads1line', 'ad_vsl', 'ad_vslWiderClk'
  ];
  var AD_TOKEN_SELECTOR = AD_TOKENS.map(function (t) { return '.' + t; }).join(',');

  // 广告落地页的投放参数。真实案例（同一个搜索页里的三条广告）：
  //   千问   …&a_keywordid=82465521268012&a_creative=82463816280795&from=bingsem
  //   WorkBuddy ?fromSource=gwzcw.24102531...   （gwzcw 是百度SEM的点击前缀）
  //   豆包   …;channel=bing_sem
  // 自然结果的 URL 不带这些投放参数。
  var AD_HREF_RE = /(aclick|aclk|e\.so\.com\/search\/eclk|msclkid|bingsem|bing_sem|gwzcw|a_keywordid|a_creative|a_matchtype)/i;

  /**
   * 按文档顺序拼接元素的可读文本，跳过 style/script。
   * 必须跳过：Bing 把样式表直接写在每个结果 li 里，textContent 开头是一大段 CSS，
   * 不剥掉的话所有「文字是否以广告开头」的判断全部失效（实测流过）。
   */
  function readableText(el) {
    if (!el) return '';
    var out = '';
    var stack = [];
    for (var c = el.lastChild; c; c = c.previousSibling) stack.push(c);
    while (stack.length) {
      var node = stack.pop();
      if (node.nodeType === 3) { out += node.nodeValue; continue; }
      if (node.nodeType !== 1) continue;
      var tag = node.tagName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
      for (var k = node.lastChild; k; k = k.previousSibling) stack.push(k);
    }
    return out;
  }

  // 爬到这些元素就停 —— 它们上面一层就是「结果列表 / 侧栏」本身。
  var BOUNDARY = '#b_results, #b_context, #b_right, #b_content, #b_header, main, body';

  // 标题 / 地址区里的「广告」不可能是广告标签，直接排除
  var HARD_BLOCKLIST = '.b_algoSlug, cite, h1, h2, h3';

  // 摘要区：这里的「广告」默认不算（正文提到这两个字是常事），
  // 只有当它顶在整段文字最前面、且后面还有正经正文时，才认为是广告标签。
  var TEXT_ZONE = '.b_caption, p, .b_lineclamp1, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_snippet';

  var LABEL_RE = /^(广告|廣告|ad|ads|sponsored)$/i;

  // 纯文本形式的广告前缀。用前瞻而不是「吃掉空白再要求分隔符」——
  // 那样「广告 通过 Amazon…」会因为空格被 \s* 吃掉而永远匹配不上。
  // 仍然要求后面紧跟空白或分隔符，避开「广告投放指南」这种正文开头；
  // 裸的 Ad 故意不收：英文摘要开头以 “Ad blockers…” 很正常。
  var AD_TEXT_PREFIX = /^(广告|廣告|sponsoris[ée]|sponsored)(?=[\s\u00a0·|｜:：\-–—])/i;

  /** container 的文字是不是以这个标签开头，且后面还有正式正文 */
  function startsWithLabel(container, el) {
    if (!container) return false;
    var text = readableText(container).replace(/^[\s\u00a0]+/, '');
    var label = (el.textContent || '').trim();
    if (!label || text.indexOf(label) !== 0) return false;
    // 标签后面至少还要有 10 个字，否则可能整段就写着「广告」两个字
    var rest = text.slice(label.length).replace(/^[\s\u00a0·|｜:：\-–—]+/, '');
    return rest.length >= 10;
  }

  /** 标签是否顶在所在摘要段的最前面 */
  function isLeadingLabel(el) {
    var zone = el.closest(TEXT_ZONE);
    if (!zone) return true; // 不在摘要区，头部行里的标签，直接算
    return startsWithLabel(zone, el) || startsWithLabel(el.parentElement, el);
  }

  /** 该元素是不是一个「广告」文字标签（叶子节点 + 文本恰好是广告词） */
  function isAdLabel(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.children && el.children.length) return false;
    var t = (el.textContent || '').replace(/[\s\u00a0|｜]+/g, '');
    if (!t || t.length > 8) return false;
    if (!LABEL_RE.test(t)) return false;
    if (el.closest(HARD_BLOCKLIST)) return false;
    return isLeadingLabel(el);
  }

  function hasAdLabel(container) {
    var nodes = container.querySelectorAll('span,div,a,em,i,b,strong,font');
    for (var i = 0; i < nodes.length; i++) {
      if (isAdLabel(nodes[i])) return true;
    }
    return false;
  }

  /**
   * 摘要段落以「广告 」开头 —— 广告标签没被包成独立元素（或被包在纯文本节点里）时的
   * 兜底判据。要求后面紧跟分隔符，避开正文以「广告」两字开头的自然结果。
   */
  function findAdCaptionPrefix(card) {
    var zones = card.querySelectorAll(TEXT_ZONE);
    for (var i = 0; i < zones.length; i++) {
      var t = readableText(zones[i]).replace(/^[\s\u00a0]+/, '');
      if (AD_TEXT_PREFIX.test(t)) return zones[i];
    }
    return null;
  }

  /** 卡片自己的标题链接是不是广告跳转（唯一的链接类判据） */
  /**
   * 卡片自己的「结果链接」是不是广告投放链接。
   * 只看标题链和站点名链（.tilk），不扫全卡 —— Bing 会在自然结果里塞隐藏跳转锚点，
   * 全卡扫描会误杀（实测流过）。
   */
  function findAdResultLink(card) {
    var candidates = [card.querySelector('h2 a[href]'), card.querySelector('.b_tpcn a.tilk[href]'), card.querySelector('a.tilk[href]')];
    for (var i = 0; i < candidates.length; i++) {
      var a = candidates[i];
      if (!a) continue;
      var href = a.getAttribute('href') || '';
      if (AD_HREF_RE.test(href)) return a;
    }
    return null;
  }

  /**
   * 「广告」被渲染成伪元素（::before / ::after 的 content）的情况。
   * 这种模板下 DOM 里真的没有这两个字，所有基于文本的判据都会失效。
   * 只对「自己没有文字」的元素看伪元素，成本可控。
   */
  // 伪元素只探一次：用一条真实存在的 ::before 规则去验证，
  // 而不是只看 getComputedStyle 存不存在 —— jsdom 接受 pseudoElt 参数但直接忽略，
  // 退化成元素自身样式（content 为空字符串），会被误判为「支持」。
  var pseudoState = 0; // 0=未知 1=可用 -1=不支持
  function pseudoWorks(win) {
    if (pseudoState !== 0) return pseudoState === 1;
    var doc = win.document;
    var style = null;
    var probe = null;
    try {
      style = doc.createElement('style');
      style.textContent = '#bcl-pseudo-probe::before{content:"bcl"}';
      probe = doc.createElement('i');
      probe.id = 'bcl-pseudo-probe';
      (doc.head || doc.documentElement).appendChild(style);
      doc.documentElement.appendChild(probe);
      var c = win.getComputedStyle(probe, '::before').content || '';
      pseudoState = /bcl/.test(String(c)) ? 1 : -1;
    } catch (e) {
      pseudoState = -1;
    } finally {
      if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
      if (style && style.parentNode) style.parentNode.removeChild(style);
    }
    return pseudoState === 1;
  }

  function pseudoLabelIsAd(el) {
    var win = el.ownerDocument && el.ownerDocument.defaultView;
    if (!win || typeof win.getComputedStyle !== 'function' || !pseudoWorks(win)) return false;
    var tags = ['::before', '::after'];
    for (var i = 0; i < tags.length; i++) {
      var content;
      try { content = win.getComputedStyle(el, tags[i]).content; } catch (e) { continue; }
      if (!content || content === 'none' || content === 'normal' || content === 'initial') continue;
      var t = String(content).replace(/^["']|["']$/g, '').trim();
      if (/^(广告|廣告|ad|ads|sponsored)$/i.test(t)) return true;
    }
    return false;
  }

  function findAdPseudo(card) {
    var nodes = card.querySelectorAll('span,div,a,em,i,b,strong,font');
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i];
      if (readableText(e).replace(/\s+/g, '').length > 2) continue;
      if (pseudoLabelIsAd(e)) return e;
    }
    return null;
  }

  /**
   * 广告卡的可访问性标记 —— 目前最稳的一条判据（实测 5 张广告卡全中、4 张自然结果全避）。
   *
   * 广告：标题链接带 aria-label="SERP,5230"，而站点名链接 .tilk 的 aria-label
   *       是一个随机串（rkddjcnqjo / wfdii / ohamzpyzyp …），不是站点名。
   * 自然：.tilk 的 aria-label 就是站点名或域名（chatgpt.com / 百度百科 / Microsoft Apps），
   *       标题链接根本没有 aria-label。
   *
   * 两个条件必须同时成立，不单点依赖。典型场景：URL 上没有投放参数、DOM 里也没有
   * 「广告」两个字的广告（阿里云 / 七牛云），只能靠这个认。
   */
  function findAdAriaMarker(card) {
    var title = card.querySelector('h2 a[aria-label]');
    if (!title || !/^SERP,\d+/i.test(title.getAttribute('aria-label') || '')) return null;

    var tilk = card.querySelector('.b_tpcn a.tilk[aria-label], a.tilk[aria-label]');
    if (!tilk) return null;

    var label = (tilk.getAttribute('aria-label') || '').trim();
    if (!label) return null;
    if (label.indexOf('.') !== -1) return null; // 像域名 → 自然结果

    var nameEl = card.querySelector('.tptt');
    var siteName = nameEl ? (nameEl.textContent || '').trim() : '';
    if (siteName && label === siteName) return null; // 与显示的站点名一致 → 自然结果

    return title;
  }

  function hasAdLink(container) {
    return !!findAdResultLink(container);
  }

  /** 卡片里第一条「广告证据」元素，没有则 null。hideTargetFor 要从它往上爬 */
  function findAdMarker(card) {
    if (!card || card.nodeType !== 1) return null;
    if (card.matches(AD_TOKEN_SELECTOR)) return { el: card, reason: 'class' };
    var tok = card.querySelector(AD_TOKEN_SELECTOR);
    if (tok) return { el: tok, reason: 'descendant' };
    var nodes = card.querySelectorAll('span,div,a,em,i,b,strong,font');
    for (var i = 0; i < nodes.length; i++) {
      if (isAdLabel(nodes[i])) return { el: nodes[i], reason: 'label' };
    }
    var caption = findAdCaptionPrefix(card);
    if (caption) return { el: caption, reason: 'caption' };
    // 链接判据比伪元素便宜得多，放前面
    var resultLink = findAdResultLink(card);
    if (resultLink) return { el: resultLink, reason: 'link' };
    var aria = findAdAriaMarker(card);
    if (aria) return { el: aria, reason: 'aria' };
    var pseudo = findAdPseudo(card);
    if (pseudo) return { el: pseudo, reason: 'pseudo' };
    return null;
  }

  /** 卡片是广告则返回原因字符串，否则 null */
  function adReason(card) {
    var m = findAdMarker(card);
    return m ? m.reason : null;
  }

  // 结果容器：卡片就是它下面那层 li
  var RESULT_CONTAINERS = '#b_results, #b_topw, .b_results_eml, #b_context, #b_right, aside';
  // 侧栏容器
  var RAIL_CONTAINERS = '#b_context, #b_right, #b_rightrail, aside';

  // 绝不允许被当成「可以隐藏」的整页骨架
  var NEVER_HIDE = '#b_results, #b_topw, #b_context, #b_right, #b_content, #b_mcw, #b_header, main, aside, body, html';

  /**
   * 从「广告证据」节点定位应该整体隐藏的那一层。
   *
   * 为什么不用「一路往上爬到边界」：真实 SERP 里顶部广告组在 `ol#b_topw`，
   * 它的父层是 `div#b_mcw`（整页结果容器），爬到边界会把整页藏掉。所以改成按
   * 容器分类直接定位，只在侧栏场景做有限的往里收。
   *
   * 定位不到就返回 null（宁可不隐藏，也不要误杀）。
   */
  function hideTargetFor(marker) {
    if (!marker || marker.nodeType !== 1) return null;

    // 1) 结果列表：就是那一层 li（注：li.b_ad 自带 token，会直接落到这里）
    var li = marker.closest(RESULT_CONTAINERS.split(',').map(function (c) {
      return c.trim() + ' > li';
    }).join(', '));
    if (li) return li;

    // 2) 侧栏卡片：先爬到容器下的那一层，再在必要时往里收
    var rail = marker.closest(RAIL_CONTAINERS);
    if (rail) {
      var node = marker;
      while (node.parentElement && node.parentElement !== rail) node = node.parentElement;
      if (node === rail || node.parentElement !== rail) return null;

      var guard = 0;
      while (guard++ < 4) {
        if (node.querySelectorAll('h2, h3').length <= 1) break;
        var inner = null;
        for (var i = 0; i < node.children.length; i++) {
          var c = node.children[i];
          if (c.nodeType === 1 && c.contains(marker) && c.querySelector('h2, h3, cite')) { inner = c; break; }
        }
        if (!inner) break;
        node = inner;
      }
      return node;
    }

    // 3) 其他位置：最近的 li；否则就是它自己（带广告 token 的情况下）
    var l = marker.closest('li');
    if (l) return l;
    if (marker.matches(AD_TOKEN_SELECTOR)) return marker;
    return null;
  }

  /** 显示地址 → 裸 hostname */
  function hostFromCite(card) {
    var sites = root.BCLSites;
    var cite = card.querySelector('cite');
    if (!cite || !sites) return null;
    return sites.normalizeHost(cite.textContent);
  }

  /** 结果卡片归属的 host，取不到返回 null */
  function resultHost(card) {
    var sites = root.BCLSites;
    var h = hostFromCite(card);
    if (h) return h;
    var a = card.querySelector('h2 a[href]');
    if (!a) return null;
    var href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return null;
    try {
      var host = new URL(href).hostname.toLowerCase();
      return sites ? sites.normalizeHost(host) : host;
    } catch (e) {
      return null;
    }
  }

  // 这些 li 是 Bing 的界面组件，不是搜索结果
  var NON_RESULT = '.b_pag, .b_msg, .b_no, .b_ad, .b_ads, .b_footer';

  function isResultCard(card) {
    if (!card || card.nodeType !== 1) return false;
    if (card.matches(NON_RESULT)) return false;
    if (!card.querySelector('cite') && !card.querySelector('h2 a[href]')) return false;
    return true;
  }

  /**
   * 扫一遍：返回要隐藏的广告元素、以及可以挂「屏蔽此站」按钮的结果卡片。
   * 只读，不改 DOM。
   */
  function planScan(doc) {
    var ads = [];
    var seen = new Set();

    function consider(marker, reason) {
      if (!marker) return;
      var target = hideTargetFor(marker);
      if (!target || target === doc.documentElement || target === doc.body) return;
      if (target.matches(NEVER_HIDE)) return;
      if (seen.has(target)) return;
      seen.add(target);
      ads.push({ el: target, reason: reason });
    }

    // 1) 广告容器：先按 class token 找，再往上收敛到卡片层
    var marked = doc.querySelectorAll(AD_TOKEN_SELECTOR);
    for (var i = 0; i < marked.length; i++) {
      var mk = marked[i];
      consider(mk, mk.matches(AD_TOKEN_SELECTOR) ? 'class' : 'descendant');
    }

    // 2) 结果列表 / 侧栏里的候选卡片：兜文本标签与跳转链这两类没有 class 标记的广告。
    //    `#b_content ol > li` 是故意写宽的：Bing 换过几次结果容器（#b_results、#b_topw，
    //    以后可能又是别的），只要还是 ol 列表就都能扫到；没有广告证据的卡片不会被误判。
    var cards = doc.querySelectorAll(
      '#b_results > li, #b_topw > li, #b_content ol > li, #b_context li, #b_context > div, aside li, aside > div');
    for (var j = 0; j < cards.length; j++) {
      var marker = findAdMarker(cards[j]);
      if (!marker) continue;
      consider(marker.el, marker.reason);
    }

    // 3) 自然结果卡片（给屏蔽按钮用）
    var results = [];
    var lis = doc.querySelectorAll('#b_results > li');
    for (var k = 0; k < lis.length; k++) {
      var li = lis[k];
      if (seen.has(li) || !isResultCard(li)) continue;
      if (li.matches(AD_TOKEN_SELECTOR) || li.querySelector(AD_TOKEN_SELECTOR)) continue;
      var host = resultHost(li);
      if (!host) continue;
      results.push({ el: li, host: host });
    }

    return { ads: ads, results: results };
  }

  root.BCLRules = {
    AD_TOKENS: AD_TOKENS,
    AD_TOKEN_SELECTOR: AD_TOKEN_SELECTOR,
    AD_HREF_RE: AD_HREF_RE,
    findAdResultLink: findAdResultLink,
    findAdAriaMarker: findAdAriaMarker,
    readableText: readableText,
    BOUNDARY: BOUNDARY,
    isAdLabel: isAdLabel,
    findAdMarker: findAdMarker,
    findAdCaptionPrefix: findAdCaptionPrefix,
    findAdPseudo: findAdPseudo,
    pseudoLabelIsAd: pseudoLabelIsAd,
    NEVER_HIDE: NEVER_HIDE,
    hasAdLabel: hasAdLabel,
    hasAdLink: hasAdLink,
    adReason: adReason,
    hideTargetFor: hideTargetFor,
    resultHost: resultHost,
    isResultCard: isResultCard,
    planScan: planScan
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
