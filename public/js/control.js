import { Signaling, layerText } from './common.js';

const $ = (id) => document.getElementById(id);
const sig = new Signaling();
let connected = false;
let lastSnapshot = null;
let lastStats = [];
let lastEvidence = null;
let pollTimer = null;
const budgetDraft = new Map(); // peerId -> kbps 草稿，避免每次轮询清空输入
const groupDraft = new Set(); // 共同层组成员

function result(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $('resultLog').appendChild(line);
  $('resultLog').scrollTop = $('resultLog').scrollHeight;
}
function setStatus(el, text, cls) {
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function connectCore() {
  try {
    setStatus($('coreStatus'), '连接中…', 'warn');
    await sig.connect();
    const { rtpCapabilities } = await sig.request('join', {
      roomId: $('roomId').value.trim(),
      peerId: `controller-${Math.random().toString(36).slice(2, 8)}`,
      role: 'controller',
    });
    connected = true;
    setStatus($('coreStatus'), '已连接转发内核', 'on');
    result('已以 controller 身份接入 mediasoup 信令内核（本页不建立媒体传输）', 'ok');
    $('connectBtn').disabled = true;

    sig.on('new-producer', (e) => result(`内核事件：新 Producer ${e.producer.appData?.label || e.producer.id}`, 'ev'));
    sig.on('producer-closed', (e) => result(`内核事件：Producer 关闭 ${e.producerId}`, 'ev'));
    sig.on('peer-left', (e) => result(`内核事件：节点离开 ${e.peerId}（${e.reason}）`, 'ev'));
    sig.on('consumer-layers', (e) => result(`内核事件：${e.peerId} 实际下发层 -> ${layerText(e.layers)}`, 'ev'));
    sig.on('ice-state', (e) => result(`内核事件：${e.peerId} ICE=${e.iceState}`, e.iceState === 'failed' ? 'err' : 'ev'));
    sig.on('socket-close', () => setStatus($('coreStatus'), '内核连接断开', 'off'));

    pollTimer = setInterval(poll, 1000);
    poll();
  } catch (err) {
    result(`连接内核失败：${err.message}`, 'err');
    setStatus($('coreStatus'), '失败', 'off');
  }
}

async function poll() {
  try {
    const { snapshot, stats } = await sig.request('room-snapshot');
    lastSnapshot = snapshot;
    lastStats = stats;
    $('refreshAt').textContent = new Date().toLocaleTimeString();
    renderOverview();
    renderDetails();
    refreshSelectors();
    refreshSchemeControls();
    await refreshEvidence();
    renderSchemePlan();
  } catch (err) {
    result(`快照获取失败：${err.message}`, 'err');
  }
}

// 拉取真实层成本与 BWE，用于“计划 vs 实际”对照；失败必须回显，不吞错
async function refreshEvidence() {
  try {
    const { evidence } = await sig.request('control-schedule-evidence', {
      label: $('schemeLabel').value.trim() || null,
    });
    lastEvidence = evidence;
    renderEvidence();
    return evidence;
  } catch (err) {
    $('schemeEvidence').innerHTML = `<span class="err">证据获取失败：${err.message}</span>`;
    return null;
  }
}

function peerStat(peerId) {
  return lastStats.find((s) => s.peerId === peerId);
}

function renderOverview() {
  const rows = lastSnapshot.peers.map((p) => {
    const st = peerStat(p.id);
    const recv = st?.transports.find((t) => t.direction === 'recv');
    const send = st?.transports.find((t) => t.direction === 'send');
    const inKbps = (st?.producers || []).reduce((a, x) => a + x.bitrate, 0) / 1000;
    const outKbps = (st?.consumers || []).reduce((a, x) => a + x.bitrate, 0) / 1000;
    return `<tr>
      <td>${p.id}</td>
      <td>${p.role}</td>
      <td>发送 ${(send?.iceState || '-')} / 接收 ${(recv?.iceState || '-')}</td>
      <td class="mono">${p.producers.length} 发 / ${p.consumers.length} 订</td>
      <td class="mono">入 ${inKbps.toFixed(1)} kbps</td>
      <td class="mono">出 ${outKbps.toFixed(1)} kbps</td>
      <td class="mono">${recv?.maxOutgoingBitrate ? (recv.maxOutgoingBitrate / 1000).toFixed(0) + ' kbps' : '无上限'}</td>
    </tr>`;
  }).join('');
  $('roomOverview').innerHTML = `
    <table>
      <thead><tr><th>节点</th><th>角色</th><th>ICE 状态</th><th>Producer/Consumer</th><th>内核入向</th><th>内核出向</th><th>带宽上限</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">房间暂无节点</td></tr>'}</tbody>
    </table>`;
}

function renderDetails() {
  const blocks = lastSnapshot.peers
    .filter((p) => p.role === 'student')
    .map((p) => {
      const st = peerStat(p.id);
      const consumers = (st?.consumers || []).map((c) => `
        <tr>
          <td>${c.label || c.kind}</td>
          <td>${c.kind}</td>
          <td class="mono ${c.currentLayers?.spatialLayer != null ? 'badge-l' + c.currentLayers.spatialLayer : ''}">${layerText(c.currentLayers)}</td>
          <td class="mono">${c.manualLayers ? `固定 S${c.manualLayers.spatialLayer}` : '自动'}</td>
          <td class="mono">${(c.bitrate / 1000).toFixed(1)} kbps</td>
          <td class="mono">${c.mimeType || ''}</td>
          <td class="mono">评分 ${c.score?.[0]?.score ?? '-'}，PLI ${c.pliCount}，NACK ${c.nackCount}</td>
        </tr>`).join('');
      return `<div class="card" style="margin-bottom:12px">
        <h2>${p.id} 的订阅转发</h2>
        <table>
          <thead><tr><th>轨道</th><th>类型</th><th>SFU 实际层</th><th>选层模式</th><th>转发码率</th><th>编解码</th><th>质量反馈</th></tr></thead>
          <tbody>${consumers || '<tr><td colspan="7" class="muted">暂无订阅</td></tr>'}</tbody>
        </table>
      </div>`;
    }).join('');
  $('detailArea').innerHTML = blocks || '<p class="muted">暂无学生节点</p>';
}

function refreshSelectors() {
  const students = lastSnapshot.peers.filter((p) => p.role === 'student');
  const peerSel = $('targetPeer');
  const prevPeer = peerSel.value;
  peerSel.innerHTML = students.map((p) => `<option value="${p.id}">${p.id}</option>`).join('');
  if ([...peerSel.options].some((o) => o.value === prevPeer)) peerSel.value = prevPeer;

  const peer = students.find((p) => p.id === peerSel.value);
  const consumerSel = $('targetConsumer');
  const prevC = consumerSel.value;
  const cons = peer ? peer.consumers.filter((c) => c.kind === 'video') : [];
  consumerSel.innerHTML = cons.map((c) => `<option value="${c.id}">${c.label || c.id} (${c.id.slice(0, 8)})</option>`).join('');
  if ([...consumerSel.options].some((o) => o.value === prevC)) consumerSel.value = prevC;
}

// 学生集合变化时重建：组成员勾选 + 逐人预算输入（保留用户草稿）
function refreshSchemeControls() {
  const students = lastSnapshot.peers.filter((p) => p.role === 'student');
  const online = new Set(students.map((p) => p.id));
  for (const id of [...groupDraft]) if (!online.has(id)) groupDraft.delete(id);

  const members = $('groupMembers');
  members.innerHTML = students.length
    ? students.map((p) => {
        const checked = groupDraft.has(p.id) ? 'checked' : '';
        return `<label style="display:inline-block;margin-right:12px">
          <input type="checkbox" data-group-id="${p.id}" ${checked}/> ${p.id}
        </label>`;
      }).join('')
    : '<span class="muted">暂无学生</span>';

  const budgets = $('budgetInputs');
  budgets.innerHTML = students.length
    ? students.map((p) => {
        const draft = budgetDraft.get(p.id);
        const value = draft == null ? '' : draft;
        return `<label style="display:inline-block;margin-right:12px;margin-bottom:6px">
          ${p.id}
          <input type="number" data-budget-id="${p.id}" value="${value}" placeholder="未设置" style="width:100px"/>
          <span class="muted">kbps</span>
        </label>`;
      }).join('')
    : '<span class="muted">暂无学生</span>';
}

function renderSchemePlan() {
  const s = lastSnapshot?.scheduling;
  if (!s || !s.plan) {
    $('schemePlan').textContent = '尚未下发方案';
    return;
  }
  const rows = (s.plan.receivers || []).map((r) => {
    const scheduled = (r.streams || []).filter((x) => x.scheduled);
    const labels = scheduled.map((x) => x.label || x.consumerId.slice(0, 6)).join(' + ') || '-';
    return `<tr>
      <td>${r.peerId}</td>
      <td>${labels}</td>
      <td class="mono">${r.requestedSpatialLayer == null ? '未选层' : '请求 S' + r.requestedSpatialLayer}</td>
      <td class="mono">${r.capBps == null ? '-' : (r.capBps / 1000).toFixed(0) + ' kbps'}</td>
      <td class="mono">${r.score ?? '-'}</td>
      <td class="mono">${r.costSource || '-'}</td>
    </tr>`;
  }).join('');
  const warnings = (s.plan.warnings || []);
  const errors = s.errors || [];
  $('schemePlan').innerHTML = `
    <p class="muted">
      方案 <b>${s.scheme === 'group-shared' ? '按共同层组分配预算' : '按接收者独立评分'}</b>，
      音频预留 ${((s.audioReserveBps || 0) / 1000).toFixed(0)} kbps，
      出向开销 ${((s.transportOverhead ?? 0) * 100).toFixed(0)}%，
      ${s.plan.groupBudgetBps != null ? `组预算合计 ${(s.plan.groupBudgetBps / 1000).toFixed(0)} kbps / 最弱链路 ${(s.plan.bottleneckBudgetBps / 1000).toFixed(0)} kbps，` : ''}
      下发 ${(s.applied || []).length} 项，失败 ${errors.length} 项。
    </p>
    <table>
      <thead><tr><th>接收者</th><th>轨道</th><th>计划层</th><th>发送预算</th><th>评分</th><th>层成本来源</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">无接收者</td></tr>'}</tbody>
    </table>
    ${warnings.length ? `<div class="muted" style="margin-top:8px">警告：${warnings.map((w) => w.message).join('；')}</div>` : ''}
    ${errors.length ? `<div class="log" style="margin-top:8px;height:auto">${errors.map((e) => `<div class="err">${e.stage} ${e.peerId || e.consumerId || ''}: ${e.message}</div>`).join('')}</div>` : ''}`;
}

// 计划 vs 实际：请求层、SFU 实际下发层、发送预算、浏览器可解码帧
function renderEvidence() {
  if (!lastEvidence) {
    $('schemeEvidence').textContent = '等待内核证据';
    return;
  }
  const planByConsumer = new Map();
  for (const r of lastEvidence.scheduling?.plan?.receivers || []) {
    for (const stream of r.streams || []) planByConsumer.set(stream.consumerId, stream);
  }
  const blocks = [];
  for (const receiver of lastEvidence.receivers || []) {
    const st = peerStat(receiver.peerId);
    const student = lastSnapshot.peers.find((p) => p.id === receiver.peerId);
    const rows = (receiver.streams || []).map((c) => {
      const consumerId = c.consumerId;
      const serverC = (st?.consumers || []).find((x) => x.id === consumerId);
      const client = serverC?.clientStats || null;
      const planned = planByConsumer.get(consumerId);
      const clientLayer = client?.framesDecoded != null ? `解码 ${client.framesDecoded} 帧` : '无浏览器实测';
      const dropped = client?.framesDropped != null ? `，丢 ${client.framesDropped}` : '';
      const layerTextVal = layerText(serverC?.currentLayers);
      return `<tr>
        <td>${c.label || '-'}${c.scheduled ? '' : ' <span class="muted">(未调度)</span>'}</td>
        <td class="mono">${planned?.requestedSpatialLayer == null ? '未计划' : 'S' + planned.requestedSpatialLayer}</td>
        <td class="mono ${serverC?.currentLayers?.spatialLayer != null ? 'badge-l' + serverC.currentLayers.spatialLayer : ''}">${layerTextVal}</td>
        <td class="mono">${(serverC?.bitrate / 1000 || 0).toFixed(1)} kbps</td>
        <td class="mono">${client ? `${(client.bitrateBps / 1000).toFixed(1)} kbps` : '-'}</td>
        <td class="mono">${clientLayer}${dropped}</td>
        <td class="mono">${c.costs.map((x) => `S${x.spatialLayer}:${x.bps == null ? '缺' : (x.bps / 1000).toFixed(0) + 'k/' + x.source}`).join(' ')}</td>
      </tr>`;
    }).join('');
    const caps = (receiver.transports || []).map((t) =>
      `${t.id.slice(0, 6)}… BWE=${t.availableOutgoingBitrate == null ? '未知' : (t.availableOutgoingBitrate / 1000).toFixed(0) + 'k'} 上限=${t.maxOutgoingBitrate == null ? '无' : (t.maxOutgoingBitrate / 1000).toFixed(0) + 'k'}`
    ).join('；');
    blocks.push(`<div style="margin-bottom:12px">
      <b>${receiver.peerId}</b> <span class="muted">(${student?.role || '?'}) ${caps}</span>
      <table>
        <thead><tr><th>轨道</th><th>计划层</th><th>SFU 实际层</th><th>SFU 出向</th><th>浏览器实测</th><th>可解码帧</th><th>层成本来源</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">无视频订阅</td></tr>'}</tbody>
      </table>
    </div>`);
  }
  $('schemeEvidence').innerHTML = blocks.join('') || '<span class="muted">房间暂无视频订阅</span>';
}

async function callCore(action, params, okText) {
  try {
    const method = {
      layer: 'control-set-layers',
      'layer-auto': 'control-set-layers',
      bitrate: 'control-set-bitrate',
      'restart-ice': 'control-restart-ice',
    }[action];
    const res = await sig.request(method, params);
    result(`内核操作成功：${okText} ${JSON.stringify(res)}`, 'ok');
    await poll();
  } catch (err) {
    // 失败反馈回教学转发控制页，而不是静默吞掉
    result(`内核操作失败：${okText} -> ${err.message}`, 'err');
  }
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn || !connected) return;
  const targetPeerId = $('targetPeer').value;
  const consumerId = $('targetConsumer').value;
  const st = peerStat(targetPeerId);
  const recv = st?.transports.find((t) => t.direction === 'recv');
  if (!targetPeerId) return result('请先选择目标学生', 'err');

  if (btn.dataset.act === 'layer') {
    if (!consumerId) return result('请先选择视频 Consumer', 'err');
    const spatialLayer = Number(btn.dataset.layer);
    await callCore('layer', { targetPeerId, consumerId, spatialLayer }, `强制 ${targetPeerId} 切到 S${spatialLayer}`);
  } else if (btn.dataset.act === 'layer-auto') {
    if (!consumerId) return result('请先选择视频 Consumer', 'err');
    await callCore('layer-auto', { targetPeerId, consumerId, mode: 'auto' }, `恢复 ${targetPeerId} 自动选层`);
  } else if (btn.dataset.act === 'bitrate') {
    if (!recv) return result('目标学生没有接收 Transport', 'err');
    const bitrate = Number($('presetBitrate').value);
    await callCore('bitrate', { targetPeerId, transportId: recv.id, bitrate }, `限制 ${targetPeerId} 下行 ${bitrate / 1000}kbps`);
  } else if (btn.dataset.act === 'restart-ice') {
    if (!recv) return result('目标学生没有接收 Transport', 'err');
    await callCore('restart-ice', { targetPeerId, transportId: recv.id }, `重启 ${targetPeerId} ICE`);
  }
});

$('connectBtn').addEventListener('click', connectCore);

// 组成员勾选与逐人预算草稿（input 事件保留，不受每秒轮询重建影响）
$('groupMembers').addEventListener('change', (ev) => {
  const cb = ev.target.closest('input[data-group-id]');
  if (!cb) return;
  if (cb.checked) groupDraft.add(cb.dataset.groupId);
  else groupDraft.delete(cb.dataset.groupId);
});
$('budgetInputs').addEventListener('input', (ev) => {
  const input = ev.target.closest('input[data-budget-id]');
  if (!input) return;
  const v = input.value.trim();
  if (v === '') budgetDraft.delete(input.dataset.budgetId);
  else budgetDraft.set(input.dataset.budgetId, v);
});

$('applySchemeBtn').addEventListener('click', async () => {
  if (!connected) return result('请先连接转发内核', 'err');
  const scheme = $('schemeSelect').value;
  const groupPeerIds = [...groupDraft];
  if (!groupPeerIds.length) return result('请先勾选至少一个共同层组成员', 'err');
  const receiverBudgets = {};
  const missing = [];
  for (const id of groupPeerIds) {
    const raw = budgetDraft.get(id);
    if (raw == null || raw === '') { missing.push(id); continue; }
    const kbps = Number(raw);
    if (!Number.isFinite(kbps) || kbps <= 0) { missing.push(`${id}(非法值 ${raw})`); continue; }
    receiverBudgets[id] = Math.round(kbps * 1000);
  }
  if (missing.length) {
    // 缺预算不按 0 处理：直接拒绝下发并指明是哪些接收者
    return result(`以下接收者未设置有效预算，未下发：${missing.join('、')}`, 'err');
  }
  try {
    result(`下发方案：${scheme}，成员 ${groupPeerIds.join(', ')}，预算 ${JSON.stringify(Object.fromEntries(Object.entries(receiverBudgets).map(([k, v]) => [k, v / 1000 + 'kbps'])))}`, 'ev');
    const { scheduling } = await sig.request('control-apply-scheme', {
      scheme,
      groupPeerIds,
      receiverBudgets,
      audioReserveBps: Math.round(Number($('audioReserve').value || 48) * 1000),
      transportOverhead: Number($('transportOverhead').value || 8) / 100,
      label: $('schemeLabel').value.trim() || null,
    });
    if (scheduling.errors?.length) {
      result(`方案已下发但有 ${scheduling.errors.length} 项失败：${scheduling.errors.map((e) => e.stage + ':' + e.message).join('；')}`, 'err');
    } else {
      result(`方案已下发到转发入口：${scheduling.applied.length} 项生效`, 'ok');
    }
    await poll();
  } catch (err) {
    result(`下发方案失败：${err.message}`, 'err');
  }
});

$('clearSchemeBtn').addEventListener('click', async () => {
  if (!connected) return result('请先连接转发内核', 'err');
  const targetPeerId = $('targetPeer').value;
  if (!targetPeerId) return result('请先选择目标学生', 'err');
  try {
    const res = await sig.request('control-clear-scheme', { targetPeerId });
    result(`已恢复 ${targetPeerId} 自动选层：${JSON.stringify(res.results)}`, 'ok');
    await poll();
  } catch (err) {
    result(`恢复自动选层失败：${err.message}`, 'err');
  }
});

// 导出真实证据（层成本实测 + BWE + 最近计划），作为分层策略试验脚本的输入
$('exportEvidenceBtn').addEventListener('click', async () => {
  if (!connected) return result('请先连接转发内核', 'err');
  try {
    const { evidence } = await sig.request('control-schedule-evidence', {
      label: $('schemeLabel').value.trim() || null,
    });
    const blob = new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `schedule-evidence-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    result(`已导出调度证据：${evidence.receivers.length} 个接收者样本`, 'ok');
  } catch (err) {
    result(`导出证据失败：${err.message}`, 'err');
  }
});
