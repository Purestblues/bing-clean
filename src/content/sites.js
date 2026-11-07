/**
 * 站点键解析：把 hostname 归一到「可屏蔽的主域」。
 *
 * 设计取舍：不引 publicsuffix 包（几百 KB，且要定期同步），只用一张小表维护
 * 常见多段后缀。命中不了的就按最后两段算，最坏情况是把 a.b.example.co.xx
 * 记成 co.xx —— 但那种域名基本不会出现在搜索结果首位，收益大于风险。
 */
(function (root) {
  'use strict';

  // 两段组合起来才算「一个域」的公共后缀。只收录中文互联网环境下高频的。
  var MULTI_SUFFIX = [
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
    'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
    'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw',
    'com.mo', 'net.mo', 'org.mo', 'edu.mo',
    'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk',
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
    'co.kr', 'or.kr', 'ne.kr',
    'com.au', 'net.au', 'org.au', 'edu.au',
    'co.nz', 'co.in', 'co.za', 'co.id', 'co.il', 'co.th',
    'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.my', 'com.ph',
    'com.pl', 'com.ru', 'com.ua', 'com.es', 'com.it', 'com.de',
    // 把「子域即独立站点」的托管平台整体当成主域，避免误屏蔽整个平台
    'github.io', 'githubusercontent.com', 'github.dev', 'gitee.io', 'gitlab.io',
    'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'web.app',
    'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'azurewebsites.net'
  ].reduce(function (acc, s) { acc[s] = 1; return acc; }, Object.create(null));

  var IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

  /** 把 cite 里带装饰的显示地址清洗成裸 hostname，失败返回 null */
  function normalizeHost(input) {
    if (!input) return null;
    var s = String(input).trim();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');  // 去掉协议
    s = s.replace(/^www\.bing\.com\/ck\/a.*$/i, ''); // 跳转链直接放弃
    // 截断路径、query、Bing 的 › 分段装饰、空白
    s = s.split(/[\s\u00a0\u203a\u276f\/?#]/)[0];
    s = s.replace(/^\/\//, '').replace(/:\d+$/, '').replace(/\.+$/, '').toLowerCase();
    if (!s) return null;
    if (IPV4.test(s)) return s;
    if (/^[a-z0-9\u4e00-\u9fa5-]+(\.[a-z0-9\u4e00-\u9fa5-]+)+$/i.test(s)) return s;
    return null;
  }

  /** hostname → 站点键。blog.csdn.net → csdn.net；gist.github.io → gist.github.io */
  function siteKey(host) {
    var h = normalizeHost(host);
    if (!h) return null;
    if (IPV4.test(h)) return h;
    var parts = h.split('.');
    if (parts.length <= 2) return h;
    var last2 = parts.slice(-2).join('.');
    if (MULTI_SUFFIX[last2]) {
      // github.io 这类平台：三级域名本身才是站点，不再往上合并
      return parts.slice(-3).join('.');
    }
    return last2;
  }

  /**
   * 黑名单匹配。entry 为 'csdn.net' 时命中 csdn.net 与 *.csdn.net；
   * 若用户手动加了 'blog.csdn.net'，同样命中它的子域。
   */
  function matchesEntry(host, entry) {
    if (!host || !entry) return false;
    var h = String(host).toLowerCase().replace(/^\./, '');
    var e = String(entry).toLowerCase().replace(/^\./, '');
    return h === e || h.slice(-(e.length + 1)) === '.' + e;
  }

  /** 返回命中的那条黑名单记录（用于 toast 和统计），没有则 null */
  function findBlocked(host, entries) {
    if (!host || !entries || !entries.length) return null;
    for (var i = 0; i < entries.length; i++) {
      if (matchesEntry(host, entries[i])) return entries[i];
    }
    return null;
  }

  /**
   * 提交黑名单时归一：'https://blog.csdn.net/x'、'blog.csdn.net'、'csdn.net'
   * 一律存成 'csdn.net'（按主域屏蔽，和点按钮的行为保持一致）。
   * 想只屏蔽某个子域，输入时加前缀 '='，如 '=blog.csdn.net'。
   */
  function entryFromUserInput(input) {
    var raw = String(input == null ? '' : input).trim();
    var exact = false;
    if (raw.charAt(0) === '=') { exact = true; raw = raw.slice(1).trim(); }
    var h = normalizeHost(raw);
    if (!h) return null;
    return exact ? h : siteKey(h);
  }

  root.BCLSites = {
    MULTI_SUFFIX: MULTI_SUFFIX,
    normalizeHost: normalizeHost,
    siteKey: siteKey,
    matchesEntry: matchesEntry,
    findBlocked: findBlocked,
    entryFromUserInput: entryFromUserInput
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
