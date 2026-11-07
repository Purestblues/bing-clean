/**
 * e2e 与 live-check 共用的浏览器启动 / CDP 客户端。
 *
 * 为什么不引 puppeteer：Node 22+ 自带 WebSocket，CDP 直连足够，省掉一个重依赖。
 * 为什么按「能否看到自己的 service worker」判断扩展有没有加载：本机 Chrome 156
 * 已经禁了 --load-extension（传了静默忽略），Edge 153 还允许。用行为判断比猜版本号可靠。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

export function candidates() {
  return [
    process.env.BROWSER_PATH,
    process.env.CHROME_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean).filter((p) => fs.existsSync(p));
}

export function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const handlers = new Map();

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败: ' + e.message)));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method && handlers.has(msg.method)) handlers.get(msg.method)(msg.params);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
    }, 25000);
  });

  return {
    send,
    on: (method, fn) => handlers.set(method, fn),
    ready,
    close: () => ws.close()
  };
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function waitPage(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await listTargets(port);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return null;
}

/**
 * 依次尝试候选浏览器，返回第一个真的加载起本地扩展的。
 * @param {{headed?: boolean, basePort?: number}} opts
 */
export async function launchWithExtension(opts = {}) {
  const startedAt = opts.basePort || 9333;
  const errors = [];
  const list = candidates();

  if (!list.length) {
    throw new Error('找不到任何 Chromium 系浏览器，请用 BROWSER_PATH 指定可执行文件');
  }

  for (let i = 0; i < list.length; i++) {
    const bin = list[i];
    const port = startedAt + i;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bcl-'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${PROJECT_ROOT}`,
      `--disable-extensions-except=${PROJECT_ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--disable-background-networking',
      '--disable-features=Translate,OptimizationHints',
      '--window-size=1280,900',
      'about:blank'
    ];
    if (!opts.headed) args.unshift('--headless=new');

    const proc = spawn(bin, args, { stdio: 'ignore' });
    const page = await waitPage(port, Date.now() + 15000);
    if (!page) {
      errors.push(`${path.basename(bin)}: 启动或调试端口不可用`);
      proc.kill();
      continue;
    }

    let loaded = false;
    let extId = null;
    for (let k = 0; k < 25 && !loaded; k++) {
      const targets = await listTargets(port);
      const sw = targets.find((t) =>
        (t.type === 'service_worker' || t.type === 'background_page') &&
        /src\/background\.js$/.test(t.url));
      if (sw) {
        loaded = true;
        extId = sw.url.split('/')[2] || null;
      } else {
        await sleep(200);
      }
    }

    if (loaded) return { proc, port, profile, page, bin, extensionId: extId };

    errors.push(`${path.basename(bin)}: 忽略了 --load-extension（Chrome 137+ 的已知限制）`);
    proc.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }

  throw new Error('没有浏览器能加载本地扩展：\n  ' + errors.join('\n  ') +
    '\n提示：用 BROWSER_PATH 指向仍允许该开关的浏览器（如 Edge 或 Chrome for Testing）');
}
