/**
 * 真站点体检：把扩展加载到 headless 浏览器里，直接打开真实的 cn.bing.com 搜索页，
 * 报告「广告判定命中/漏网」「自然结果有没有被误杀」「按钮位置」，并截图。
 *
 * 这一步是 fixture 测不出来的：fixture 没有 Bing 的样式表，按钮和结果行的真实
 * 版面关系、以及 Bing 线上 class 有没有变，只能靠它验证。
 *
 * 用法：node tools/live-check.mjs [关键词...]
 *   需要联网。截图落在 tests/.artifacts/live-*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchWithExtension, cdpConnect, sleep } from './lib/browser.mjs';

const here = path.dirname(import.meta.url.replace('file:///', '').replace(/\//g, path.sep));
const root = path.resolve(here, '..');
const ART = path.join(root, 'tests', '.artifacts');
fs.mkdirSync(ART, { recursive: true });

const queries = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!queries.length) queries.push('dsh插件', '翻译');

console.log('启动浏览器并加载扩展…');
const browser = await launchWithExtension();
console.log('浏览器:', browser.bin);

const cdp = cdpConnect(browser.page.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false
});

const evaluate = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const waitFor = async (expr, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(`return !!(${expr});`)) return true; } catch { /* 加载中 */ }
    await sleep(200);
  }
  return false;
};

const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ART, name), Buffer.from(r.data, 'base64'));
};

const VIS = `const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;`;

let problems = 0;

for (const q of queries) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&form=QBLH`;
  console.log(`\n=== ${q} ===`);
  await cdp.send('Page.navigate', { url });

  const ok = await waitFor('document.documentElement.hasAttribute("data-bcl-ready")');
  if (!ok) {
    console.log('  ✖ content script 没跑起来（扩展没加载？页面结构大改？）');
    problems++;
    continue;
  }
  await sleep(1800); // 等异步广告位插入完

  const report = await evaluate(`
    ${VIS}
    const organic = [...document.querySelectorAll('#b_results > li.b_algo')];
    const allLi = [...document.querySelectorAll('#b_results > li, #b_topw > li')];
    const hidden = allLi.filter((li) => getComputedStyle(li).display === 'none');
    const marked = [...document.querySelectorAll('[data-bcl-ad]')];
    const btns = [...document.querySelectorAll('#b_results > li.b_algo > .bcl-block')];
    const railAd = [...document.querySelectorAll('#b_context .b_ad, #b_context [data-bcl-ad]')].filter(vis);
    return {
      organicTotal: organic.length,
      organicVisible: organic.filter(vis).length,
      hiddenCards: hidden.length,
      // 原始广告标记计数：用来分辨「本页本来就没广告」和「有广告但漏判了」
      rawAdMarkers: {
        li_b_ad: document.querySelectorAll('li.b_ad').length,
        sb_adTA: document.querySelectorAll('.sb_adTA').length,
        adProvider: document.querySelectorAll('.b_adProvider, .b_adlabel').length,
        adLabelText: [...document.querySelectorAll('#b_results span, #b_results div, #b_context span, #b_context div')]
          .filter((e) => !e.children.length && /^(广告|Ad|Sponsored)$/i.test((e.textContent || '').trim())).length
      },
      markedAds: marked.map((el) => el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || '').split(' ')[0]),
      buttons: btns.length,
      railAdVisible: railAd.length,
      sampleBtn: btns[0] ? {
        text: btns[0].textContent.trim(),
        rect: (() => { const r = btns[0].getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })(),
        opacity: getComputedStyle(btns[0]).opacity
      } : null,
      // 结果行与按钮的几何关系，用来判断按钮有没有盖住标题
      firstLi: organic[0] ? (() => {
        const r = organic[0].getBoundingClientRect();
        const t = organic[0].querySelector('h2');
        const rt = t ? t.getBoundingClientRect() : null;
        return { liTop: Math.round(r.y), liRight: Math.round(r.right), h2Top: rt ? Math.round(rt.y) : null };
      })() : null
    };
  `);

  console.log(`  自然结果 ${report.organicVisible}/${report.organicTotal} 可见（隐藏卡片 ${report.hiddenCards} 个）`);
  const raw = report.rawAdMarkers;
  console.log(`  页面原始广告标记：li.b_ad=${raw.li_b_ad} sb_adTA=${raw.sb_adTA} provider=${raw.adProvider} 广告文本=${raw.adLabelText}`);
  const hadAds = raw.li_b_ad + raw.sb_adTA + raw.adProvider + raw.adLabelText > 0;
  if (!hadAds) {
    console.log('  ⚠ 本页 Bing 没下发广告（未登录/无 cookie/区域原因），这次只验证了「没误杀」，广告判定没被真正考核');
  }
  console.log(`  判定为广告的元素 ${report.markedAds.length} 个：${[...new Set(report.markedAds)].slice(0, 8).join(', ') || '无'}`);
  console.log(`  侧栏广告残留：${report.railAdVisible} 个`);
  console.log(`  屏蔽按钮：${report.buttons} 个；首个按钮 ${JSON.stringify(report.sampleBtn)}`);
  console.log(`  首个结果行 ${JSON.stringify(report.firstLi)}`);

  if (hadAds && report.markedAds.length === 0) {
    console.log('  ✖ 页面上有广告标记，但我们一个都没判出来 —— 规则需要更新');
    problems++;
  }

  if (report.organicTotal === 0) { console.log('  ✖ 一条自然结果都没解析到（页面结构变了？）'); problems++; }
  else if (report.organicVisible !== report.organicTotal) {
    console.log('  ✖ 有自然结果被误杀！'); problems++;
  } else {
    console.log('  ✔ 自然结果全部保留');
  }

  await shot(`live-${queries.indexOf(q) + 1}-${encodeURIComponent(q)}.png`);

  // 再截一张「悬停第二条结果」的图，看按钮出现时会不会盖住标题
  const hover = await evaluate(`
    const li = document.querySelectorAll('#b_results > li.b_algo')[1];
    if (!li) return false;
    li.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    li.classList.add('bcl-li');
    return true;
  `);
  if (hover) {
    await sleep(200);
    await shot(`live-${queries.indexOf(q) + 1}-hover.png`);
  }
}

cdp.close();
browser.proc.kill();
await sleep(300);
try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch { /* noop */ }

console.log(`\n${problems ? '⚠️  有 ' + problems + ' 个问题需要人工看截图' : '✅ 真站点体检通过'}`);
console.log('截图目录：' + ART);
process.exit(problems ? 1 : 0);
