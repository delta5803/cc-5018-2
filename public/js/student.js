import { Signaling, MediasoupDevice, layerText, getReceiverStats, LAYER_NAMES } from './common.js';

const $ = (id) => document.getElementById(id);
const sig = new Signaling();
let device = null;
let joined = false;
let statsTimer = null;
const consumerMeta = new Map(); // consumerId -> { label, kind, firstFrameAt, startTime, videoEl, lastBytes, lastT }
let mediaReady = false;

function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}
function setStatus(el, text, cls) {
  el.textContent = text;
  el.className = `status ${cls}`;
}
function setMedia(ready, text) {
  mediaReady = ready;
  setStatus($('mediaStatus'), text, ready ? 'on' : 'warn');
}

async function joinRoom() {
  try {
    setStatus($('sigStatus'), '连接中…', 'warn');
    setMedia(false, '无可解码画面');
    await sig.connect();
    const { rtpCapabilities, producers } = await sig.request('join', {
      roomId: $('roomId').value.trim(),
      peerId: $('peerId').value.trim(),
      role: 'student',
      rtpCapabilities: undefined, // Device 加载后再上报
    });
    device = new MediasoupDevice(sig);
    await device.load(rtpCapabilities);
    await sig.request('set-rtp-capabilities', { rtpCapabilities: device.rtpCapabilities });
    await device.createRecvTransport();

    joined = true;
    setStatus($('sigStatus'), '已加入（信令在线，尚无媒体）', 'info');
    $('joinBtn').disabled = true;
    $('rejoinBtn').disabled = false;
    $('leaveBtn').disabled = false;
    $('iceBtn').disabled = false;
    log('信令就绪、接收 Transport 已创建。等待订阅并出画…', 'ev');

    wireSignalingEvents();

    // 房间里已存在的 Producer 立即订阅
    for (const p of producers) await consumeProducer(p.id, p.appData?.label, p.kind);
  } catch (err) {
    log(`加入失败：${err.message}`, 'err');
    setStatus($('sigStatus'), '失败', 'off');
  }
}

function wireSignalingEvents() {
  sig.on('new-producer', async ({ producer }) => {
    log(`收到新 Producer 通知：${producer.appData?.label || producer.kind}（${producer.id}）`, 'ev');
    await consumeProducer(producer.id, producer.appData?.label, producer.kind);
  });

  sig.on('consumer-layers', ({ consumerId, layers }) => {
    const meta = consumerMeta.get(consumerId);
    if (!meta) return;
    const badge = layers && layers.spatialLayer != null ? `badge-l${layers.spatialLayer}` : '';
    meta.layerEl.className = badge;
    meta.layerEl.textContent = layerText(layers);
    log(`SFU 实际下发层变化 [${meta.label}]：${layerText(layers)}`, 'ev');
  });

  sig.on('consumer-closed', ({ consumerId, reason }) => {
    const meta = consumerMeta.get(consumerId);
    if (meta) {
      log(`订阅 [${meta.label}] 被关闭：${reason}（教师可能已退出）`, 'warn');
      meta.card.querySelector('.stream-state').textContent = '生产者已退出，无画面';
      meta.card.querySelector('.stream-state').className = 'stream-state status off';
      consumerMeta.delete(consumerId);
    }
    if (consumerMeta.size === 0) setMedia(false, '生产者退出，等待恢复');
  });

  sig.on('producer-closed', ({ producerId }) => {
    for (const [cid, meta] of consumerMeta) {
      if (meta.producerId === producerId) {
        log(`Producer ${producerId} 已关闭`, 'warn');
      }
    }
  });

  sig.on('ice-state', ({ iceState }) => {
    const cls = iceState === 'completed' || iceState === 'connected' ? 'on' : iceState === 'failed' ? 'off' : 'warn';
    setStatus($('iceStatus'), iceState, cls);
    log(`ICE：${iceState}`, iceState === 'failed' ? 'err' : 'ev');
    if (iceState === 'failed') log('ICE failed：可点击“重启 ICE”，或控制页远程重启', 'err');
  });

  sig.on('dtls-state', ({ dtlsState }) => log(`DTLS：${dtlsState}`, 'ev'));
  sig.on('socket-close', () => {
    setStatus($('sigStatus'), 'WebSocket 断开', 'off');
    log('信令断开', 'err');
  });
  sig.on('session-ended', ({ reason }) => log(`会话结束：${reason}`, 'warn'));
  sig.on('peer-left', ({ peerId, reason }) => log(`节点离开：${peerId}（${reason}）`, 'ev'));
}

async function consumeProducer(producerId, label, kind) {
  const start = performance.now();
  try {
    const { consumer } = await device.consume(producerId, device.recvTransport.id);
    const card = document.createElement('div');
    card.className = 'card';
    const title = label || consumer.kind;
    card.innerHTML = `
      <h2>${title} <span class="stream-state status info">订阅建立，等待关键帧…</span></h2>
      ${consumer.kind === 'video'
        ? '<video autoplay playsinline></video>'
        : '<audio autoplay></audio><div class="audio-meter"><div class="meter"></div></div>'}
      <div class="kv" style="margin-top:10px">
        <b>SFU 实际下发层</b><span class="layer-badge mono">-</span>
        <b>手动偏好</b><span class="manual mono">自动（BWE 选层）</span>
        <b>首次出画</b><span class="firstframe mono">测量中…</span>
        <b>编解码</b><span class="codec mono">-</span>
        <b>接收码率</b><span class="bitrate mono">-</span>
        <b>丢包/抖动</b><span class="loss mono">-</span>
        ${consumer.kind === 'video'
          ? '<b>解码帧/丢帧</b><span class="frames mono">-</span>'
          : '<b>音频电平</b><span class="alevel mono">-</span>'}
      </div>
      ${consumer.kind === 'video' ? `
      <div style="margin-top:10px">
        <b style="font-size:13px">切换订阅层（真实 Simulcast 空间层）：</b><br/>
        <button class="layer-btn active" data-mode="auto">自动</button>
        ${LAYER_NAMES.map((n, i) => `<button class="layer-btn" data-layer="${i}">${n}</button>`).join('')}
      </div>` : ''}`;
    $('consumerArea').appendChild(card);

    const mediaEl = card.querySelector(consumer.kind === 'video' ? 'video' : 'audio');
    mediaEl.srcObject = new MediaStream([consumer.track]);
    await mediaEl.play().catch(() => {});

    const meta = {
      consumer, producerId, label: title, kind: consumer.kind, card,
      layerEl: card.querySelector('.layer-badge'),
      manualEl: card.querySelector('.manual'),
      firstFrameEl: card.querySelector('.firstframe'),
      startTime: start,
      firstFrameAt: null,
      lastBytes: 0,
      lastT: performance.now(),
    };
    consumerMeta.set(consumer.id, meta);

    // 媒体状态判定：必须真正收到并解码出第一帧，而不是仅“加入房间”
    if (consumer.kind === 'video') {
      const raf = function watch() {
        if (mediaEl.readyState >= 2 && mediaEl.videoWidth > 0) {
          if (!meta.firstFrameAt) {
            meta.firstFrameAt = performance.now() - start;
            meta.firstFrameEl.textContent = `${meta.firstFrameAt.toFixed(0)} ms（订阅→首帧）`;
            card.querySelector('.stream-state').textContent = '已出画（可解码）';
            card.querySelector('.stream-state').className = 'stream-state status on';
            setMedia(true, '已收到可解码画面');
            log(`[${title}] 首次出画 ${meta.firstFrameAt.toFixed(0)} ms`, 'ok');
          }
          return;
        }
        requestAnimationFrame(watch);
      };
      raf();
    } else {
      // 音频：收到第一个 RTP 包（getStats packetsReceived 增长）即视为媒体就绪
      meta.audioWatch = setInterval(() => {
        getReceiverStats(consumer).then((s) => {
          if (s && s.packetsReceived > 0 && !meta.firstFrameAt) {
            meta.firstFrameAt = performance.now() - start;
            meta.firstFrameEl.textContent = `${meta.firstFrameAt.toFixed(0)} ms（订阅→首个音频包）`;
            card.querySelector('.stream-state').textContent = '音频流中';
            card.querySelector('.stream-state').className = 'stream-state status on';
            log(`[${title}] 音频首个 RTP 包 ${meta.firstFrameAt.toFixed(0)} ms`, 'ok');
            clearInterval(meta.audioWatch);
          }
        });
      }, 200);
    }

    if (consumer.kind === 'video') {
      card.querySelectorAll('.layer-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            card.querySelectorAll('.layer-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            if (btn.dataset.mode === 'auto') {
              await sig.request('set-consumer-layers', { consumerId: consumer.id, mode: 'auto' });
              meta.manualEl.textContent = '自动（BWE 选层）';
              log(`[${title}] 已切回自动选层`, 'ok');
            } else {
              const spatialLayer = Number(btn.dataset.layer);
              await sig.request('set-consumer-layers', { consumerId: consumer.id, spatialLayer });
              meta.manualEl.textContent = `固定 S${spatialLayer}`;
              log(`[${title}] 请求固定层 S${spatialLayer}`, 'ok');
            }
          } catch (err) {
            log(`切层失败（已回显）：${err.message}`, 'err');
            btn.classList.remove('active');
          }
        });
      });
    }
    log(`订阅建立 [${title}] consumer=${consumer.id}`, 'ok');
  } catch (err) {
    log(`订阅 ${label || producerId} 失败：${err.message}`, 'err');
  }
}

// 每秒：浏览器端 getStats 与服务端 getStats 对照展示，全部为真实数值
async function pollStats() {
  if (!joined) return;
  const rows = [];
  for (const [cid, meta] of consumerMeta) {
    const s = await getReceiverStats(meta.consumer);
    const now = performance.now();
    const dt = (now - meta.lastT) / 1000;
    const kbps = s ? Math.max(0, ((s.bytesReceived - meta.lastBytes) * 8) / dt / 1000) : 0;
    meta.lastBytes = s?.bytesReceived || 0;
    meta.lastT = now;
    if (s) {
      meta.card.querySelector('.codec').textContent = s.codec || '-';
      meta.card.querySelector('.bitrate').textContent = `${kbps.toFixed(1)} kbps`;
      meta.card.querySelector('.loss').textContent =
        `丢包 ${s.packetsLost} / 收 ${s.packetsReceived}，抖动 ${(s.jitter || 0).toFixed(3)}s`;
      if (meta.kind === 'video') {
        meta.card.querySelector('.frames').textContent =
          `解码 ${s.framesDecoded}，丢弃 ${s.framesDropped}`;
      } else {
        const lvl = s.audioLevel == null ? '-' : `${(s.audioLevel * 100).toFixed(0)}%`;
        meta.card.querySelector('.alevel').textContent = lvl;
        const meter = meta.card.querySelector('.meter');
        if (meter) meter.style.width = s.audioLevel == null ? '0%' : `${s.audioLevel * 100}%`;
      }
    }
    rows.push({ meta, kbps, s });
  }
  try {
    const { stats } = await sig.request('get-stats');
    const recv = stats.transports.find((t) => t.direction === 'recv');
    // 用服务端权威 currentLayers 同步卡片徽章（layerschange 事件作为即时补充，轮询兜底）
    for (const c of stats.consumers) {
      const meta = consumerMeta.get(c.id);
      if (!meta) continue;
      const layers = c.currentLayers;
      meta.layerEl.className = layers?.spatialLayer != null ? `badge-l${layers.spatialLayer}` : '';
      meta.layerEl.textContent = layerText(layers);
      meta.manualEl.textContent = c.manualLayers ? `固定 S${c.manualLayers.spatialLayer}` : '自动（BWE 选层）';
    }
    $('statsArea').innerHTML = `
      <table>
        <thead><tr><th>订阅</th><th>类型</th><th>浏览器实测码率</th><th>SFU 侧 outbound 码率</th><th>当前空间层</th><th>带宽上限</th></tr></thead>
        <tbody>
          ${rows.map(({ meta, kbps }) => {
            const serverC = stats.consumers.find((c) => c.id === meta.consumer.id);
            const layers = serverC?.currentLayers;
            return `<tr>
              <td>${meta.label}</td><td>${meta.kind}</td>
              <td class="mono">${kbps.toFixed(1)} kbps</td>
              <td class="mono">${((serverC?.bitrate || 0) / 1000).toFixed(1)} kbps</td>
              <td class="mono ${layers?.spatialLayer != null ? 'badge-l' + layers.spatialLayer : ''}">${layerText(layers)}</td>
              <td class="mono">${recv?.maxOutgoingBitrate ? (recv.maxOutgoingBitrate / 1000).toFixed(0) + ' kbps' : '无'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p class="muted" style="margin-top:8px">
        接收 Transport：ICE=${recv?.iceState || '-'}，DTLS=${recv?.dtlsState || '-'}，
        SFU 累计向本学生发送 ${recv?.bytesSent?.toLocaleString() || 0} 字节。
      </p>`;
  } catch { /* 离开瞬间可能失败，忽略 */ }
}

async function applyCap() {
  try {
    const recv = device.recvTransport;
    const bitrate = Number($('bitrateInput').value) * 1000;
    await sig.request('set-max-bitrate', { transportId: recv.id, bitrate });
    log(`带宽上限已应用：${bitrate / 1000} kbps（SFU 侧 BWE 约束）`, 'ok');
  } catch (err) {
    log(`带宽限制失败（回显）：${err.message}`, 'err');
  }
}
async function removeCap() {
  try {
    await sig.request('set-max-bitrate', {
      transportId: device.recvTransport.id,
      bitrate: 10_000_000,
    });
    log('已解除带宽上限', 'ok');
  } catch (err) {
    log(`解除失败：${err.message}`, 'err');
  }
}

async function restartIce() {
  try {
    const { iceParameters } = await sig.request('restart-ice', { transportId: device.recvTransport.id });
    await device.recvTransport.updateIceParameters({ iceParameters });
    log('ICE 已重启，等待重新连通…', 'ok');
  } catch (err) {
    log(`ICE 重启失败：${err.message}`, 'err');
  }
}

function leave() {
  joined = false;
  clearInterval(statsTimer);
  device?.closeAll();
  sig.ws?.close();
  $('consumerArea').innerHTML = '';
  consumerMeta.clear();
  setStatus($('sigStatus'), '已离开', 'off');
  setMedia(false, '无可解码画面');
  setStatus($('iceStatus'), '-', 'off');
  $('joinBtn').disabled = false;
  log('已关闭接收 Transport 与全部 Consumer，服务端停止向本端发送（不再占用下行带宽）', 'warn');
}

async function rejoin() {
  leave();
  await new Promise((r) => setTimeout(r, 800));
  await joinRoom();
  log('重新加入完成：服务端已先回收旧 peer 资源，再建立全新订阅', 'ok');
}

$('joinBtn').addEventListener('click', joinRoom);
$('leaveBtn').addEventListener('click', leave);
$('rejoinBtn').addEventListener('click', rejoin);
$('iceBtn').addEventListener('click', restartIce);
$('capBtn').addEventListener('click', applyCap);
$('uncapBtn').addEventListener('click', removeCap);
statsTimer = setInterval(pollStats, 1000);
