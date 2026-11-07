/**
 * 真实 DOM 回归：拿一整页从 cn.bing.com 抓下来的、渲染完成后的 SERP（gzip 存在
 * fixtures/bing-serp-real.html.gz），原样喂给规则层。
 *
 * 这个文件的价值在于它是「别人写的真实标记」，不是我自己构造的 fixture ——
 * 里面既有真广告块（li.b_ad.b_adTop / b_adBottom、sb_adTA、b_adProvider、广告标签），
 * 也有 10 条真实自然结果。任何误杀都会在这里立刻暴露。
 *
 * 需要更新快照时：headless 打开 cn.bing.com 搜索页，--dump-dom 存成 html，
 * gzip -9 覆盖本文件即可（命令见 AGENTS.md）。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SOURCES = ['src/content/sites.js', 'src/content/rules.js'].map((p) =>
  fs.readFileSync(path.join(root, p), 'utf8'));

const html = zlib
  .gunzipSync(fs.readFileSync(path.join(here, 'fixtures/bing-serp-real.html.gz')))
  .toString('utf8');

describe('真实 SERP 快照', () => {
  let ctx, plan;

  before(() => {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cn.bing.com/search?q=%E7%BF%BB%E8%AF%91' });
    for (const code of SOURCES) dom.window.eval(code);
    ctx = { window: dom.window, document: dom.window.document, sites: dom.window.BCLSites, rules: dom.window.BCLRules };
    plan = ctx.rules.planScan(ctx.document);
  });

  test('快照结构符合预期（文件没被改坏）', () => {
    assert.ok(ctx.document.querySelectorAll('#b_results > li.b_algo').length >= 8);
    assert.ok(ctx.document.querySelectorAll('li.b_ad').length >= 2);
    assert.ok(ctx.document.querySelectorAll('.sb_adTA').length >= 2);
  });

  test('顶部广告组被判定为广告', () => {
    const top = ctx.document.querySelector('#b_topw > li.b_ad');
    assert.ok(top, '快照里应有顶部广告组');
    assert.ok(plan.ads.some((a) => a.el === top), '顶部广告组必须被隐藏');
  });

  test('底部广告块被判定为广告', () => {
    const bottom = ctx.document.querySelector('#b_results > li.b_ad.b_adBottom');
    assert.ok(bottom);
    assert.ok(plan.ads.some((a) => a.el === bottom));
  });

  test('所有 li.b_ad 都被覆盖', () => {
    const all = [...ctx.document.querySelectorAll('li.b_ad')];
    for (const li of all) {
      assert.ok(plan.ads.some((a) => a.el === li || a.el.contains(li) || li.contains(a.el)),
        `漏掉了广告：${li.getAttribute('class')}`);
    }
  });

  test('每一条自然结果都完好无损（误杀检查）', () => {
    const organic = [...ctx.document.querySelectorAll('#b_results > li.b_algo')];
    assert.ok(organic.length >= 8);
    for (const li of organic) {
      const killed = plan.ads.some((a) => a.el === li || a.el.contains(li));
      assert.equal(killed, false, `误杀了自然结果：${li.textContent.trim().slice(0, 40)}`);
    }
  });

  test('分页 / 提示条 / answer 面板都没被误判', () => {
    for (const sel of ['#b_results > li.b_pag', '#b_results > li.b_msg', '#b_results > li.b_ans']) {
      const el = ctx.document.querySelector(sel);
      if (!el) continue;
      assert.equal(plan.ads.some((a) => a.el === el), false, `误判了 ${sel}`);
    }
  });

  test('自然结果都能解析出站点键', () => {
    assert.ok(plan.results.length >= 8);
    for (const r of plan.results) {
      assert.ok(ctx.sites.siteKey(r.host), `解析不出站点键：${r.host}`);
    }
  });

  test('屏蔽 baidu.com 会命中 fanyi.baidu.com', () => {
    const hosts = plan.results.map((r) => r.host);
    assert.ok(hosts.includes('fanyi.baidu.com'));
    assert.equal(ctx.sites.findBlocked('fanyi.baidu.com', ['baidu.com']), 'baidu.com');
  });
});
