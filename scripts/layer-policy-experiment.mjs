#!/usr/bin/env node
// 分层策略试验（多人带宽分化）：用同一带宽轨迹推演两个调度原型。
//
// 数据来源（缺一不可，不用默认值遮错）：
//   1) 先跑 control-page / 手动操作，让控制页“导出证据”把 mediasoup 真实
//      producer.getStats().bitrateByLayer 与接收 Transport BWE 写成 JSON；
//   2) 本脚本用同一份轨迹，对两个方案逐时隙重放，输出每个接收者的
//      请求层、发送预算、可解码层来源、是否发生组内退化。
//
// 用法：
//   node scripts/layer-policy-experiment.mjs --evidence <evidence.json> \
//        --trajectory <trajectory.json> --out <report.json>
// 轨迹格式：{ "audioReserveBps": 48000, "slots": [ { "t": 0, "budgets": { "stu-A": 300000, ... } }, ... ] }
// 若预算某学生缺项，则该时隙对该学生标记 budget-unset（不按 0 处理）。

import fs from 'node:fs';
import path from 'node:path';
import { planScheme } from '../server/scheduler.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    out[k.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

function loadJson(file, label) {
  if (!file) throw new Error(`缺少 ${label} 文件参数`);
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label} 文件不存在：${resolved}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`${label} 文件不是合法 JSON：${err.message}`);
  }
}

// 把证据里的一个学生展开成 scheduler 需要的“接收者”：预算跟人走，
// 选层按该接收 Transport 上全部视频的合计成本（与 Room.applySchedulingScheme 一致）。
// 证据里 streams[].scheduled 标记本轮是否被调度；导出证据默认调度全部视频。
function buildReceivers(evidence) {
  const receivers = [];
  for (const receiver of evidence.receivers || []) {
    if (!Array.isArray(receiver.streams) || !receiver.streams.length) continue;
    const recv = (receiver.transports || []).find((t) => t.availableOutgoingBitrate != null)
      || (receiver.transports || [])[0] || null;
    receivers.push({
      peerId: receiver.peerId,
      transportId: recv?.id ?? null,
      bweBps: recv?.availableOutgoingBitrate ?? null,
      streams: receiver.streams.map((s) => ({
        consumerId: s.consumerId,
        producerId: s.producerId,
        label: s.label || '',
        scheduled: s.scheduled !== false,
        costs: s.costs,
        currentCostBps: s.currentCostBps ?? null,
        currentCostSource: s.currentCostSource || 'missing',
      })),
    });
  }
  return receivers;
}

function runTrajectory(evidence, trajectory, scheme) {
  const receivers = buildReceivers(evidence);
  if (!receivers.length) throw new Error('证据文件里没有任何视频订阅成本样本');
  const audioReserveBps = trajectory.audioReserveBps ?? evidence.audioReserveBps ?? 48000;
  const transportOverhead = trajectory.transportOverhead ?? evidence.transportOverhead ?? 0.08;
  const slotsOut = [];
  for (const slot of trajectory.slots || []) {
    const budgets = slot.budgets || {};
    const plannedInputs = receivers.map((r) => ({
      ...r,
      budgetBps: Number.isFinite(budgets[r.peerId]) ? budgets[r.peerId] : null,
      budgetSource: Number.isFinite(budgets[r.peerId]) ? 'trajectory' : 'unset',
    }));
    const plan = planScheme(scheme, plannedInputs, { audioReserveBps, transportOverhead });
    slotsOut.push({
      t: slot.t ?? slotsOut.length,
      budgets,
      plan,
    });
  }
  return { scheme, audioReserveBps, transportOverhead, slots: slotsOut };
}

function summarize(result) {
  const perPeer = new Map();
  for (const slot of result.slots) {
    for (const r of slot.plan.receivers) {
      if (!perPeer.has(r.peerId)) perPeer.set(r.peerId, { layers: [], caps: [], scores: [], t: [], costSources: new Set() });
      const rec = perPeer.get(r.peerId);
      rec.t.push(slot.t);
      rec.layers.push(r.requestedSpatialLayer);
      rec.caps.push(r.capBps);
      rec.scores.push(r.score);
      if (r.costSource) rec.costSources.add(r.costSource);
    }
  }
  const summary = {};
  for (const [peerId, rec] of perPeer) {
    summary[peerId] = {
      slots: rec.t,
      layers: rec.layers,
      capBps: rec.caps,
      scoreAvg: rec.scores.length
        ? Number((rec.scores.reduce((a, b) => a + (b || 0), 0) / rec.scores.length).toFixed(3))
        : null,
      costSources: [...rec.costSources],
      layerChanges: rec.layers.reduce((n, v, i) => (i && v !== rec.layers[i - 1] ? n + 1 : n), 0),
    };
  }
  return summary;
}

const args = parseArgs(process.argv.slice(2));
const evidence = loadJson(args.evidence, '--evidence');
const trajectory = loadJson(args.trajectory, '--trajectory');

const perReceiver = runTrajectory(evidence, trajectory, 'per-receiver');
const groupShared = runTrajectory(evidence, trajectory, 'group-shared');

const report = {
  generatedAt: new Date().toISOString(),
  evidenceRoom: evidence.roomId || null,
  evidenceAt: evidence.at || null,
  trajectorySlotCount: (trajectory.slots || []).length,
  schemes: {
    'per-receiver': { ...perReceiver, summary: summarize(perReceiver) },
    'group-shared': { ...groupShared, summary: summarize(groupShared) },
  },
};

const missingCost = [];
for (const receiver of evidence.receivers || []) {
  for (const c of receiver.streams || []) {
    if ((c.costs || []).every((x) => x.source === 'missing')) {
      missingCost.push(`${receiver.peerId}/${c.label}`);
    }
  }
}
report.missingCosts = missingCost;
if (missingCost.length) {
  console.warn(`警告：以下订阅没有可用层成本，试验中不会被当作 0 参与选层：${missingCost.join(', ')}`);
}

if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));
  console.log(`分层策略试验报告已写入 ${path.resolve(args.out)}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
