// 流媒体控制页专项：验证控件由 mediasoup 内核驱动、结果回显、失败反馈
const {
  sleep, newBrowser, startTeacher, startStudent, closePage,
} = require('./helpers.cjs');

const ROOM = `ctrl-${Date.now()}`;

(async () => {
  const browser = await newBrowser();
  const teacher = await startTeacher(browser, ROOM, 'teacher-ctrl');
  const student = await startStudent(browser, ROOM, 'stu-ctrl');
  await sleep(3000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:3000/control.html');
  await page.fill('#roomId', ROOM);
  await page.click('#connectBtn');
  await sleep(2000);

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  };

  // 1) 内核快照渲染出教师与学生
  const overview = await page.textContent('#roomOverview');
  check('控制页展示内核节点（教师+学生）', overview.includes('teacher-ctrl') && overview.includes('stu-ctrl'));

  // 2) 选择学生与视频 consumer
  await page.waitForFunction(() => document.querySelectorAll('#targetConsumer option').length > 0, null, { timeout: 8000 });
  const consumerOptions = await page.$$eval('#targetConsumer option', (o) => o.map((x) => x.textContent));
  check('目标订阅下拉由内核 consumer 填充', consumerOptions.length >= 1, JSON.stringify(consumerOptions));

  // 3) 内核驱动强制低层，结果区回显成功
  await page.click('[data-act="layer"][data-layer="0"]');
  await sleep(4000);
  const resultText1 = await page.textContent('#resultLog');
  const detail = await page.textContent('#detailArea');
  check('强制 S0 经内核成功并回显', resultText1.includes('内核操作成功') && detail.includes('低 (S0)'));

  // 4) 恢复自动
  await page.click('[data-act="layer-auto"]');
  await sleep(3000);
  const resultText2 = await page.textContent('#resultLog');
  check('恢复自动经内核成功', resultText2.includes('自动选层') && resultText2.includes('成功'));

  // 5) 内核驱动带宽限制
  await page.selectOption('#presetBitrate', '300000');
  await page.click('[data-act="bitrate"]');
  await sleep(6000);
  const resultText3 = await page.textContent('#resultLog');
  const overviewAfter = await page.textContent('#roomOverview');
  check('带宽限制经内核生效并在总览显示上限',
    resultText3.includes('300kbps') && overviewAfter.includes('300 kbps'));

  // 6) 失败反馈：学生离开后目标选择器清空，再操作必须有明确错误回显（不静默）
  await closePage(student.page, student.ctx);
  await sleep(3000);
  const peerOptionsAfterLeave = await page.$$eval('#targetPeer option', (o) => o.map((x) => x.value));
  await page.click('[data-act="bitrate"]').catch(() => {});
  await sleep(1500);
  const resultText4 = await page.textContent('#resultLog');
  check('学生离开后选择器清空且操作有失败反馈回控制页',
    peerOptionsAfterLeave.length === 0 && (resultText4.includes('请先选择目标学生') || resultText4.includes('内核操作失败')));

  check('控制页无 JS 运行时错误', errors.length === 0, errors.join('; '));

  await closePage(teacher.page, teacher.ctx);
  await page.close();
  await ctx.close();
  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n控制页测试：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
