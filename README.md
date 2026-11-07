# Bing 净化

一个只干两件事的 Chrome 扩展：把 Bing 搜索结果里的广告从页面上拿掉；让你一键屏蔽再也不想看到的站点（比如 CSDN）。

屏蔽按**主域**生效：屏蔽 `csdn.net` 之后，`blog.csdn.net`、`mp.csdn.net`、`download.csdn.net` 一起消失，不用一个一个加。只想屏蔽某个子域的话，在弹窗里输入 `=blog.csdn.net`。

它不联网、不上报、不加载任何远程代码，黑名单存在浏览器自己的 `chrome.storage.sync` 里，跟着你的 Chrome 账号同步。

## 安装

扩展没有上架商店，本地加载即可，全程约一分钟。

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选中本项目根目录 `D:\Projects\bing-clean`
4. 打开 Bing 搜点东西，看到结果右上角悬停出现的「🚫 屏蔽 xxx」就好了

如果只想装分发包，先解压 `dist/bing-clean-1.0.0.zip`，第 3 步选解压出来的目录。

## 用法

**屏蔽站点**：鼠标悬停在任意一条搜索结果上，右上角出现「🚫 屏蔽 csdn.net」，点一下，这个主域的所有结果立刻消失，底部弹一条回执，6 秒内可以点「撤销」反悔。同一站点出现多条结果时，后面的按钮会淡一些，因为点哪条都一样。

**管黑名单**：点工具栏图标打开弹窗。里面能看到本页去掉了几个广告、隐藏了几条结果、有哪些站点可以被屏蔽；下面是屏蔽名单，每条右边一个 × 可以单独取消；上面的输入框可以手动加域名，直接粘 `https://blog.csdn.net/xxx/article/details/123` 也会被归一成 `csdn.net`。

**开关**：四个开关分别是「去广告」「去右侧栏广告」「显示屏蔽按钮」「操作后显示回执」。关掉「去广告」后已经藏起来的广告会原地回来，不用刷新。

## 它做了什么、没做什么

判定依据不是瞎猜的选择器，是从真实 `cn.bing.com` 搜索页渲染后的 DOM 里核对出来的：广告整块是 `#b_results > li.b_ad`（顶部分组在 `ol#b_topw` 里，底部分组带 `b_adBottom`），广告单元的类是 `sb_adTA`，广告标签是 `.b_adProvider` / `.b_adlabel` 或一段文字恰好为「广告」的叶子节点，广告链接会走 `bing.com/aclick` 或 `e.so.com/search/eclk` 跳转。自然结果是 `li.b_algo`，链接是直链。

所以它做的是「把广告元素从视觉上移除」：`display: none`，外加清理掉被清空的广告分组容器，避免留一道空白。它**不**拦截广告脚本的加载，也**不**在你去访问被屏蔽的站点时拦你——屏蔽只作用于搜索结果页，你手动敲 `blog.csdn.net` 照样能打开。这样出现误判时永远有退路。

误杀是唯一的严重事故，所以规则里对文字标签有一整套守卫：标签必须是叶子节点、文本极短、且不在摘要 `.b_caption` / `p` / `cite` / 标题里。摘要正文里出现「广告」两个字不会触发，标题里带 `Ad` 的 AdGuard 也不会。

## 如果哪天失效了

Bing 改版会导致选择器失配，表现为「广告又回来了」或者「结果被整片藏掉」。两种自查方式：

- 打开弹窗点「复制本页诊断」，会拿到本页的完整判定明细：`ads` 是被判成广告的元素（`reason` 说明命中了哪条判据：`class` / `descendant` / `label` / `caption` / `link` / `aria` / `pseudo`），`unmatched` 是没被判成广告的卡片——每张都带剥离样式后的 `html`、`aria`、`links`、`attrs`，漏判直接看它们的原始标记就能定位，不用再截图猜
- 命令行跑 `node tools/live-check.mjs 关键词`，它用真实浏览器打开真实 Bing，报告「页面原始广告标记数 / 判定为广告的元素数 / 自然结果是否被误杀」，并截图到 `tests/.artifacts/`

## 开发者

```bash
npm install          # 只有一个 devDependency：jsdom
npm test             # 规则层单测（含一整页真实 SERP 快照的回归）
npm run e2e          # 加载真实扩展跑 headless 浏览器，测隐藏/屏蔽/撤销/持久化/弹窗
npm run live-check   # 对着真实 cn.bing.com 体检（需要联网）
npm run build        # 产出 dist/bing-clean-<version>.zip
```

两个注意点，都写在 `tools/lib/browser.mjs` 里：

- Chrome 137 之后禁用了 `--load-extension`，传了会被静默忽略。`e2e` 会自动挑一个仍然支持该开关的浏览器（本机是 Edge 153），判断依据是「能否看到自己扩展的 service worker」，而不是猜版本号。
- `bing.com` 在 HSTS 预载列表里，把域名映射到本地 HTTP 服务会被强制升级成 https 直接 SSL 报错。所以 `e2e` 不用本地服务器，改用 CDP 的 Fetch 拦截伪造响应，彻底离线。

维护约定和目录说明见 `AGENTS.md`。

## 许可证

[MIT](LICENSE) © 2026 Purestblues。

这是一个和个人“烦死了”有关的作品：CSDN 每次搜技术问题都占满第一屏，点进去还要登录才能看全文。广告同理，既然 Bing 不肯把它藏起来，就自己藏。
