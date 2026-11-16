// 两个分层调度原型（纯计算，不直接操作 mediasoup）。
//
// 真正的包转发入口在 Room.applySchedulingScheme()：
//   Consumer.setPreferredLayers({spatialLayer}) -> worker 选择实际转发的空间层
//   WebRtcTransport.setMaxOutgoingBitrate(bps)  -> 该接收 Transport 的出向预算
// 本文件只把“测量到的层成本 + 接收者预算”换算成逐 Consumer 的决策，
// 便于单元测试与实验复算；不做任何前端质量标签。
//
// 预算口径（关键，曾被写错）：
//   setMaxOutgoingBitrate 限制的是“整条接收 Transport”的出向码率，
//   而一个学生通常在一条 Transport 上同时订阅 camera / bench / 音频。
//   因此选层必须按“该接收者全部被调度视频在该层的成本之和 + 音频预留”
//   去和预算比较，不能把每路 Consumer 都当成独占全预算。
//
// 层成本来源必须显式标注：
//   measured   = mediasoup producer.getStats() 实测
//   configured = 发送端 encodings.maxBitrate（声明值，属假设，需待验）
//   missing    = 两者都没有，绝不能当成 0 参与决策
export const SCHEMES = {
  'per-receiver': {
    id: 'per-receiver',
    name: '按接收者独立评分',
    summary:
      '每个接收者用自己的预算独立选层；低带宽学生只压低自己，不影响高带宽学生的层。',
  },
  'group-shared': {
    id: 'group-shared',
    name: '按共同层组分配预算',
    summary:
      '全组必须落在同一个人人都放得下的公共层；高带宽成员被最弱链路拖低。',
  },
};

// 音频预留是调度参数，不是隐藏默认：随计划一并返回，实验与界面都能看到。
export const DEFAULT_AUDIO_RESERVE_BPS = 48_000;

// 传输开销系数：mediasoup 的层成本来自 RTP 载荷统计，而 setMaxOutgoingBitrate
// 限制的是 SRTP/UDP/IP 出向总量，且重传、RTCP 也要占预算。cap 恰好等于层成本
// 时，worker 会认为“挤不下”而长期停在低一层。这里显式留 8% 余量，并随计划返回，
// 属于可审计的调度参数（不是隐藏默认）。
export const DEFAULT_TRANSPORT_OVERHEAD = 0.08;

function withOverhead(videoPlusAudioBps, overhead) {
  return Math.ceil(videoPlusAudioBps * (1 + overhead));
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function normalizeCosts(costs) {
  if (!Array.isArray(costs)) return [];
  return costs
    .filter((c) => c && Number.isFinite(c.spatialLayer) && c.spatialLayer >= 0)
    .map((c) => ({
      spatialLayer: c.spatialLayer,
      bps: Number.isFinite(c.bps) && c.bps > 0 ? c.bps : null,
      source: c.bps > 0 ? c.source || 'missing' : 'missing',
      configuredBps: Number.isFinite(c.configuredBps) ? c.configuredBps : null,
      measuredBps: Number.isFinite(c.measuredBps) ? c.measuredBps : null,
    }))
    .sort((a, b) => a.spatialLayer - b.spatialLayer);
}

// 一路视频在某一层的成本；缺成本返回 null（不按 0 处理）
function costAt(costs, spatialLayer) {
  const hit = costs.find((c) => c.spatialLayer === spatialLayer);
  return hit && hit.bps != null ? hit : null;
}

// 接收者在某层的合计成本 = 所有被调度视频在该层的成本之和，再加未调度视频的当前成本，
// 再加音频预留，最后乘传输开销系数（cap 是 IP 出向总量，不是纯 RTP 载荷）。
// 任一被调度视频缺该层成本 -> 该层不可用（返回 null），不能拿部分和去比预算。
function receiverCostAt(receiver, spatialLayer, audioBps, overhead) {
  let sum = 0;
  const sources = new Set();
  let missing = null;
  for (const stream of receiver.streams) {
    if (!stream.scheduled) continue;
    const c = costAt(stream.costs, spatialLayer);
    if (!c) {
      missing = stream.label || stream.consumerId;
      continue;
    }
    sum += c.bps;
    sources.add(c.source);
  }
  if (missing != null) return null;
  // 未调度的同 Transport 视频仍在真实出向里，按其当前层成本计入
  for (const stream of receiver.streams) {
    if (stream.scheduled) continue;
    if (stream.currentCostBps != null) {
      sum += stream.currentCostBps;
      if (stream.currentCostSource) sources.add(stream.currentCostSource);
    }
  }
  const total = withOverhead(sum + audioBps, overhead);
  return {
    bps: total,
    videoBps: sum,
    overhead,
    sources: [...sources],
    // configured 只要混进来就必须标出来，界面上不能当成实测
    source: sources.has('configured') ? 'configured' : sources.has('measured') ? 'measured' : 'missing',
  };
}

function maxCost(costs) {
  const values = costs.map((c) => c.bps).filter((v) => Number.isFinite(v) && v > 0);
  return values.length ? Math.max(...values) : null;
}

// 在接收者自己的预算下选最高可负担层（成本已含音频预留与传输开销）
function pickReceiverLayer(receiver, budgetBps, audioBps, overhead) {
  const layers = new Set();
  for (const s of receiver.streams) {
    if (!s.scheduled) continue;
    for (const c of s.costs) if (c.bps != null) layers.add(c.spatialLayer);
  }
  const descending = [...layers].sort((a, b) => b - a);
  for (const layer of descending) {
    const cost = receiverCostAt(receiver, layer, audioBps, overhead);
    if (!cost) continue;
    if (cost.bps <= budgetBps) {
      return { spatialLayer: layer, cost, reason: 'budget-fits' };
    }
  }
  const lowest = descending.length ? descending[descending.length - 1] : 0;
  return { spatialLayer: lowest, cost: receiverCostAt(receiver, lowest, audioBps, overhead), reason: 'below-lowest-layer' };
}

function receiverTopCost(receiver, audioBps, overhead) {
  const layers = new Set();
  for (const s of receiver.streams) {
    if (!s.scheduled) continue;
    for (const c of s.costs) if (c.bps != null) layers.add(c.spatialLayer);
  }
  let top = null;
  for (const layer of layers) {
    const cost = receiverCostAt(receiver, layer, audioBps, overhead);
    if (cost && (top == null || cost.bps > top)) top = cost.bps;
  }
  return top;
}

// 计划里的 streams 必须包含该接收者全部视频：被调度的带目标层，
// 未调度的带 scheduled:false + 当前层（Room 据此钉住它们，避免抢预算）。
function streamsOut(receiver, spatialLayer, cost) {
  return receiver.streams.map((s) => {
    const c = s.scheduled && cost ? costAt(s.costs, spatialLayer) : null;
    return {
      consumerId: s.consumerId,
      producerId: s.producerId,
      label: s.label,
      scheduled: Boolean(s.scheduled),
      currentLayer: s.currentLayer ?? null,
      currentCostBps: s.currentCostBps ?? null,
      currentCostSource: s.currentCostSource || 'missing',
      requestedSpatialLayer: s.scheduled ? spatialLayer : null,
      layerCostBps: s.scheduled ? (c ? c.bps : null) : s.currentCostBps ?? null,
      costSource: s.scheduled ? (c ? c.source : 'missing') : (s.currentCostSource || 'missing'),
      costs: normalizeCosts(s.costs),
    };
  });
}

function baseReceiver(r) {
  return {
    peerId: r.peerId,
    transportId: r.transportId ?? null,
    budgetBps: r.budgetBps ?? null,
    budgetSource: r.budgetSource || (r.budgetBps != null ? 'input' : 'unset'),
    bweBps: Number.isFinite(r.bweBps) ? r.bweBps : null,
    scheduledStreams: r.streams.filter((s) => s.scheduled).map((s) => ({
      consumerId: s.consumerId,
      producerId: s.producerId,
      label: s.label,
    })),
    unscheduledStreams: r.streams.filter((s) => !s.scheduled).map((s) => ({
      consumerId: s.consumerId,
      label: s.label,
      currentCostBps: s.currentCostBps ?? null,
      currentCostSource: s.currentCostSource || 'missing',
    })),
    streams: r.streams.map((s) => ({
      consumerId: s.consumerId,
      producerId: s.producerId,
      label: s.label,
      scheduled: Boolean(s.scheduled),
      currentLayer: s.currentLayer ?? null,
      costs: normalizeCosts(s.costs),
    })),
  };
}

// 未调度视频的成本未知时不能静默忽略：它仍在真实出向里，必须告警
function warnUnscheduled(receiver, warnings) {
  for (const s of receiver.streams) {
    if (s.scheduled) continue;
    if (s.currentCostBps == null) {
      warnings.push({
        peerId: receiver.peerId,
        consumerId: s.consumerId,
        code: 'unscheduled-cost-missing',
        message: `未调度的 ${s.label || '视频'} 没有当前层成本，出向预算可能被它挤占（不按 0 处理）`,
      });
    } else {
      warnings.push({
        peerId: receiver.peerId,
        consumerId: s.consumerId,
        code: 'unscheduled-stream',
        message: `未调度的 ${s.label || '视频'} 仍占同一 Transport，按当前层成本 ${s.currentCostBps}bps 计入预算`,
      });
    }
  }
}

/**
 * 方案 A：按接收者独立评分。
 * 每个接收者只用自己的预算选自己的层；BWE 只作为证据与告警，不参与选层——
 * 因为升带宽时 BWE 需要时间重新探测，把当前 BWE 当硬上限会把层粘死在低位。
 * 真正的 BWE 约束由 worker 在转发时执行（发送预算 + 拥塞控制）。
 */
export function planPerReceiver(
  receivers,
  { audioReserveBps = DEFAULT_AUDIO_RESERVE_BPS, transportOverhead = DEFAULT_TRANSPORT_OVERHEAD } = {},
) {
  const warnings = [];
  const decisions = receivers.map((r) => {
    const base = baseReceiver(r);
    warnUnscheduled(r, warnings);
    if (r.budgetBps == null) {
      warnings.push({ peerId: r.peerId, code: 'budget-unset', message: '该接收者没有预算，未做选层' });
      return {
        ...base,
        capBps: null,
        requestedSpatialLayer: null,
        layerCostBps: null,
        costSource: 'none',
        score: 0,
        reason: 'budget-unset',
        streams: base.streams.map((s) => ({ ...s, requestedSpatialLayer: null })),
      };
    }
    const hasAnyCost = r.streams.some((s) => s.scheduled && s.costs.some((c) => c.bps != null));
    if (!hasAnyCost) {
      warnings.push({
        peerId: r.peerId,
        code: 'cost-missing',
        message: '实测层成本与配置成本都没有，未做选层（不按 0 处理）',
      });
      return {
        ...base,
        capBps: null,
        requestedSpatialLayer: null,
        layerCostBps: null,
        costSource: 'missing',
        score: 0,
        reason: 'cost-missing',
        streams: base.streams.map((s) => ({ ...s, requestedSpatialLayer: null })),
      };
    }
    if (!Number.isFinite(r.bweBps)) {
      warnings.push({ peerId: r.peerId, code: 'bwe-unavailable', message: '未取到传输层 BWE，仅以轨迹预算规划（BWE 由 worker 在转发时执行）' });
    } else if (r.bweBps < r.budgetBps) {
      warnings.push({
        peerId: r.peerId,
        code: 'bwe-below-budget',
        message: `当前 BWE ${(r.bweBps / 1000).toFixed(0)}k 低于轨迹预算 ${(r.budgetBps / 1000).toFixed(0)}k，计划层可能被 worker 压制到更低层`,
      });
    }
    const pick = pickReceiverLayer(r, r.budgetBps, audioReserveBps, transportOverhead);
    if (pick.cost && pick.cost.source === 'configured') {
      warnings.push({ peerId: r.peerId, code: 'cost-configured', message: '该层成本使用配置值（假设待验），不是实测' });
    }
    const layerCap = pick.cost ? pick.cost.bps : r.budgetBps;
    const cap = Math.min(r.budgetBps, layerCap);
    const top = receiverTopCost(r, audioReserveBps, transportOverhead);
    return {
      ...base,
      capBps: cap,
      requestedSpatialLayer: pick.spatialLayer,
      layerCostBps: pick.cost ? pick.cost.bps : null,
      layerVideoBps: pick.cost ? pick.cost.videoBps : null,
      costSource: pick.cost ? pick.cost.source : 'missing',
      // 评分按“可用于视频的出向预算 / 最贵层成本”算（都含音频预留与传输开销）
      score: top ? Number(clamp01((cap - withOverhead(audioReserveBps, transportOverhead)) / top).toFixed(3)) : 0,
      reason: pick.reason,
      streams: streamsOut(r, pick.spatialLayer, pick.cost),
    };
  });
  return {
    scheme: 'per-receiver',
    at: Date.now(),
    audioReserveBps,
    transportOverhead,
    groupBudgetBps: null,
    receivers: decisions,
    warnings,
  };
}

/**
 * 方案 B：按共同层组分配预算。
 * 组预算 = 组内各接收者轨迹预算之和（呈现用）。
 * 公共层 = 组内“每个成员用自己的预算都放得下”的最高层，因此由最弱链路决定。
 * 高带宽成员被拖到公共层，换取同层播放与可预测的总发送预算——这正是方案取舍。
 */
export function planGroupShared(
  receivers,
  { audioReserveBps = DEFAULT_AUDIO_RESERVE_BPS, transportOverhead = DEFAULT_TRANSPORT_OVERHEAD } = {},
) {
  const warnings = [];
  const eligible = receivers.filter((r) => r.budgetBps != null);
  for (const r of receivers) {
    if (r.budgetBps == null) {
      warnings.push({ peerId: r.peerId, code: 'budget-unset', message: '该接收者没有预算，未纳入共同层组' });
    }
    warnUnscheduled(r, warnings);
  }
  if (!eligible.length) {
    return {
      scheme: 'group-shared',
      at: Date.now(),
      audioReserveBps,
      transportOverhead,
      groupBudgetBps: 0,
      bottleneckBudgetBps: 0,
      commonSpatialLayer: null,
      receivers: [],
      warnings,
    };
  }

  const groupBudgetBps = eligible.reduce((sum, r) => sum + r.budgetBps, 0);
  // 最弱链路用轨迹预算而非瞬时 BWE，否则升带宽时 BWE 尚未回升会把公共层粘在低位。
  const bottleneckBudgetBps = eligible.reduce((min, r) => (r.budgetBps < min ? r.budgetBps : min), Infinity);

  // 所有成员都放得下的最高层
  const layerIds = new Set();
  for (const r of eligible) {
    for (const s of r.streams) {
      if (!s.scheduled) continue;
      for (const c of s.costs) if (c.bps != null) layerIds.add(c.spatialLayer);
    }
  }
  const descending = [...layerIds].sort((a, b) => b - a);
  let common = null;
  let commonCost = null;
  for (const layer of descending) {
    let ok = true;
    let worst = null;
    for (const r of eligible) {
      const cost = receiverCostAt(r, layer, audioReserveBps, transportOverhead);
      if (!cost || cost.bps > r.budgetBps) { ok = false; break; }
      if (worst == null || cost.bps > worst.bps) worst = cost;
    }
    if (ok) {
      common = layer;
      commonCost = worst;
      break;
    }
  }
  if (common == null) {
    common = descending.length ? descending[descending.length - 1] : 0;
    commonCost = null;
    warnings.push({
      code: 'below-lowest-layer',
      message: '最弱链路连最低层也放不下，公共层退化为最低层（实际转发可能被 BWE 继续压制）',
    });
  } else if (commonCost && commonCost.source === 'configured') {
    warnings.push({ code: 'group-cost-configured', message: '共同层成本使用配置值（假设待验），不是实测' });
  }

  const receiversOut = eligible.map((r) => {
    const base = baseReceiver(r);
    const ownCost = receiverCostAt(r, common, audioReserveBps, transportOverhead);
    const layerTotal = ownCost ? ownCost.bps : r.budgetBps;
    const cap = Math.min(r.budgetBps, layerTotal);
    if (!Number.isFinite(r.bweBps)) {
      warnings.push({ peerId: r.peerId, code: 'bwe-unavailable', message: `接收者 ${r.peerId} 未取到 BWE，仅按轨迹预算规划` });
    } else if (r.bweBps < r.budgetBps) {
      warnings.push({
        peerId: r.peerId,
        code: 'bwe-below-budget',
        message: `接收者 ${r.peerId} 当前 BWE ${(r.bweBps / 1000).toFixed(0)}k 低于轨迹预算 ${(r.budgetBps / 1000).toFixed(0)}k，实际层可能被 worker 压低`,
      });
    }
    const top = receiverTopCost(r, audioReserveBps, transportOverhead);
    return {
      ...base,
      capBps: cap,
      requestedSpatialLayer: common,
      layerCostBps: ownCost ? ownCost.bps : null,
      layerVideoBps: ownCost ? ownCost.videoBps : null,
      costSource: ownCost ? ownCost.source : 'missing',
      // 评分按实际下发预算算，高带宽成员被拖低后分数必须真的下降，不能掩盖取舍
      score: top ? Number(clamp01((cap - withOverhead(audioReserveBps, transportOverhead)) / top).toFixed(3)) : 0,
      reason: ownCost && ownCost.bps <= r.budgetBps ? 'common-layer-fits' : 'common-layer-below-budget',
      streams: streamsOut(r, common, ownCost),
    };
  });

  return {
    scheme: 'group-shared',
    at: Date.now(),
    audioReserveBps,
    transportOverhead,
    groupBudgetBps,
    bottleneckBudgetBps: Number.isFinite(bottleneckBudgetBps) ? bottleneckBudgetBps : null,
    commonSpatialLayer: common,
    commonLayerCostBps: commonCost ? commonCost.bps : null,
    receivers: receiversOut,
    warnings,
  };
}

export function planScheme(scheme, receivers, opts = {}) {
  if (scheme === 'per-receiver') return planPerReceiver(receivers, opts);
  if (scheme === 'group-shared') return planGroupShared(receivers, opts);
  throw new Error(`未知调度方案 ${scheme}（可选 per-receiver / group-shared）`);
}
