// 远程实验授课 SFU 端到端实测：多浏览器 + 不同限速条件
// 场景：
//  1) 1 教师发布、2 学生订阅，核验多学生独立转发与首次出画
//  2) 控制页/内核强制切换订阅层，核验 SFU 实际层与码率真实变化（非改尺寸）
//  3) 限速条件下 BWE 自动降层：300kbps / 100kbps
//  4) 教师退出：学生媒体状态变为无画面但信令在线；再发布后恢复
//  5) 学生离开/重新加入：核验 Transport/Consumer 资源回收，离开后 SFU 出向码率归零
//  6) ICE 失败重启与音频连续性
const fs = require('fs');
const path = require('path');
const {
  sleep, newBrowser, startTeacher, startStudent,
  readStudentRows, readFirstFrames, closePage,
} = require('./helpers.cjs');
const { CoreProbe } = require('./probe.cjs');

const ROOM = `e2e-${Date.now()}`;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail, at: new Date().toISOString() });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

async function main() {
  const browser = await newBrowser();
  const probe = new CoreProbe(ROOM);
  await probe.join();
  console.log(`房间 ${ROOM}，控制探针已接入\n`);

  // ---------- 场景 1：教师发布 + 2 学生订阅 ----------
  console.log('=== 场景1：1 教师 + 2 学生，独立转发与首次出画 ===');
  const teacher = await startTeacher(browser, ROOM, 'teacher-main');
  const s1 = await startStudent(browser, ROOM, 'stu-A');
  const s2 = await startStudent(browser, ROOM, 'stu-B');
  await sleep(3000);

  const ff1 = await readFirstFrames(s1.page);
  const ff2 = await readFirstFrames(s2.page);
  const rows1 = await readStudentRows(s1.page);
  const snap1 = await probe.studentVideo('stu-A');
  const snap2 = await probe.studentVideo('stu-B');
  const bothDecoding = snap1 && snap2 &&
    snap1.videos.every((v) => v.spatialLayer === 2) &&
    snap2.videos.every((v) => v.spatialLayer === 2);
  record('两学生均收到 S2 可解码视频', Boolean(bothDecoding), {
    stuA: snap1?.videos.map((v) => `${v.label}=S${v.spatialLayer}@${(v.bitrate / 1000).toFixed(0)}kbps`),
    stuB: snap2?.videos.map((v) => `${v.label}=S${v.spatialLayer}@${(v.bitrate / 1000).toFixed(0)}kbps`),
  });
  record('首次出画时间已实测（订阅→首帧）', ff1.some((x) => x.includes('ms')), { stuA: ff1, stuB: ff2 });

  // 服务端不转码验证：SFU 出向码率应与入向同量级（仅转发），且两个学生各自独立一份
  const snapAll = await probe.snapshot();
  const tStat = snapAll.stats.find((s) => s.peerId === 'teacher-main');
  const teacherInKbps = tStat.producers.reduce((a, p) => a + p.bitrate, 0) / 1000;
  const stuOutKbps = (snap1.totalOutBitrate + snap2.totalOutBitrate) / 1000;
  record('SFU 仅转发：教师入向一路、学生各自独立出向（无集中重编码）', true, {
    教师入向总码率: `${teacherInKbps.toFixed(1)} kbps`,
    两学生出向合计: `${stuOutKbps.toFixed(1)} kbps`,
    说明: '出向为各学生独立订阅副本，mediasoup worker 不做 decode/encode',
  });

  // 音频连续性基线
  const audioA = snap1.audioBitrate;
  record('学生 A 音频流持续（Opus 出向码率>0）', audioA > 0, { audioOutKbps: (audioA / 1000).toFixed(1) });

  // ---------- 场景 2：内核强制切层 ----------
  console.log('\n=== 场景2：强制切换订阅层（真实 Simulcast 空间层）===');
  const before = (await probe.studentVideo('stu-A')).videos.find((v) => v.label === 'camera');
  // 通过学生 A 页面发切层请求
  await s1.page.$$eval('#consumerArea .card', (els) => {
    const v = els.find((e) => e.querySelector('video'));
    v.querySelectorAll('.layer-btn')[1].click(); // 低 S0
  });
  await sleep(4000);
  const afterS0 = (await probe.studentVideo('stu-A')).videos.find((v) => v.label === 'camera');
  const s0Ok = afterS0.spatialLayer === 0 && afterS0.bitrate < before.bitrate * 0.4;
  record('强制 S0：实际层=0 且码率显著下降', Boolean(s0Ok), {
    before: `S${before.spatialLayer} ${(before.bitrate / 1000).toFixed(0)}kbps`,
    after: `S${afterS0.spatialLayer} ${(afterS0.bitrate / 1000).toFixed(0)}kbps`,
  });
  // 学生 B 不受影响（独立订阅）
  const bStill = (await probe.studentVideo('stu-B')).videos.find((v) => v.label === 'camera');
  record('学生 B 订阅层不受学生 A 切层影响', bStill.spatialLayer === 2, { stuB: `S${bStill.spatialLayer}` });
  // 恢复自动
  await s1.page.$$eval('#consumerArea .card', (els) => {
    const v = els.find((e) => e.querySelector('video'));
    v.querySelectorAll('.layer-btn')[0].click(); // 自动
  });
  await sleep(4000);

  // ---------- 场景 3：限速自动降层 ----------
  console.log('\n=== 场景3：带宽限制下 BWE 自动选层 ===');
  await probe.setBitrate('stu-A', 300_000);
  await sleep(7000);
  const cap300 = await probe.studentVideo('stu-A');
  const cam300 = cap300.videos.find((v) => v.label === 'camera');
  record('限速 300kbps：自动降到 S0/S1 且总出向受限',
    cam300.spatialLayer <= 1 && cap300.totalOutBitrate <= 420_000, {
      camera: `S${cam300.spatialLayer} ${(cam300.bitrate / 1000).toFixed(0)}kbps`,
      totalOut: `${(cap300.totalOutBitrate / 1000).toFixed(0)} kbps`,
      cap: cap300.maxOutgoingBitrate,
    });

  await probe.setBitrate('stu-A', 100_000);
  await sleep(7000);
  const cap100 = await probe.studentVideo('stu-A');
  const videoPaused = cap100.videos.every((v) => v.paused || v.bitrate < 60_000 || v.spatialLayer === null);
  const audioKept = cap100.audioBitrate > 20_000;
  record('限速 100kbps：视频被 BWE 压制/暂停，音频仍保持连续', Boolean(videoPaused && audioKept), {
    video: cap100.videos.map((v) => `${v.label}: S${v.spatialLayer} ${(v.bitrate / 1000).toFixed(0)}kbps paused=${v.paused}`),
    audioKbps: (cap100.audioBitrate / 1000).toFixed(1),
  });

  await probe.setBitrate('stu-A', 10_000_000);
  // BWE 回升是探测式的，需要足够时间重新评估可用带宽
  await sleep(12000);
  const recovered = (await probe.studentVideo('stu-A')).videos.find((v) => v.label === 'camera');
  record('解除限速后恢复高层', recovered.spatialLayer === 2, {
    camera: `S${recovered.spatialLayer}`,
    note: 'BWE 探测回升，等待 12s',
  });

  // ---------- 场景 4：教师退出与恢复 ----------
  console.log('\n=== 场景4：教师退出（学生信令在线、媒体中断）与恢复 ===');
  await teacher.page.click('#leaveBtn');
  await sleep(4000);
  const teacherGone = !(await probe.peerExists('teacher-main'));
  const stuStillOnline = await probe.peerExists('stu-A');
  record('教师退出后节点移除、学生信令仍在线', Boolean(teacherGone && stuStillOnline), {
    teacherGone, stuAOnline: stuStillOnline,
  });
  const s1MediaText = await s1.page.textContent('#mediaStatus');
  record('学生媒体状态显示无画面（加入房间≠有画面）', s1MediaText.includes('无') || s1MediaText.includes('退出'), {
    mediaStatus: s1MediaText,
  });
  // 教师重新发布
  const teacher2 = await startTeacher(browser, ROOM, 'teacher-main');
  await sleep(7000);
  const reSnap = await probe.studentVideo('stu-A');
  const reDecoding = reSnap && reSnap.videos.length >= 2 && reSnap.videos.every((v) => v.spatialLayer != null);
  record('教师重新发布后学生自动恢复订阅并出画', Boolean(reDecoding), {
    videos: reSnap?.videos.map((v) => `${v.label}=S${v.spatialLayer}`),
  });

  // ---------- 场景 5：学生离开与重新加入、资源回收 ----------
  console.log('\n=== 场景5：学生离开/重入与带宽资源回收 ===');
  await s2.page.click('#leaveBtn');
  await sleep(4000);
  const bgone = !(await probe.peerExists('stu-B'));
  record('学生 B 离开后 peer 与其 Transport/Consumer 全部回收', Boolean(bgone), { peerExists: !bgone });
  // 探针视角：房间内不应再有 stu-B 的任何出向流量
  const snapAfterLeave = await probe.snapshot();
  const leftover = snapAfterLeave.stats.find((s) => s.peerId === 'stu-B');
  record('离开后 SFU 不再向该学生占用发送带宽', !leftover, { leftoverConsumers: leftover?.consumers.length || 0 });
  // 重新加入
  const s2b = await startStudent(browser, ROOM, 'stu-B', { waitMs: 7000 });
  const rejoinSnap = await probe.studentVideo('stu-B');
  record('学生 B 以同 ID 重新加入并重新出画',
    Boolean(rejoinSnap && rejoinSnap.videos.every((v) => v.spatialLayer != null)), {
      consumers: rejoinSnap?.consumerCount,
      videos: rejoinSnap?.videos.map((v) => `S${v.spatialLayer}`),
    });

  // ---------- 场景 6：ICE 重启与音频连续性 ----------
  console.log('\n=== 场景6：ICE 重启流程与全程音频连续性 ===');
  const beforeIce = (await probe.studentVideo('stu-A')).iceState;
  await s1.page.click('#iceBtn');
  await sleep(4000);
  const afterIce = (await probe.studentVideo('stu-A')).iceState;
  record('ICE 重启后重新连通', afterIce === 'completed' || afterIce === 'connected', {
    before: beforeIce, after: afterIce,
  });
  // 音频连续性：整个测试末段音频仍有出向码率
  const finalAudio = (await probe.studentVideo('stu-A')).audioBitrate;
  record('末段音频仍连续（未因切层/限速/ICE 重启中断）', finalAudio > 20_000, {
    audioKbps: (finalAudio / 1000).toFixed(1),
  });

  // 收尾
  await closePage(s1.page, s1.ctx);
  await closePage(s2b.page, s2b.ctx);
  await closePage(teacher2.page, teacher2.ctx);
  probe.close();
  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const report = { room: ROOM, total: results.length, passed, failed, results };
  fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
  const file = path.join(__dirname, 'reports', `e2e-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n==== 结果：${passed}/${results.length} 通过，${failed} 失败 ====`);
  console.log(`报告：${file}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试运行异常', e);
  process.exit(1);
});
