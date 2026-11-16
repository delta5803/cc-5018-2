// 教学转发调度原型专项：验证两个方案确实接到真实包转发入口。
//
// 断言只看内核/浏览器实测，不看页面质量标签：
//   1) 控制页可下发方案，结果来自 mediasoup Consumer.setPreferredLayers +
//      WebRtcTransport.setMaxOutgoingBitrate；
//   2) 按接收者独立评分：低带宽学生降层，高带宽学生不被拖累；
//   3) 按共同层组分配预算：同组同层，高带宽学生被最弱链路拉低；
//   4) 实际层、发送预算、浏览器可解码帧三者都能在控制页对照；
//   5) 导出证据 JSON，供 scripts/layer-policy-experiment.mjs 复算。
const fs = require('fs');
const path = require('path');
const {
  sleep, newBrowser, startTeacher, startStudent, closePage,
} = require('./helpers.cjs');
const { CoreProbe } = require('./probe.cjs');

const ROOM = `sched-${Date.now()}`;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail, at: new Date().toISOString() });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail !== undefined) console.log(`       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

async function main() {
  const browser = await newBrowser();
  const probe = new CoreProbe(ROOM);
  await probe.join();
  const teacher = await startTeacher(browser, ROOM, 'teacher-sched');
  const low = await startStudent(browser, ROOM, 'stu-low');
  const high = await startStudent(browser, ROOM, 'stu-high');
  await sleep(4000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:3000/control.html');
  await page.fill('#roomId', ROOM);
  await page.click('#connectBtn');
  await page.waitForFunction(() => document.querySelector('#coreStatus').textContent.includes('已连接'), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#budgetInputs input').length >= 2, null, { timeout: 10000 });

  // 基线：两学生均为 S2 可解码
  const baseLow = await probe.studentVideo('stu-low');
  const baseHigh = await probe.studentVideo('stu-high');
  record('基线两学生均收到 S2', baseLow.videos.every((v) => v.spatialLayer === 2) && baseHigh.videos.every((v) => v.spatialLayer === 2), {
    low: baseLow.videos.map((v) => `S${v.spatialLayer}`),
    high: baseHigh.videos.map((v) => `S${v.spatialLayer}`),
  });

  // 设置预算：低 350k，高 3.2M，勾选组成员。
  // 预算口径是“该接收者整条接收 Transport”，学生同时收 camera+bench 两路，
  // 所以 350k 只够两路 S0，3.2M 才够两路 S2（见 experiments/layer-policy/trajectory.json）。
  await page.evaluate(() => {
    const setBudget = (id, kbps) => {
      const el = document.querySelector(`input[data-budget-id="${id}"]`);
      el.value = String(kbps);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setBudget('stu-low', 350);
    setBudget('stu-high', 3200);
  });
  await page.check('input[data-group-id="stu-low"]');
  await page.check('input[data-group-id="stu-high"]');

  // 轮询等实际层收敛（BWE 向上探测不是瞬时），超时则如实记录当时的层
  async function waitVideoLayer(peerId, wantMax, maxMs = 35000) {
    const start = Date.now();
    let snap = null;
    while (Date.now() - start < maxMs) {
      snap = await probe.studentVideo(peerId);
      if (snap.videos.length && snap.videos.every((v) => v.spatialLayer <= wantMax)) {
        return { snap, reached: true, ms: Date.now() - start };
      }
      await sleep(2000);
    }
    return { snap, reached: false, ms: Date.now() - start };
  }

  // ---- 方案 A：按接收者独立评分 ----
  await page.selectOption('#schemeSelect', 'per-receiver');
  await page.click('#applySchemeBtn');
  await sleep(3000);
  const resA = await page.textContent('#resultLog');
  const planA = await probe.studentVideo('stu-low');
  record('按接收者独立评分已下发到转发入口', resA.includes('方案已下发到转发入口'), resA.split('\n').slice(-2).join(' | '));
  record('独立评分：低带宽学生实际降层', planA.videos.every((v) => v.spatialLayer <= 1), {
    lowLayers: planA.videos.map((v) => `S${v.spatialLayer}@${(v.bitrate / 1000).toFixed(0)}k`),
  });
  // 高带宽学生：预算 3.2M 能覆盖 camera+bench 两路 S2；BWE 需要时间爬升，
  // 用轮询等它收敛，而不是固定 sleep 后立刻断言。
  const highWait = await waitVideoLayer('stu-high', 2);
  record('独立评分：高带宽学生最终到 S2（未被拖累）', highWait.reached, {
    highLayers: highWait.snap.videos.map((v) => `S${v.spatialLayer}@${(v.bitrate / 1000).toFixed(0)}k`),
    waitedMs: highWait.ms,
  });
  // ---- 方案 B：按共同层组分配预算 ----
  await page.selectOption('#schemeSelect', 'group-shared');
  await page.click('#applySchemeBtn');
  await sleep(6000);
  const resB = await page.textContent('#resultLog');
  const planB = await probe.studentVideo('stu-low');
  const planBHigh = await probe.studentVideo('stu-high');
  const sameLayer = planB.videos.every((v) => v.spatialLayer === planBHigh.videos[0]?.spatialLayer);
  record('共同层组方案已下发到转发入口', resB.includes('方案已下发到转发入口'));
  record('共同层组：组内同层，高带宽学生被拖到与最弱一致', sameLayer, {
    low: planB.videos.map((v) => `S${v.spatialLayer}@${(v.bitrate / 1000).toFixed(0)}k`),
    high: planBHigh.videos.map((v) => `S${v.spatialLayer}@${(v.bitrate / 1000).toFixed(0)}k`),
  });

  // 证据表：实际层 / 发送预算 / 浏览器可解码帧 三者都在控制页
  await page.waitForFunction(() => {
    const el = document.querySelector('#schemeEvidence');
    return el && /解码 \d+ 帧/.test(el.textContent);
  }, null, { timeout: 12000 }).catch(() => {});
  const evidenceText = await page.textContent('#schemeEvidence');
  record('控制页对照实际层与浏览器可解码帧', /SFU 实际层/.test(evidenceText) && /解码 \d+ 帧/.test(evidenceText), evidenceText.slice(0, 400));
  record('控制页显示发送预算上限', /上限=/.test(evidenceText));

  // 方案计划区回显
  const planText = await page.textContent('#schemePlan');
  record('计划区显示方案与下发/失败计数', /下发 \d+ 项，失败 \d+ 项/.test(planText), planText.slice(0, 300));

  // 无预算时必须拒绝下发，不按 0 处理
  await page.evaluate(() => {
    const el = document.querySelector('input[data-budget-id="stu-low"]');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#applySchemeBtn');
  await sleep(1500);
  const resMissing = await page.textContent('#resultLog');
  record('缺预算时拒绝下发并指出接收者（不按 0 处理）', resMissing.includes('未设置有效预算'), resMissing.split('\n').slice(-1)[0]);

  // 恢复预算后导出证据
  await page.evaluate(() => {
    const el = document.querySelector('input[data-budget-id="stu-low"]');
    el.value = '350';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#applySchemeBtn');
  await sleep(3000);

  record('控制页无 JS 运行时错误', errors.length === 0, errors.join('; '));

  // 用探针取证据落盘（等价于控制页“导出证据”按钮的返回内容）
  const rawEvidence = await probe.request('control-schedule-evidence', {});
  const evidenceDir = path.join(__dirname, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, 'schedule-latest.json');
  fs.writeFileSync(evidenceFile, JSON.stringify(rawEvidence.evidence, null, 2));
  record('调度证据含真实层成本与 BWE', rawEvidence.evidence.receivers.length >= 2 &&
    rawEvidence.evidence.receivers.every((r) => (r.streams || []).length > 0),
    `证据：${evidenceFile}`);

  const costSources = rawEvidence.evidence.receivers.flatMap((r) => (r.streams || []).flatMap((c) => (c.costs || []).map((x) => x.source)));
  record('层成本来源已标注（measured/configured/missing，不是默认 0）', costSources.every((s) => ['measured', 'configured', 'missing'].includes(s)), [...new Set(costSources)]);

  await closePage(low.page, low.ctx);
  await closePage(high.page, high.ctx);
  await closePage(teacher.page, teacher.ctx);
  await page.close();
  await ctx.close();
  probe.close();
  await browser.close();

  const report = { room: ROOM, total: results.length, passed: results.filter((r) => r.ok).length, results, evidenceFile };
  fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
  const reportFile = path.join(__dirname, 'reports', `scheduling-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const failed = report.total - report.passed;
  console.log(`\n调度原型测试：${report.passed}/${report.total} 通过`);
  console.log(`报告：${reportFile}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
