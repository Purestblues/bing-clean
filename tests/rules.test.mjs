/**
 * 规则层单测。测的是真正上线的那两个文件（sites.js / rules.js 原样 eval 进 jsdom），
 * 不是另写一份逻辑。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SOURCES = ['src/content/sites.js', 'src/content/rules.js'].map((p) =>
  fs.readFileSync(path.join(root, p), 'utf8')
);
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures/bing-serp.html'), 'utf8');

function boot(html = FIXTURE) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cn.bing.com/search?q=dsh' });
  for (const code of SOURCES) dom.window.eval(code);
  return {
    window: dom.window,
    document: dom.window.document,
    sites: dom.window.BCLSites,
    rules: dom.window.BCLRules
  };
}

const cls = (el) => (el.getAttribute('class') || '').trim();
const isHiddenByPlan = (plan, el) => plan.ads.some((a) => a.el === el);

describe('广告判定', () => {
  let ctx, plan;

  before(() => {
    ctx = boot();
    plan = ctx.rules.planScan(ctx.document);
  });

  test('顶部广告组（ol#b_topw 里的 li.b_ad）被判定为广告', () => {
    const top = ctx.document.querySelector('#b_topw > li.b_ad');
    assert.ok(top, 'fixture 里应该有顶部广告组');
    assert.ok(isHiddenByPlan(plan, top), '顶部广告组应该被隐藏');
  });

  test('底部广告块被判定为广告', () => {
    const bottom = ctx.document.querySelector('#b_results > li.b_ad.b_adBottom');
    assert.ok(isHiddenByPlan(plan, bottom));
  });

  test('右侧栏广告卡被判定为广告', () => {
    const rail = ctx.document.querySelector('#b_context .b_ad');
    assert.ok(rail);
    assert.ok(plan.ads.some((a) => a.el === rail || a.el.contains(rail) || rail.contains(a.el)),
      '侧栏广告卡应该被隐藏');
  });

  test('自然结果一条都不能被判定为广告', () => {
    const organic = [...ctx.document.querySelectorAll('#b_results > li.b_algo')];
    assert.ok(organic.length >= 6, `fixture 里的自然结果只有 ${organic.length} 条`);
    for (const li of organic) {
      assert.equal(isHiddenByPlan(plan, li), false, `误杀了自然结果：${li.textContent.trim().slice(0, 40)}`);
    }
  });

  test('摘要正文里出现「广告」两个字，不算广告', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li.b_algo')]
      .find((e) => e.textContent.includes('广告位规格'));
    assert.ok(li, 'fixture 里应有这条误杀守卫用例');
    assert.equal(isHiddenByPlan(plan, li), false);
  });

  test('标题里带 Ad 的站点（AdGuard）不算广告', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li.b_algo')]
      .find((e) => e.textContent.includes('AdGuard'));
    assert.ok(li);
    assert.equal(isHiddenByPlan(plan, li), false);
  });

  test('侧栏「相关搜索」不算广告', () => {
    const rs = ctx.document.querySelector('#b_context .b_rs');
    assert.ok(rs);
    assert.equal(isHiddenByPlan(plan, rs), false);
  });

  test('只有一段裸「广告」标签、没有任何 b_ad* class 的广告也能抓住（兜底路径）', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li')]
      .find((e) => e.textContent.includes('限时活动五折起'));
    assert.ok(li, 'fixture 里应有裸标签广告用例');
    assert.ok(isHiddenByPlan(plan, li), '标签兜底没生效');
  });

  test('结构一模一样、但标签是「公告」的对照组不能被误杀', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li')]
      .find((e) => e.textContent.includes('站点维护公告'));
    assert.ok(li);
    assert.equal(isHiddenByPlan(plan, li), false);
  });

  test('广告标签内联在摘要开头（用户实测形态）要能抓到', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li')]
      .find((e) => e.textContent.includes('双模型赋能全链路创作'));
    assert.ok(li, 'fixture 里应有内联标签广告用例');
    assert.ok(isHiddenByPlan(plan, li), '内联在摘要开头的广告标签没被识别');
  });

  test('摘要以「广告投放…」开头（无分隔符）不能误杀', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li')]
      .find((e) => e.textContent.includes('投放规范与审核流程说明'));
    assert.ok(li);
    assert.equal(isHiddenByPlan(plan, li), false, '把「广告投放」当成广告标签了');
  });

  test('摘要中间夹一个独立「广告」元素（不在段首）不能误杀', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li')]
      .find((e) => e.textContent.includes('常见问题：为什么我的推广计划审核失败'));
    assert.ok(li);
    assert.equal(isHiddenByPlan(plan, li), false, '段中出现的「广告」被当成了标签');
  });

  test('摘要里混了内联 <style> 污染文本，仍能识别段首广告标签（真实 SERP 形态）', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li')]
      .find((e) => e.textContent.includes('GPT-5.6/5.5 on Amazon Bedrock'));
    assert.ok(li, 'fixture 里应有样式块污染用例');
    assert.ok(isHiddenByPlan(plan, li), '样式块污染导致 textContent 不以「广告」开头，缩进判定失效');
  });

  test('卡片里存在隐藏的广告跳转锚点（不在标题上）不能误杀', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li')]
      .find((e) => e.textContent.includes('ChatGPT desktop app'));
    assert.ok(li, 'fixture 里应有隐藏跳转锚点对照组');
    assert.equal(isHiddenByPlan(plan, li), false, '非标题位置的广告锚点被当成了广告信号');
  });

  test('广告标签是纯文本（无独立元素）也能抓到', () => {
    const li = [...ctx.document.querySelectorAll('#b_results > li')]
      .find((e) => e.textContent.includes('千问-智能创作专家'));
    assert.ok(li, 'fixture 里应有纯文本广告前缀用例');
    assert.ok(isHiddenByPlan(plan, li), '纯文本形式的「广告 」前缀没被识别');
  });

  test('分页、提示条不算广告', () => {
    for (const sel of ['#b_results > li.b_pag', '#b_results > li.b_msg']) {
      const el = ctx.document.querySelector(sel);
      assert.ok(el);
      assert.equal(isHiddenByPlan(plan, el), false);
    }
  });
});

describe('防误杀骨架', () => {
  test('任何判定结果都不能是页面骨架', () => {
    const { document, rules } = boot();
    const plan = rules.planScan(document);
    const forbidden = ['#b_results', '#b_topw', '#b_context', '#b_content', '#b_mcw', 'MAIN', 'ASIDE', 'BODY', 'HTML'];
    for (const a of plan.ads) {
      const hit = forbidden.some((f) =>
        f.startsWith('#') ? a.el.id === f.slice(1) : a.el.tagName === f
      );
      assert.equal(hit, false, `误判了骨架节点：${a.el.tagName}#${a.el.id}`);
    }
  });

  test('findAdMarker 不会把侧栏的「相关搜索」当成广告', () => {
    const { document, rules } = boot();
    assert.equal(rules.findAdMarker(document.querySelector('#b_context .b_rs')), null);
  });
});

describe('结果卡片解析', () => {
  let ctx, plan;
  before(() => {
    ctx = boot();
    plan = ctx.rules.planScan(ctx.document);
  });

  test('每条自然结果都解析出 host', () => {
    assert.ok(plan.results.length >= 6);
    for (const r of plan.results) assert.ok(r.host, '有结果没解析出 host');
  });

  test('CSDN 的两个子域都识别到', () => {
    const hosts = plan.results.map((r) => r.host);
    assert.ok(hosts.includes('blog.csdn.net'));
    assert.ok(hosts.includes('mp.csdn.net'));
  });

  test('广告块不会被当成可屏蔽的结果卡片', () => {
    const hosts = plan.results.map((r) => r.host);
    assert.equal(hosts.includes('www.doubao.com'), false);
  });
});

describe('主域归一', () => {
  let sites;
  before(() => { sites = boot().sites; });

  const cases = [
    ['blog.csdn.net', 'csdn.net'],
    ['mp.csdn.net', 'csdn.net'],
    ['csdn.net', 'csdn.net'],
    ['www.baidu.com', 'baidu.com'],
    ['fanyi.baidu.com', 'baidu.com'],
    ['a.b.example.com.cn', 'example.com.cn'],
    ['www.zhihu.com', 'zhihu.com'],
    ['gist.github.io', 'gist.github.io'],
    ['app.vercel.app', 'app.vercel.app'],
    ['127.0.0.1', '127.0.0.1']
  ];

  for (const [host, want] of cases) {
    test(`${host} → ${want}`, () => assert.equal(sites.siteKey(host), want));
  }

  test('单个词不当作域名', () => {
    assert.equal(sites.siteKey('localhost'), null);
    assert.equal(sites.normalizeHost('广告'), null);
  });

  test('cite 里的 › 装饰能被清洗掉', () => {
    assert.equal(sites.normalizeHost('https://www.bing.com\u203a translator'), 'www.bing.com');
    assert.equal(sites.normalizeHost('https://fanyi.baidu.com'), 'fanyi.baidu.com');
    assert.equal(sites.normalizeHost('  '), null);
  });

  test('黑名单按主域命中子域', () => {
    assert.equal(sites.matchesEntry('blog.csdn.net', 'csdn.net'), true);
    assert.equal(sites.matchesEntry('csdn.net', 'csdn.net'), true);
    assert.equal(sites.matchesEntry('notcsdn.net', 'csdn.net'), false);
    assert.equal(sites.matchesEntry('csdn.net.evil.com', 'csdn.net'), false);
  });

  test('findBlocked 返回命中的那一条', () => {
    const list = ['zhihu.com', 'csdn.net'];
    assert.equal(sites.findBlocked('blog.csdn.net', list), 'csdn.net');
    assert.equal(sites.findBlocked('example.com', list), null);
  });

  test('用户输入归一', () => {
    assert.equal(sites.entryFromUserInput('https://blog.csdn.net/x/article/1'), 'csdn.net');
    assert.equal(sites.entryFromUserInput('blog.csdn.net'), 'csdn.net');
    assert.equal(sites.entryFromUserInput('CSDN.net'), 'csdn.net');
    assert.equal(sites.entryFromUserInput('=blog.csdn.net'), 'blog.csdn.net');
    assert.equal(sites.entryFromUserInput('hello world'), null);
    assert.equal(sites.entryFromUserInput(''), null);
  });
});
