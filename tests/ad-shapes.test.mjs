/**
 * 广告形态矩阵。
 *
 * 每一条都是「线上真的长这样」或「线上真的踩过」的形态，按最小结构手写，
 * 不依赖整页快照。加新形态请连同对照组一起加，避免又把守卫写死一边。
 *
 * 背景：v1.0.0 把摘要区里的广告标签一律拒掉，导致「广告 通过 Amazon…」这类
 * 内联标签广告全部漏掉；v1.1.0 又因为 Bing 把 <style> 写在结果 li 里，让
 * textContent 以 CSS 开头，「是否以广告开头」的判断整体失效；同一版还因为
 * 「卡片内任意广告跳转锚点」把自然结果误判成广告。下面的用例把这些坑都钉住了。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SOURCES = ['src/content/sites.js', 'src/content/rules.js'].map((p) =>
  fs.readFileSync(path.join(root, p), 'utf8'));

const SNIPPET = '通过Amazon Bedrock使用OpenAI前沿模型，以更少token生成更高质量输出。';

function card(inner, opts = {}) {
  const href = opts.href || 'https://aws.amazon.com/x';
  return `<li${opts.cls ? ` class="${opts.cls}"` : ''}>
    <style>.a{color:red}</style>
    <div class="b_tpcn"><a class="tilk" href="${href}">
      <div class="tptxt"><div class="tptt">AWS</div><div class="tpmeta"><cite>https://aws.amazon.com</cite></div></div>
    </a></div>
    <h2><a href="${href}">GPT-5.6/5.5 on Amazon Bedrock</a></h2>
    ${inner}
  </li>`;
}

function judge(liHtml) {
  const html = `<!doctype html><html><body><div id="b_content"><main><div id="b_mcw">
    <ol id="b_results">${liHtml}</ol></div></main></div></body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cn.bing.com/search?q=chatgpt' });
  for (const code of SOURCES) dom.window.eval(code);
  const plan = dom.window.BCLRules.planScan(dom.window.document);
  return plan.ads.length ? plan.ads[0].reason : null;
}

describe('应当被判为广告的形态', () => {
  test('广告标签是独立 span，顶在摘要开头', () => {
    assert.ok(judge(card(`<div class="b_caption"><p class="b_lineclamp2"><span>广告</span> ${SNIPPET}</p></div>`)));
  });

  test('广告标签是纯文本（没有独立元素），后面跟空格', () => {
    assert.equal(
      judge(card(`<div class="b_caption"><p class="b_lineclamp2">广告 ${SNIPPET}</p></div>`)),
      'caption');
  });

  test('广告标签用 · 等分隔符', () => {
    assert.equal(
      judge(card(`<div class="b_caption"><p class="b_lineclamp2">广告·${SNIPPET}</p></div>`)),
      'caption');
  });

  test('摘要容器里混了一个 <style> 块（真实 SERP 就这样）', () => {
    assert.ok(judge(card(`<div class="b_caption"><style>.x{}</style><p class="b_lineclamp2"><span>广告</span> ${SNIPPET}</p></div>`)));
  });

  test('标签外面还包了一层无语义 span', () => {
    assert.equal(
      judge(card(`<div class="b_caption"><p class="b_lineclamp2"><span class="wrap"><span>广告</span></span> ${SNIPPET}</p></div>`)),
      'label');
  });

  test('标题链接带 aclick 跳转', () => {
    assert.equal(judge(card(`<div class="b_caption"><p>正常摘要，与广告无关，长度足够。</p></div>`,
      { href: 'https://www.bing.com/aclick?ld=1' })), 'link');
  });

  test('标题链接带 msclkid（微软广告点击 id）', () => {
    assert.equal(judge(card(`<div class="b_caption"><p>正常摘要，与广告无关，长度足够。</p></div>`,
      { href: 'https://aws.amazon.com/bedrock/?msclkid=abc' })), 'link');
  });
});

describe('真实卡片结构（从用户诊断里抄下来的）', () => {
  /**
   * 这几条是 2026-11-07 用户实际遇到的漏判广告，HTML 属性原样照抄。
   * 共同点：卡片没有任何 b_ad class，DOM 里也没有「广告」两个字，
   * 唯一能区分的是「落地页 URL 带投放参数」。
   */
  const realAd = (href, opts = {}) => `<li class="b_algo">
    <div class="b_tpcn"><a class="tilk" h="ID=SERP,5462.1" aria-label="ohamzpyzyp" target="_blank" href="${href}">
      <div class="tpic"><div class="wr_fav"><div class="cico siteicon"></div></div></div>
      <div class="tptxt"><div class="tptt">${opts.name || '千问客户端'}</div><div class="tpmeta"> <div class="b_attribution"><cite>${opts.cite || 'b.qianwen.com'}</cite></div></div></div>
    </a></div>
    <div class="b_title"><h2><a target="_blank" href="${href}">${opts.title || '千问-阿里AI助手 - Qwen大模型体验'}</a></h2></div>
    <div class="b_caption"><p class="b_lineclamp2">${opts.snippet || '通义千问大模型驱动,你的多能创作伙伴. 一键搞定写作、PPT与绘画,让创意即刻实现!'}</p></div>
    ${opts.extra || ''}
  </li>`;

  test('千问：URL 带 from=bingsem / a_keywordid', () => {
    assert.equal(judge(realAd('https://b.qianwen.com/apps/qkhomepage/routes/l5Utxkrh6?entry=x&planid=524851878&a_keywordid=82465521268012&a_creative=82463816280795&a_matchtype=e&query=chatgpt&from=bingsem&aid=187293602')), 'link');
  });

  test('WorkBuddy：URL 带 fromSource=gwzcw', () => {
    assert.equal(judge(realAd('https://www.workbuddy.cn/?fromSource=gwzcw.24102531.24102531.24102531', {
      name: 'Wοrkbudԁу', cite: 'www.workbuddy.cn', title: 'workbuddy_腾讯AI办公助手 - 免部署安装即用'
    })), 'link');
  });

  test('豆包：URL 带 channel=bing_sem', () => {
    assert.equal(judge(realAd('https://www.doubao.com/work/?ug_apk_token=FcYHJ;channel=bing_sem', {
      name: '豆包工作版', cite: 'www.doubao.com › 豆包工作', title: '豆包工作-Al智能体自动干活'
    })), 'link');
  });

  test('豆包：站内链接带 b_ads1line / ad_vsl class', () => {
    const extra = `<div class="b_vlist2col b_deep"><ul>
      <li><span class="b_ads1line ad_vsl"><a class="ad_vslWiderClk" href="https://example.com/a">自动完成重复工作任务</a></span></li>
      <li><span class="b_ads1line ad_vsl"><a class="ad_vslWiderClk" href="https://example.com/b">豆包工作模式全面升级</a></span></li>
    </ul></div>`;
    assert.ok(judge(realAd('https://www.doubao.com/work/', { extra })), 'ad_vsl 站内链接没被识别');
  });

  test('同一页的自然结果（learn.chatgpt.com / 百度百科 / 微软商店）一条都不能中', () => {
    const organic = [
      'https://learn.chatgpt.com/docs/app',
      'https://apps.microsoft.com/detail/9plm9xgg6vks?hl=zh-CN&gl=CN',
      'https://www.codex-chinese.com/chatgpt/guides/chatgpt-cn-official',
      'https://baike.baidu.com/item/ChatGPT/62446358'
    ];
    for (const href of organic) {
      assert.equal(judge(realAd(href, { name: 'x', cite: href.replace(/^https?:\/\//, '').split('/')[0] })), null,
        `误杀了自然结果 ${href}`);
    }
  });
});

describe('只用 aria 标记的广告（URL 干净、DOM 里没有「广告」两个字）', () => {
  /**
   * 2026-11-07 第二页实测：阿里云的链接是 click.aliyun.com/se/…，七牛云直接是
   * www.qiniu.com/ai/chat，两张卡都没有「广告」文字。能认的只有 aria 标记：
   * 标题链接 aria-label="SERP,5230" + .tilk 的 aria-label 是随机串。
   */
  const ariaCard = (opts) => `<li class="b_algo">
    <div class="b_tpcn"><a class="tilk" h="ID=SERP,5230.1" aria-label="${opts.tilkLabel}" target="_blank" href="${opts.href}">
      <div class="tpic"><div class="wr_fav"><div class="cico siteicon"></div></div></div>
      <div class="tptxt"><div class="tptt">${opts.siteName}</div><div class="tpmeta"> <div class="b_attribution"><cite>${opts.cite}</cite></div></div></div>
    </a></div>
    <div class="b_title"><h2><a target="_blank"${opts.h2Aria ? ` aria-label="${opts.h2Aria}"` : ''} href="${opts.href}">${opts.title}</a></h2></div>
    <div class="b_caption"><p class="b_lineclamp2">${opts.snippet}</p></div>
  </li>`;

  test('阿里云：click.aliyun.com/se/… + 随机 aria-label', () => {
    assert.equal(judge(ariaCard({
      tilkLabel: 'rkddjcnqjo', h2Aria: 'SERP,5230', siteName: '阿里云官网',
      cite: 'www.aliyun.com', href: 'https://click.aliyun.com/se/1024468700/',
      title: '阿里云 - 千问AI双11',
      snippet: '多款旗舰模型、应用免费体验. Token Plan低至5折,千问办公29.9元起'
    })), 'aria');
  });

  test('七牛云：链接完全干净，只能靠 aria 标记', () => {
    assert.equal(judge(ariaCard({
      tilkLabel: 'wfdii', h2Aria: 'SERP,5234', siteName: '七牛云',
      cite: 'https://www.qiniu.com › 七牛云 › AI大模型', href: 'https://www.qiniu.com/ai/chat',
      title: '七牛云AI大模型推理服务 - 体验即送300万Token',
      snippet: '兼容OpenAI API，全面支持MCP，轻松接入多场景应用，注册即送300万Token.'
    })), 'aria');
  });

  test('自然结果（.tilk 的 aria-label 就是域名）不能中', () => {
    assert.equal(judge(ariaCard({
      tilkLabel: 'chatgpt.com', siteName: 'chatgpt.com',
      cite: 'https://learn.chatgpt.com', href: 'https://learn.chatgpt.com/docs/app',
      title: 'ChatGPT desktop app | ChatGPT Learn',
      snippet: 'ChatGPT app launch brief, a concise plan.'
    })), null);
  });

  test('自然结果（.tilk 的 aria-label 就是站点名）不能中', () => {
    assert.equal(judge(ariaCard({
      tilkLabel: 'Microsoft Apps', siteName: 'Microsoft Apps',
      cite: 'https://apps.microsoft.com', href: 'https://apps.microsoft.com/detail/9nt1r1c2hh7j',
      title: 'ChatGPT Classic - Free download and install',
      snippet: 'The official ChatGPT desktop app brings you the newest model improvements.'
    })), null);
  });

  test('只有标题链接带 SERP aria、但 .tilk 是站点名 → 不算（防单点依赖）', () => {
    assert.equal(judge(ariaCard({
      tilkLabel: '百度百科', h2Aria: 'SERP,5268', siteName: '百度百科',
      cite: 'https://baike.baidu.com', href: 'https://baike.baidu.com/item/ChatGPT/62446358',
      title: 'ChatGPT_百度百科',
      snippet: 'ChatGPT就像是AI圈里的一枚深水炸弹。'
    })), null);
  });
});

describe('不能被判为广告的形态（对照组）', () => {
  test('正文以「广告投放」开头，没有分隔符', () => {
    assert.equal(judge(card(`<div class="b_caption"><p class="b_lineclamp2">广告投放需要经过两轮审核，先自审再送平台复审。</p></div>`)), null);
  });

  test('正文中间提到「广告」两个字', () => {
    assert.equal(judge(card(`<div class="b_caption"><p class="b_lineclamp2">本页说明广告素材的审核标准，包含广告位规格。</p></div>`)), null);
  });

  test('正文中间夹一个独立的「广告」元素', () => {
    assert.equal(judge(card(`<div class="b_caption"><p class="b_lineclamp2">审核失败多半是素材里带了 <b>广告</b> 之外的诱导用语。</p></div>`)), null);
  });

  test('卡片里有隐藏的广告跳转锚点，但标题链接是直链', () => {
    assert.equal(judge(card(
      `<a class="hidden-tracker" href="https://www.bing.com/aclick?ld=tracker" hidden></a>
       <div class="b_caption"><p class="b_lineclamp2">ChatGPT app launch brief, a concise plan.</p></div>`,
      { cls: 'b_algo' })), null);
  });

  test('标签在标题里（标题本身写着「广告投放」）', () => {
    assert.equal(judge(card(`<div class="b_caption"><p class="b_lineclamp2">这里是普通的页面摘要，长度足够。</p></div>`)), null);
  });
});
