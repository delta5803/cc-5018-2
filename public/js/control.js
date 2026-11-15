import { Signaling, layerText } from './common.js';

const $ = (id) => document.getElementById(id);
const sig = new Signaling();
let connected = false;
let lastSnapshot = null;
let lastStats = [];
let pollTimer = null;

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
  } catch (err) {
    result(`快照获取失败：${err.message}`, 'err');
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
