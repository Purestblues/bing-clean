# bing-clean · 维护约定

一个 Chrome 扩展（Manifest V3），只做两件事：把 Bing 搜索结果里的广告从页面上拿掉，以及按用户手动维护的黑名单隐藏整站结果（默认按主域，屏蔽 `csdn.net` 会连 `blog.csdn.net`、`mp.csdn.net` 一起隐藏）。

## 目录结构

```
manifest.json            MV3 清单。content script 按 sites.js → rules.js → content.js 顺序注入
src/content/sites.js     主域解析（hostname → 可屏蔽站点键），纯函数，无 chrome 依赖
src/content/rules.js     广告判定与结果卡片解析，纯 DOM 逻辑，无 chrome 依赖
src/content/content.js   胶水层：storage 读写、MutationObserver、注入按钮、toast、消息
src/content/content.css  注入样式（含静态广告兜底隐藏，见下）
src/popup/               工具栏弹窗：开关、本页统计（订阅推送实时刷新）、黑名单增删、诊断导出
src/background.js        service worker：默认配置、角标计数
tests/                   jsdom 单测 + fixture（裁剪版 + 整页真实快照 .gz）
tools/e2e.mjs            真扩展端到端（CDP Fetch 伪造响应，完全离线）
tools/live-check.mjs     对着真实 cn.bing.com 体检并截图（需联网）
tools/lib/browser.mjs    e2e 与 live-check 共用的浏览器启动 + CDP 客户端
tools/package.mjs        打包 zip（自写 ZIP 结构，零依赖）
```

## 分层规则（重要）

`rules.js` 和 `sites.js` 是**纯逻辑层**，禁止出现 `chrome.*`、禁止直接改全局 DOM 状态。它们只接收元素、返回判断结果。这样单测可以直接把这两个文件 `eval` 进 jsdom，测的就是上线那份代码。

所有需要 `chrome.*` 的东西只能待在 `content.js`、`popup/`、`background.js`。改规则时先改 `rules.js`，再跑 `npm test`。

## 权限与弹窗怎么认「本页」

manifest 只要四条：`storage`、`activeTab`、`scripting`，加 `host_permissions: ["*://*.bing.com/*"]`（与 content script 的 `matches` 同源，不额外增加安装警告）。`scripting` 唯一的用途是弹窗里的两个兜底动作：读一次 `location.href`、以及给「脚本已失效的旧标签页」补注入三个 content 文件。

弹窗判定当前页的顺序是**先问脚本、再判 URL、最后补注入**，`popup.js` 的 `resolvePage()` 就按这个顺序写：

1. `chrome.tabs.sendMessage(tabId, 'bcl:stats')` 能拿到响应，就说明这就是 Bing 搜索页且脚本在跑，直接渲染；
2. 拿不到响应才用 `tab.url` 或 `chrome.scripting.executeScript` 读到的 URL 判断到底是不是 Bing 搜索页；
3. 是 Bing 页但脚本没响应（典型场景：扩展被重载/更新，旧标签页里的内容脚本已变成「活着但 chrome.* 全失效」的僵尸），`reinject()` 补注入 `sites.js` → `rules.js` → `content.js`，再问一次；还不行才提示用户刷新。

**不要用 `tab.url` 当唯一依据**：弹窗里的 `chrome.tabs.query` 返回的 tab 可能根本没有 `url` 字段（缺 host 权限，或弹窗不是用户点击打开的）。v1.1.5 就是把 `isBingSearch(tab.url)` 当门禁，结果在真实弹窗里每一页都被判成「不是 Bing 搜索结果页」，统计恒为 `–`。

因为补注入要能真正接管，`content.js` 的 `window.__bclInjected` 守卫保持最简单的一行短路就行。**不要给它加什么「活体检查」**：扩展重载后旧脚本虽然还在页面里（`chrome.runtime.id` 已是 `undefined`），但 `chrome.scripting.executeScript` 注入的是**新的隔离世界**，旧的 `__bclInjected` 不在里面，所以补注入天然生效。这一套用「加载扩展 → 页面就绪 → `chrome.runtime.reload()` → 再开弹窗，数字应立刻出现」验证过，写 `contextAlive()` 那种猜测性护栏属于多余动作。

## storage 的读写约定

`background.js` 的 `onInstalled` 只做「补缺失的键」：先用 `chrome.storage.sync.get(null)` 看实际存了什么（**不能传 `DEFAULTS` 取默认值**，那样「没存过」和「读失败」会得到同一个结果，紧接着又把那个结果写回去，就等于拿默认值盖用户的黑名单），再只 `set` 真缺的键。`settings` 还缺开关时才合并写回，键齐全就一个字不动。

写 storage 的地方严格分工：`popup.js` 的 `persistBlocklist()` / `persistSettings()` 各写各的键，`content.js` 的 `saveBlocklist()` 只写 `blocklist`。不要为了省事在任何一个地方整对象覆盖 `blocklist` + `settings`。

> 踩过的坑：`chrome.storage.sync.get({})` 传空对象等于「查零个键」，永远返回 `{}`。要看全部数据必须 `get(null)`。这个假象会直接把人引向错误的结论（我一开始就据此以为 set 没生效）。

统计数据是**推**的，不是弹窗打开时问一次：`content.js` 每次 `scan()` 结束都会 `chrome.runtime.sendMessage` 一份完整的 `bcl:count`（含 `ads/blocked/results/hosts`），service worker 用它写角标，弹窗用它就地重绘（只认 `sender.tab.id === 当前页` 的消息，避免多标签页串台）。所以异步迟到的广告会让弹窗里的数字自己往上跳。

## 广告判定的信息来源

判定依据是从真实 Bing SERP（`cn.bing.com/search?q=...`，headless 渲染后抓的 DOM）里确认过的结构，不是猜的：

- 广告整块是 `li.b_ad`：顶部分组在 `ol#b_topw`（注意**不在** `#b_results` 里），底部分组带 `b_adBottom`，组内子项是 `li.b_adLastChild`。
- 广告单元是 `div.sb_add.sb_adTA`，内部有 `.b_adTopIcon`（站点图标）、`.b_adProvider`（文案形如「| 来自 360」）、`h2.b_topTitleAd` 里的 `a.sb_adTA_title_link_cn`。
- 广告链接会走 `bing.com/aclick` 或 `e.so.com/search/eclk` 这类跳转；自然结果是**直链**（`https://fanyi.baidu.com/`）。
- 自然结果是 `li.b_algo`，头部 `.b_tpcn`（含 `.tptt` 站名与 `cite` 显示地址），标题 `h2 > a`，摘要 `.b_caption > p`。

**定位策略是刻意做成可预测的**，不是「一路往上爬到边界」：因为顶部广告组的父层是 `div#b_mcw`（整页结果容器），爬到边界会把整页藏掉。现在的 `hideTargetFor()` 按「结果容器下的那层 li」直接定位，只有侧栏卡片才做有限的往里收；定位不到就返回 `null`（宁可不隐藏，也不要误杀）。

刷新整页真实快照（`tests/fixtures/bing-serp-real.html.gz`）：

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --virtual-time-budget=9000 \
  --dump-dom "https://cn.bing.com/search?q=%E7%BF%BB%E8%AF%91" > /tmp/real.html
gzip -9 -c /tmp/real.html > tests/fixtures/bing-serp-real.html.gz
npm test
```

注意：Bing 是否下发广告取决于 cookie/登录/区域，headless 冷启动经常一个广告都不给（`tools/live-check.mjs` 会把这种情况明确报出来，别把「没广告」当成「规则有效」）。所以线上体检只能证明没误杀，广告判定的真回归靠上面那份整页快照。

## 误杀是唯一的严重事故

搜索页结构一变，最坏情况不是漏广告，是**把自然结果整片隐藏**。所以：

- 基于「文字标签」的判定（元素文本恰好是 `广告`/`Ad`/`Sponsored`）必须过三层守卫：叶子节点无子元素、不在标题/地址区（`h2`/`h3`/`cite`/`.b_algoSlug`）、且如果它在摘要区就必须**顶在段首且后面还有至少 10 个字的正文**。
- 纯文本形式的兜底（`findAdCaptionPrefix`）要求 `广告` 后面紧跟空白或分隔符，所以「广告投放指南…」这种正文开头不会中；裸的 `Ad` 故意不收，避开英文摘要开头的 “Ad blockers…”。
- 新增选择器必须有对应的反面测试用例（`tests/rules.test.mjs` 里「不能误杀」与「对照组」分组）。

> 历史教训：
> 1. v1.0.0 把「摘要区里的广告标签」一律拒绝，结果用户实测的广告（`广告` 内联在摘要开头，如「广告 通过 Amazon…」）全部漏判。
> 2. v1.1.0 把「卡片里存在广告跳转锚点」当成广告证据，但 Bing 会在**自然结果**里也塞隐藏的跳转锚点，造成误杀。现在 `link` 判据只看**卡片自己的 `h2 a` 链接**。
> 3. v1.1.0 用 `textContent` 判断「是否以广告开头」，而 Bing 把 `<style>` 直接写在结果 `li` 里，`textContent` 开头是一大段 CSS，于是这类判断整体失效。所有读文本的地方必须用 `rules.readableText()`（跳过 style/script）。

真实形态已经固化成三组回归：`tests/ad-shapes.test.mjs`（广告形态矩阵，每条都配对照组）、`tests/fixtures/bing-serp.html` 里的手写用例（含伪元素标签）、以及 `tests/fixtures/bing-serp-real.html.gz`（整页真实快照）。改守卫前先跑它们。

> 4. 实测还有一类广告：卡片上既没有 `b_ad*` class，DOM 里也**没有「广告」两个字**。这种靠**落地页 URL 的投放参数**认：`bingsem`、`bing_sem`、`gwzcw`（百度SEM前缀）、`a_keywordid`、`a_creative`、`a_matchtype`、`msclkid`。判据是 `findAdResultLink()`，只看 `h2 a` 与 `.b_tpcn a.tilk`，**不扫全卡**（扫全卡会误杀）。
> 5. 广告卡的「站内链接」一排带 `b_ads1line` / `ad_vsl` / `ad_vslWiderClk`。这三个 token 曾经被当成「太泛」而剔除，直接导致整类广告漏判 —— 不要为了降误杀面而删真实广告专属 token，注释里写明了就保留。
> 6. 伪元素标签靠 `findAdPseudo()`：用 `getComputedStyle(el, '::before'|'::after').content` 找。jsdom 会忽略 pseudoElt 参数并返回元素自身样式，所以 `pseudoWorks()` 要用一条真实 `::before` 规则去探测，不能只看函数存不存在。
> 7. 目前最稳的一条是 `findAdAriaMarker()`：广告卡的标题链接带 `aria-label="SERP,5230"`、同时 `.tilk` 的 `aria-label` 是随机串（`rkddjcnqjo`）；自然结果的 `.tilk` aria-label 就是站点名或域名，标题链接没有 aria-label。两个条件必须同时成立。别名 / URL 都干净的广告（阿里云 `click.aliyun.com/se/`、七牛云干净直链）只能靠它。
> 8. 诊断里的 `unmatched` 先收 `#b_results`，再收侧栏，否则会被「相关搜索」的 li 挤满。
> 9. **弹窗的问题只能靠真弹窗测**。v1.1.5 的 e2e 是把 `popup.html` 当普通标签页打开的，那条路径读到的 `tab.url` 是弹窗自己的 `chrome-extension://` 地址，于是「统计不可用」被当成正确行为断言了下来，真实 bug（工具栏弹窗里统计恒为 `–`）一年都不会被这条用例拦住。现在 e2e 用 `chrome.action.openPopup()`（从 service worker target 里 evaluate）真的把弹窗开出来测，顺带测「弹窗开着时页面新增广告，数字要自己跳」。
> 10. 补注入能不能生效取决于「新旧脚本在不在同一个隔离世界」：实测扩展重载后重新 `executeScript` 落的是新世界，旧的 `__bclInjected` 不会拦，所以守卫保持一行短路即可。校验方式：加载扩展 → 页面就绪 → `chrome.runtime.reload()` → 再开弹窗，数字必须立刻出现（而不是「刷新一下页面」）。

## 工作步骤

1. `npm install`（只有 jsdom 一个 devDependency）
2. `npm test` —— 规则层单测（含整页真实快照回归），必须先绿
3. `npm run e2e` —— 真扩展跑 headless 浏览器（含 `chrome.action.openPopup()` 开出的真弹窗），截图在 `tests/.artifacts/`
4. `npm run live-check` —— 可选，对着真实 Bing 体检（需联网）
5. `npm run build` —— 产出 `dist/bing-clean-<version>.zip`
6. 改版本号的地方只有 `manifest.json` 和 `package.json`，两处要一致

## 测试环境里的三个坑（已绕开，别踩回去）

- **Chrome 137+ 静默忽略 `--load-extension`**：本机 Chrome 156 传了参数也不加载。`tools/lib/browser.mjs` 按候选列表依次尝试，用「能否看到自己扩展的 service worker target」判断是否真的加载成功；本机实际生效的是 Edge。
- **bing.com 在 HSTS 预载列表里**：把域名 map 到本地 HTTP 服务会被强制升级成 https，直接 `ERR_SSL_PROTOCOL_ERROR`。所以 `e2e` 不用本地服务器，改用 CDP `Fetch.enable` + `fulfillRequest` 伪造所有响应，完全离线、可复现。注意访问 `chrome-extension://` 页面之前必须先 `Fetch.disable`，否则弹窗页也会被伪造成空响应。
- **弹窗只能在 service worker 里打开**：`chrome.action.openPopup()` 没有 UI 可点，从 `/json/list` 里找到 `src/background.js` 的 service_worker target，连上去 evaluate 就能把真弹窗开出来（已能用）。新的弹窗 target 不继承主页面那条连接的 `Fetch.enable`，所以它自己的资源加载不会被伪造。用完用 browser 级连接 `Target.closeTarget` 关掉，免得影响后面「把 popup.html 当标签页打开」的老用例。
- **重载扩展会把 storage 打回去**：`chrome.runtime.reload()` 之后 `storage.sync` 会回到安装初期的状态（实测：先把 `blocklist` 写成 `['csdn.net']`，reload 后读回来是 `[]`；而且这个回滚不是我们 `onInstalled` 写的——把写入临时注释掉仍然是 `[]`）。所以「重载自愈」那条用例必须排在最后，不能排在「弹窗里能看到 csdn.net」那种依赖黑名单的用例前面。

多段后缀（`com.cn`、`github.io` 等）在 `sites.js` 的 `MULTI_SUFFIX` 里维护，不引第三方 PSL 包。`popup.js` 手动输入走的是同一个 `entryFromUserInput()`，不要在弹窗里另写一份规则。

## 交付形态

本地加载（`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选项目根目录）。不上架商店，所以 `manifest.json` 里不写 `update_url`，也不做远程代码加载，MV3 合规。

## 死约

没有用户明确许可，不删任何文件。
