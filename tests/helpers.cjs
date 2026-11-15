// 端到端测试公共工具：多浏览器实例、假媒体、真实 WebRTC、服务端 getStats 采样
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const LIB_PATH = '/home/node/.local/chromium-libs/usr/lib/aarch64-linux-gnu:/home/node/.local/chromium-libs/lib/aarch64-linux-gnu';

const launchOptions = {
  headless: true,
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newBrowser() {
  return chromium.launch(launchOptions);
}

// 打开教师页并完成发布，返回 page 与浏览器
async function startTeacher(browser, roomId, peerId = `teacher-${Date.now()}`) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/teacher.html`);
  await page.fill('#roomId', roomId);
  await page.fill('#peerId', peerId);
  await page.click('#joinBtn');
  await page.waitForFunction(() => document.querySelector('#sigStatus').textContent.includes('信令在线'), null, { timeout: 10000 });
  await page.click('#publishBtn');
  await page.waitForFunction(() => document.querySelector('#mediaStatus').textContent.includes('发布中'), null, { timeout: 15000 });
  await sleep(3000);
  return { page, ctx, errors };
}

// 打开学生页并等待出画
async function startStudent(browser, roomId, peerId, { waitMs = 7000 } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/student.html`);
  await page.fill('#roomId', roomId);
  await page.fill('#peerId', peerId);
  await page.click('#joinBtn');
  await sleep(waitMs);
  return { page, ctx, errors };
}

// 读取学生统计区表格
async function readStudentRows(page) {
  return page.$$eval('#statsArea tbody tr', (rows) =>
    rows.map((r) => {
      const c = [...r.querySelectorAll('td')].map((x) => x.textContent.trim());
      return { track: c[0], kind: c[1], browserKbps: c[2], sfuKbps: c[3], layer: c[4], cap: c[5] };
    })
  );
}

// 读取学生页每路订阅卡片上的首次出画时间
async function readFirstFrames(page) {
  return page.$$eval('#consumerArea .firstframe', (els) => els.map((e) => e.textContent));
}

// 直接调用页面内信令（通过 UI 不便时用）：在 window 上暴露的 fetch 不可用，
// 因此统一走 DOM 操作；本函数读取服务端统计快照（学生页 get-stats 轮询结果）
async function readServerSnapshot(page) {
  return page.evaluate(async () => {
    // 复用页面已建立的 WS 不方便，这里读取已渲染的 SFU 数据
    return document.querySelector('#statsArea')?.innerText || '';
  });
}

async function closePage(page, ctx) {
  try { await page.close(); } catch { /* ignore */ }
  try { await ctx.close(); } catch { /* ignore */ }
}

module.exports = {
  BASE, LIB_PATH, launchOptions, sleep, newBrowser,
  startTeacher, startStudent, readStudentRows, readFirstFrames,
  readServerSnapshot, closePage,
};
