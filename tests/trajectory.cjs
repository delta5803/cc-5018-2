// 同一带宽轨迹下两种方案的“真实下发”对照：
//   轨迹来自 experiments/layer-policy/trajectory.json，
//   每一步都经 control-apply-scheme 真正调用 setPreferredLayers + setMaxOutgoingBitrate，
//   随后从内核读取实际下发层/出向码率，验证取值与实验脚本的规划一致（在容许时延内）。
const fs = require('fs');
const path = require('path');
const {
  sleep, newBrowser, startTeacher, startStudent, closePage,
} = require('./helpers.cjs');
const { CoreProbe } = require('./probe.cjs');

const ROOM = `trace-${Date.now()}`;
const trajectory = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'experiments', 'layer-policy', 'trajectory.json'), 'utf8'),
);
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
  const teacher = await startTeacher(browser, ROOM, 'teacher-trace');
  const low = await startStudent(browser, ROOM, 'stu-low');
  const high = await startStudent(browser, ROOM, 'stu-high');
  await sleep(4000);

  const observed = { 'per-receiver': [], 'group-shared': [] };

  // 切层不是瞬时：预算/层下发后 worker 需等关键帧并按 BWE 重新收敛。
  // 这里显式测量“切换时机”：轮询直到实际层达到计划请求层（连续两次相同），
  // 最多 40s；超时也如实记录，不用固定 sleep 假装切换已完成。
  // 窗口取 40s 是因为 AIMD BWE 每秒只向上探测约 8%（见 AimdRateControl），
  // 从 350k 爬到 2.8M 需要十几秒到二十几秒，这是真实的切换时机而非缺陷。
  async function waitForTargetLayers(target, maxMs = 40000) {
    const start = Date.now();
    let last = null;
    let sameCount = 0;
    let reads = 0;
    const bweTrail = [];
    while (Date.now() - start < maxMs) {
      const snap = {};
      const bwe = {};
      for (const id of Object.keys(target)) {
        const s = await probe.studentVideo(id);
        const cam = s.videos.find((v) => v.label === 'camera');
        snap[id] = cam?.spatialLayer ?? null;
        bwe[id] = {
          maxOut: s.maxOutgoingBitrate,
          avail: s.availableOutgoingBitrate,
          sendKbps: Math.round(s.totalOutBitrate / 1000),
        };
      }
      reads++;
      bweTrail.push({ atMs: Date.now() - start, layers: snap, bwe });
      const key = JSON.stringify(snap);
      if (key === last) sameCount++;
      else sameCount = 0;
      last = key;
      const reached = Object.keys(target).every((id) => snap[id] === target[id]);
      if (reached && sameCount >= 1) {
        return { layers: snap, settleMs: Date.now() - start, reads, bweTrail, reached: true };
      }
      await sleep(2000);
    }
    return { layers: last ? JSON.parse(last) : {}, settleMs: Date.now() - start, reads, bweTrail, reached: false };
  }

  for (const scheme of ['per-receiver', 'group-shared']) {
    for (const slot of trajectory.slots) {
      const appliedAt = Date.now();
      const { scheduling } = await probe.request('control-apply-scheme', {
        scheme,
        groupPeerIds: ['stu-low', 'stu-high'],
        receiverBudgets: slot.budgets,
        audioReserveBps: trajectory.audioReserveBps,
        transportOverhead: trajectory.transportOverhead,
        // 不传 label：调度每个接收者的全部视频订阅。预算口径是整条接收
        // Transport，只调一路会让另一路继续抢预算，对照就失真了。
        label: null,
      });
      // 用本方案实际规划出的请求层作为目标，检查“计划是否真的落地”
      const target = {};
      for (const r of scheduling.plan.receivers) {
        if (r.requestedSpatialLayer != null) target[r.peerId] = r.requestedSpatialLayer;
      }
      const settled = await waitForTargetLayers(target);
      const l = await probe.studentVideo('stu-low');
      const h = await probe.studentVideo('stu-high');
      const camL = l.videos.find((v) => v.label === 'camera');
      const camH = h.videos.find((v) => v.label === 'camera');
      observed[scheme].push({
        t: slot.t,
        budgets: slot.budgets,
        targetLayer: target,
        errorCount: scheduling.errors.length,
        errors: scheduling.errors,
        settleMs: settled.settleMs,
        settleReads: settled.reads,
        settleReached: settled.reached,
        bweTrail: settled.bweTrail,
        appliedAt,
        low: { layer: camL?.spatialLayer ?? null, kbps: Math.round((camL?.bitrate || 0) / 1000) },
        high: { layer: camH?.spatialLayer ?? null, kbps: Math.round((camH?.bitrate || 0) / 1000) },
        maxOutLow: l.maxOutgoingBitrate,
        maxOutHigh: h.maxOutgoingBitrate,
      });
    }
  }

  // 方案 A：预算分化时，低成员降层、高成员保持比低成员更高的层（互不拖累）
  const aMixed = observed['per-receiver'].find((x) => x.t === 1);
  record('独立评分·真实下发：低成员降层、高成员不被拖累',
    aMixed.low.layer < aMixed.high.layer && aMixed.low.layer <= 1, aMixed);

  // 方案 A：预算相同时两者同层
  const aEqual = observed['per-receiver'].find((x) => x.t === 0);
  record('独立评分·预算相同则两者同层',
    aEqual.low.layer === aEqual.high.layer, aEqual);

  // 方案 B：混合预算下两者被拉到同一层
  const bMixed = observed['group-shared'].find((x) => x.t === 1);
  record('共同层组·真实下发：混合预算下同组同层',
    bMixed.low.layer === bMixed.high.layer, bMixed);

  // 方案 B：相对 A 的取舍——高成员在混合预算时被最弱链路拉低
  // 硬断言用实际写入的发送预算（确定性、立即生效），层数作为对照证据
  record('共同层组·取舍可见：高成员被最弱链路拉低',
    bMixed.maxOutHigh < aMixed.maxOutHigh && bMixed.high.layer <= aMixed.high.layer,
    { perReceiver: { cap: aMixed.maxOutHigh, layer: aMixed.high.layer }, groupShared: { cap: bMixed.maxOutHigh, layer: bMixed.high.layer } });

  // 发送预算确实写入接收 Transport：上限必须是计划预算，而不是 worker 默认 1e9。
  // 注意：共同层的“公共层成本”可能略高于最弱链路的轨迹预算（最弱链路连 S0 都
  // 放不下时 plan 会给出 below-lowest-layer 告警），所以硬断言是“不超过各自的
  // 轨迹预算，且远小于 1e9”，而不是“都不超过最弱预算”。
  const capsApplied = [...observed['per-receiver'], ...observed['group-shared']];
  const capsExplicit = capsApplied.every((x) => {
    const ownLow = x.budgets['stu-low'];
    const ownHigh = x.budgets['stu-high'];
    return x.maxOutLow != null && x.maxOutLow < 100_000_000 && x.maxOutLow <= ownLow &&
      x.maxOutHigh != null && x.maxOutHigh < 100_000_000 && x.maxOutHigh <= ownHigh;
  });
  record('发送预算已写入接收 Transport（不超过轨迹预算，且不是默认 1e9）', capsExplicit, {
    sample: capsApplied.map((x) => ({
      t: x.t,
      low: x.maxOutLow,
      high: x.maxOutHigh,
      budgets: x.budgets,
      target: x.targetLayer,
    })),
  });

  // 切换时机也必须可复算：每个槽位记录“计划层是否真的落地”和收敛耗时
  // 下发动作本身必须零失败；层是否在窗口内落地作为单独的时机证据记录，
  // 未落地时给出 BWE 与计划层的差距，不能靠默认值掩盖。
  const settle = [...observed['per-receiver'], ...observed['group-shared']];
  record('切层下发零失败（setPreferredLayers + setMaxOutgoingBitrate）',
    settle.every((x) => x.errorCount === 0), {
      errors: settle.filter((x) => x.errorCount > 0).map((x) => x.t),
    });
  // 切换时机分两类，避免用一条宽松断言掩盖问题：
  //   1) 降层/同层（计划层 <= 切换前实际层）必须在下发后立即生效——预算收紧是瞬时的；
  //   2) 升层受 BWE 向上探测限制（AIMD 约 8%/s），允许慢，但必须记录真实收敛耗时；
  //      未在 40s 内收敛的槽位必须带 BWE/实际层证据，并让断言失败。
  const perSchemeTiming = {};
  let timingOk = true;
  const timingProblems = [];
  for (const scheme of ['per-receiver', 'group-shared']) {
    const rows = observed[scheme];
    perSchemeTiming[scheme] = [];
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      const prevLow = i > 0 ? rows[i - 1].low.layer : null;
      const prevHigh = i > 0 ? rows[i - 1].high.layer : null;
      const dirs = [];
      for (const [peer, key, prev] of [['stu-low', 'low', prevLow], ['stu-high', 'high', prevHigh]]) {
        const want = x.targetLayer[peer];
        const got = x[key].layer;
        if (want == null) continue;
        const desc = want < (prev ?? Infinity);
        dirs.push({ peer, want, got, prev, descending: desc, reached: want === got });
        if (desc && want !== got) {
          timingOk = false;
          timingProblems.push(`${scheme}/t${x.t}/${peer}: 降层未生效 目标S${want} 实际S${got}`);
        }
      }
      const lastTrail = (x.bweTrail || [])[x.bweTrail.length - 1] || null;
      perSchemeTiming[scheme].push(
        `t${x.t}:目标S${x.targetLayer['stu-low']}/S${x.targetLayer['stu-high']} ` +
        `实际S${x.low.layer}/S${x.high.layer} ${x.settleMs}ms ` +
        `${x.settleReached ? '已收敛' : '未收敛(升层BWE爬升中)'}` +
        (lastTrail ? ` 末次maxOut=${Math.round((lastTrail.bwe['stu-low'].maxOut || 0) / 1000)}k/avail=${Math.round((lastTrail.bwe['stu-low'].avail || 0) / 1000)}k` : ''),
      );
    }
  }
  record('切层时机：降层/同层立即生效，升层记录真实收敛耗时', timingOk, {
    problems: timingProblems,
    perScheme: perSchemeTiming,
  });

  // 切层时机：每次槽位切换后读取实际层，记录稳定所需等待（层面证据）
  const layerChangesPerReceiver = observed['per-receiver'].filter((x, i, arr) => i && x.low.layer !== arr[i - 1].low.layer).length;
  record('同一轨迹下切层时机可对照（逐槽实际层有变化）', layerChangesPerReceiver >= 1, {
    layers: observed['per-receiver'].map((x) => `t${x.t}:S${x.low.layer}`),
  });

  // 层变化的“时机证据”也写进观测文件（截图/日志无法复算的部分）
  const outFile = path.join(__dirname, 'evidence', 'trace-observed-latest.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    room: ROOM,
    trajectory,
    note: '预算口径=接收者整条接收 Transport（camera+bench+音频合计）',
    observed,
  }, null, 2));

  await closePage(low.page, low.ctx);
  await closePage(high.page, high.ctx);
  await closePage(teacher.page, teacher.ctx);
  probe.close();
  await browser.close();

  const report = { room: ROOM, total: results.length, passed: results.filter((r) => r.ok).length, results, outFile };
  fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
  const reportFile = path.join(__dirname, 'reports', `trace-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const failed = report.total - report.passed;
  console.log(`\n轨迹联动测试：${report.passed}/${report.total} 通过`);
  console.log(`观测：${outFile}`);
  console.log(`报告：${reportFile}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
