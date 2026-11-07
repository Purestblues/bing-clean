/**
 * 真扩展端到端测试。
 *
 * 关键设计：bing.com 在 HSTS 预载列表里，把域名 map 到本地 HTTP 服务会被强制升级成
 * https 直接 SSL 报错。所以这里不搞本地服务器，改用 CDP 的 Fetch 域拦截所有请求，
 * 把主文档换成 tests/fixtures/bing-serp.html，其余请求一律空响应。好处是彻底离线、
 * 不受 HSTS / DNS / 证书影响。
 *
 * 用 CDP 而不是 puppeteer，是为了不引额外依赖（Node 22+ 自带 WebSocket）。
 *
 * 参数：--headed 打开有头窗口便于肉眼看；--keep 保留临时 profile 便于排查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, cdpConnect, sleep } from './lib/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ART = path.join(root, 'tests', '.artifacts');
const FIXTURE = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'bing-serp.html'), 'utf8');
const FIXTURE_B64 = Buffer.from(FIXTURE, 'utf8').toString('base64');

const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');
const DEBUG_PORT = 9333;
const SERP_URL = 'https://cn.bing.com/search?q=dsh%E6%8F%92%E4%BB%B6&form=QBLH';

/*
 * 浏览器选择逻辑（Chrome 137+ 已禁 --load-extension、Edge 仍支持）在 lib/browser.mjs
 * 里统一处理：依次尝试候选浏览器，以能否看到自己的 service worker 作为判定。
 */

/** 断言计数 */
let pass = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✖ ${name}${extra ? '  → ' + extra : ''}`);
  }
}

function eq(name, actual, want) {
  ok(name, JSON.stringify(actual) === JSON.stringify(want),
    `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(want)}`);
}

/* ----------------------------------------------------------------- 主流程 */

fs.mkdirSync(ART, { recursive: true });

let browser;
let cdp;
let exitCode = 0;

try {
  browser = await launchWithExtension();
  console.log(`浏览器: ${browser.bin}\n扩展已加载，调试端口 ${browser.port}`);
  cdp = cdpConnect(browser.page.webSocketDebuggerUrl);
  await cdp.ready;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 所有请求都由我们伪造，一个真实网络包都不发
  cdp.on('Fetch.requestPaused', async ({ requestId, request, resourceType }) => {
    try {
      const isDoc = resourceType === 'Document' && /(^|\.)bing\.com/.test(new URL(request.url).hostname);
      if (isDoc) {
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
            { name: 'Cache-Control', value: 'no-store' }
          ],
          body: FIXTURE_B64
        });
      } else {
        await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 204, body: '' });
      }
    } catch { /* 请求已经被取消，忽略 */ }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url });
  };

  const waitFor = async (expression, label, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(`return !!(${expression});`)) return true;
      } catch { /* 加载中 */ }
      await sleep(120);
    }
    throw new Error(`等待超时：${label}`);
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ART, name), Buffer.from(r.data, 'base64'));
  };

  const VIS = `const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;`;

  console.log('\n[1] 首屏：广告消失、自然结果完整、按钮就位');
  await navigate(SERP_URL);
  await waitFor('document.documentElement.hasAttribute("data-bcl-ready")', 'content script 就绪');
  await sleep(700);

  const first = await evaluate(`
    ${VIS}
    const ads = [...document.querySelectorAll('#b_topw > li.b_ad, #b_results > li.b_ad')];
    const organic = [...document.querySelectorAll('#b_results > li.b_algo')];
    return {
      adTotal: ads.length,
      adVisible: ads.filter(vis).length,
      organicTotal: organic.length,
      organicVisible: organic.filter(vis).length,
      railAdVisible: vis(document.querySelector('#b_context .b_ad')),
      relatedSearchVisible: vis(document.querySelector('#b_context .b_rs')),
      buttons: document.querySelectorAll('#b_results > li.b_algo > .bcl-block').length,
      emptyGroupsHidden: getComputedStyle(document.querySelector('#b_topw')).display === 'none',
      inlineLabelAdVisible: (() => {
        const li = [...document.querySelectorAll('#b_results > li')]
          .find((e) => e.textContent.includes('双模型赋能全链路创作'));
        return li ? vis(li) : null;
      })(),
      pseudoLabelAdVisible: (() => {
        const li = [...document.querySelectorAll('#b_results > li')]
          .find((e) => e.textContent.includes('限时特惠 全场五折起'));
        return li ? vis(li) : null;
      })()
    };
  `);

  eq('顶部 + 底部广告全部隐藏', first.adVisible, 0);
  eq('自然结果一条不少', first.organicVisible, first.organicTotal);
  eq('侧栏广告被隐藏', first.railAdVisible, false);
  eq('侧栏「相关搜索」仍然显示', first.relatedSearchVisible, true);
  eq('每条自然结果都挂了「屏蔽此站」按钮', first.buttons, first.organicTotal);
  eq('被清空的广告分组容器已收起（不留空白）', first.emptyGroupsHidden, true);
  eq('「广告」标签内联在摘要开头的广告也被隐藏', first.inlineLabelAdVisible, false);
  eq('「广告」用伪元素渲染的广告也被隐藏', first.pseudoLabelAdVisible, false);

  const btn = await evaluate(`
    const b = document.querySelector('#b_results > li.b_algo > .bcl-block');
    if (!b) return null;
    const s = getComputedStyle(b);
    return { text: b.textContent.trim(), opacity: s.opacity, pointerEvents: s.pointerEvents, position: s.position };
  `);
  ok('按钮默认隐形，悬停才出现', btn && btn.opacity === '0' && btn.pointerEvents === 'none', JSON.stringify(btn));
  ok('按钮绝对定位，不挤动结果布局', btn && btn.position === 'absolute', JSON.stringify(btn));
  ok('按钮文案带上了要屏蔽的主域', btn && /屏蔽\s*\S+\.\S+/.test(btn.text), btn && btn.text);

  const repeatBtn = await evaluate(`
    const b = document.querySelector('#b_results > li.b_algo > .bcl-block[data-bcl-repeat="1"]');
    return b ? { opacity: getComputedStyle(b).opacity, key: b.dataset.bclKey } : null;
  `);
  ok('同站点的重复按钮默认也不该显形（需要悬停）', repeatBtn && repeatBtn.opacity === '0',
    JSON.stringify(repeatBtn));

  await shot('01-去广告后.png');

  console.log('\n[2] 点「屏蔽 csdn.net」，同主域结果一起消失');
  const clicked = await evaluate(`
    const btns = [...document.querySelectorAll('#b_results > li.b_algo > .bcl-block')];
    const b = btns.find((x) => x.dataset.bclKey === 'csdn.net');
    if (!b) return { ok: false, keys: btns.map((x) => x.dataset.bclKey) };
    b.click();
    return { ok: true };
  `);
  ok('找到 csdn.net 的屏蔽按钮', clicked.ok === true, JSON.stringify(clicked));

  await sleep(500);
  const afterBlock = await evaluate(`
    ${VIS}
    const organic = [...document.querySelectorAll('#b_results > li.b_algo')];
    const csdn = organic.filter((li) => /csdn\\.net/i.test(li.textContent));
    return {
      csdnTotal: csdn.length,
      csdnVisible: csdn.filter(vis).length,
      organicVisible: organic.filter(vis).length,
      toast: (document.querySelector('.bcl-toast') || {}).textContent || '',
      hasUndo: !!document.querySelector('.bcl-toast .bcl-toast-btn')
    };
  `);

  ok('确实有多条 CSDN 结果', afterBlock.csdnTotal >= 2, `实际 ${afterBlock.csdnTotal}`);
  eq('blog.csdn.net 与 mp.csdn.net 一起被隐藏', afterBlock.csdnVisible, 0);
  ok('其它站点结果不受影响', afterBlock.organicVisible > 0, `可见 ${afterBlock.organicVisible}`);
  ok('回执里写明了被屏蔽的主域', afterBlock.toast.includes('csdn.net'), afterBlock.toast);
  eq('回执带撤销按钮', afterBlock.hasUndo, true);

  await shot('02-屏蔽csdn后.png');

  console.log('\n[3] 点回执里的「撤销」，CSDN 应该立刻回来');
  const undoClicled = await evaluate(`
    const b = document.querySelector('.bcl-toast .bcl-toast-btn');
    if (!b) return false;
    b.click();
    return true;
  `);
  eq('撤销按钮可点', undoClicled, true);
  await sleep(500);

  const afterUndo = await evaluate(`
    ${VIS}
    const organic = [...document.querySelectorAll('#b_results > li.b_algo')];
    const csdn = organic.filter((li) => /csdn\\.net/i.test(li.textContent));
    const back = csdn.filter(vis).length;
    // 重新屏蔽，供下一步验证持久化
    const b = [...document.querySelectorAll('#b_results > li.b_algo > .bcl-block')]
      .find((x) => x.dataset.bclKey === 'csdn.net');
    if (b) b.click();
    return { back, total: csdn.length };
  `);
  eq('撤销后 CSDN 结果重新显示', afterUndo.back, afterUndo.total);
  await sleep(400);

  console.log('\n[4] 再次屏蔽后刷新，验证 storage 持久化');
  await navigate(SERP_URL);
  await waitFor('document.documentElement.hasAttribute("data-bcl-ready")', '刷新后 content script 就绪');
  await sleep(600);

  const afterReload = await evaluate(`
    ${VIS}
    const organic = [...document.querySelectorAll('#b_results > li.b_algo')];
    const csdn = organic.filter((li) => /csdn\\.net/i.test(li.textContent));
    const ads = [...document.querySelectorAll('#b_topw > li.b_ad, #b_results > li.b_ad')];
    return {
      csdnVisible: csdn.filter(vis).length,
      organicVisible: organic.filter(vis).length,
      adVisible: ads.filter(vis).length
    };
  `);
  eq('刷新后 CSDN 仍然被隐藏', afterReload.csdnVisible, 0);
  ok('其余自然结果照常显示', afterReload.organicVisible > 0, `可见 ${afterReload.organicVisible}`);
  eq('刷新后广告依然被隐藏', afterReload.adVisible, 0);

  console.log('\n[5] 关掉「去广告」开关后广告应当能恢复');
  const adsBack = await evaluate(`
    ${VIS}
    document.documentElement.setAttribute('data-bcl-no-ads', '');
    const ads = [...document.querySelectorAll('#b_topw > li.b_ad, #b_results > li.b_ad')];
    const n = ads.filter(vis).length;
    document.documentElement.removeAttribute('data-bcl-no-ads');
    return { total: ads.length, visible: n };
  `);
  ok('开关关闭时广告可以恢复显示', adsBack.visible > 0, JSON.stringify(adsBack));

  console.log('\n[6] 弹窗页能正常渲染，并且能手动增删黑名单');
  if (!browser.extensionId) {
    ok('拿到扩展 ID（用于打开弹窗页）', false, '没有从 service worker target 解析出 ID');
  } else {
    // 弹窗页是 chrome-extension:// 地址，必须先把请求拦截关掉，否则会被伪造成 204
    await cdp.send('Fetch.disable');
    await navigate(`chrome-extension://${browser.extensionId}/src/popup/popup.html`);    await waitFor('document.getElementById("ver") && document.getElementById("ver").textContent', '弹窗页渲染');
    await sleep(400);

    const popup = await evaluate(`
      const q = (s) => document.querySelector(s);
      return {
        title: q('.brand') ? q('.brand').textContent.trim() : '',
        version: q('#ver').textContent,
        switches: [...document.querySelectorAll('.switch')].map((s) => s.checked),
        items: [...document.querySelectorAll('#list .domain')].map((e) => e.textContent),
        hint: !q('#hint').hidden,
        addVisible: !!q('#addForm')
      };
    `);

    ok('弹窗标题正确', popup.title.includes('Bing'), popup.title);
    ok('版本号渲染出来了', /^v\d+\.\d+\.\d+$/.test(popup.version), popup.version);
    eq('四个开关都在且默认开启', popup.switches, [true, true, true, true]);
    ok('黑名单里能看到刚屏蔽的 csdn.net', popup.items.includes('csdn.net'), JSON.stringify(popup.items));
    ok('在弹窗内（非 Bing 页）给出「统计不可用」提示', popup.hint === true);
    ok('手动添加表单存在', popup.addVisible === true);

    await shot('04-弹窗.png');

    // 手动添加一个域名，验证入口可用
    const added = await evaluate(`
      const input = document.querySelector('#addInput');
      input.value = 'https://zhuanlan.zhihu.com/p/1';
      document.querySelector('#addForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    `);
    ok('提交表单未抛错', added === true);
    await sleep(400);
    const afterAdd = await evaluate(`
      return [...document.querySelectorAll('#list .domain')].map((e) => e.textContent);
    `);
    ok('粘贴完整 URL 也会被归一成主域 zhihu.com', afterAdd.includes('zhihu.com'), JSON.stringify(afterAdd));

    await shot('05-弹窗-新增后.png');
  }
} catch (err) {
  console.error('\n测试异常:', err.message);
  exitCode = 1;
} finally {
  try { cdp?.close(); } catch { /* noop */ }
  try { browser?.proc.kill(); } catch { /* noop */ }
  await sleep(400);
  if (!KEEP && browser) {
    try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch { /* Windows 占用时忽略 */ }
  }
}

console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
try {
  const files = fs.readdirSync(ART).filter((f) => f.endsWith('.png'));
  if (files.length) console.log('截图：' + files.map((f) => path.join(ART, f)).join('\n      '));
} catch { /* noop */ }

if (failures.length) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
process.exit(exitCode);
