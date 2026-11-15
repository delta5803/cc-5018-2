import { Signaling, MediasoupDevice } from './common.js';
import { makeLabeledCanvas, makeToneStream, videoSimulcastEncodings } from './test-media.js';

const $ = (id) => document.getElementById(id);
const sig = new Signaling();
let device = null;
let cleanupFns = [];
let statsTimer = null;
let audioCtx = null;
let joined = false;

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

async function buildTestStreams() {
  // 两路独立动态画布 + 一路正弦音频
  const cam = makeLabeledCanvas('CAMERA 摄像头', { color: '#0b3d91' });
  const bench = makeLabeledCanvas('BENCH 实验台', { color: '#5b1d8f', width: 1280, height: 720 });
  const tone = makeToneStream({ freq: 440 });
  cleanupFns.push(cam.stop, bench.stop, tone.stop);
  const camStream = cam.canvas.captureStream(15);
  const benchStream = bench.canvas.captureStream(15);
  $('camVideo').srcObject = camStream;
  $('benchVideo').srcObject = benchStream;
  return {
    camTrack: camStream.getVideoTracks()[0],
    benchTrack: benchStream.getVideoTracks()[0],
    micTrack: tone.stream.getAudioTracks()[0],
  };
}

async function buildDeviceStreams() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720 },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  cleanupFns.push(() => stream.getTracks().forEach((t) => t.stop()));
  $('camVideo').srcObject = stream;
  // 实验台无第二路物理设备时复用同一视频轨道（真实场景通常用第二个摄像头/采集卡）
  const bench = new MediaStream([stream.getVideoTracks()[0].clone()]);
  $('benchVideo').srcObject = bench;
  return {
    camTrack: stream.getVideoTracks()[0],
    benchTrack: bench.getVideoTracks()[0],
    micTrack: stream.getAudioTracks()[0],
  };
}

async function startAudioMeter(track) {
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    $('audioMeter').style.width = `${Math.min(100, (avg / 128) * 100)}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

async function join() {
  try {
    setStatus($('sigStatus'), '连接中…', 'warn');
    await sig.connect();
    const { rtpCapabilities } = await sig.request('join', {
      roomId: $('roomId').value.trim(),
      peerId: $('peerId').value.trim(),
      role: 'teacher',
    });
    device = new MediasoupDevice(sig);
    await device.load(rtpCapabilities);
    joined = true;
    setStatus($('sigStatus'), '已加入（信令在线，尚无媒体）', 'info');
    log('信令已就绪并加载 mediasoup Device。注意：加入房间不代表已出画。', 'ev');
    $('joinBtn').disabled = true;
    $('publishBtn').disabled = false;
    $('shareBtn').disabled = false;
    $('leaveBtn').disabled = false;

    sig.on('ice-state', ({ iceState }) => {
      const cls = iceState === 'completed' || iceState === 'connected' ? 'on' : iceState === 'failed' ? 'off' : 'warn';
      setStatus($('iceStatus'), iceState, cls);
      log(`ICE 状态变化：${iceState}`, iceState === 'failed' ? 'err' : 'ev');
    });
    sig.on('socket-close', () => {
      setStatus($('sigStatus'), 'WebSocket 断开', 'off');
      log('信令 WebSocket 断开', 'err');
    });
    sig.on('session-ended', ({ reason }) => log(`会话被服务端结束：${reason}`, 'warn'));
  } catch (err) {
    log(`加入失败：${err.message}`, 'err');
    setStatus($('sigStatus'), '失败', 'off');
  }
}

async function publish() {
  try {
    setStatus($('mediaStatus'), '建立发送通道…', 'warn');
    const { camTrack, benchTrack, micTrack } =
      $('mediaSource').value === 'test' ? await buildTestStreams() : await buildDeviceStreams();

    await device.createSendTransport();
    const encodings = videoSimulcastEncodings();
    // 三路 Producer：两路视频均为三层 Simulcast，一路音频
    await device.produce(camTrack, { label: 'camera' }, encodings);
    await device.produce(benchTrack, { label: 'bench' }, encodings);
    await device.produce(micTrack, { label: 'mic' });
    await startAudioMeter(micTrack);

    setStatus($('mediaStatus'), '发布中（3 路 Producer）', 'on');
    log('已发布 camera / bench（VP8 Simulcast x3 层）与 mic（Opus）', 'ok');
    $('publishBtn').disabled = true;
    startStatsPolling();
  } catch (err) {
    log(`发布失败：${err.message}`, 'err');
    setStatus($('mediaStatus'), '发布失败', 'off');
  }
}

async function shareScreen() {
  try {
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: { width: 1280, height: 720 } });
    const track = screen.getVideoTracks()[0];
    await device.produce(track, { label: 'screen' }, videoSimulcastEncodings());
    track.addEventListener('ended', () => {
      const p = [...device.producers.values()].find((x) => x.appData?.label === 'screen');
      p?.close();
    });
    log('已追加屏幕共享 Producer（screen）', 'ok');
  } catch (err) {
    log(`屏幕共享失败：${err.message}`, 'err');
  }
}

function renderProducerStats(containerId, p) {
  const el = $(containerId);
  const layerInfo = p.kind === 'video'
    ? `Simulcast 三层同时编码发送，服务端入向总码率 ${(p.bitrate / 1000).toFixed(0)} kbps`
    : `Opus 码率 ${(p.bitrate / 1000).toFixed(0)} kbps`;
  el.innerHTML = `
    <b>类型</b><span>${p.mimeType || p.kind}</span>
    <b>入向字节</b><span class="mono">${p.bytesReceived.toLocaleString()} B</span>
    <b>实时码率</b><span class="mono">${(p.bitrate / 1000).toFixed(1)} kbps</span>
    <b>抖动</b><span class="mono">${(p.jitter || 0).toFixed(3)} s</span>
    <b>评分</b><span class="mono">${p.score?.[0]?.score ?? '-'} (ssrc score)</span>
    <b>分层</b><span>${layerInfo}</span>`;
}

function startStatsPolling() {
  statsTimer = setInterval(async () => {
    if (!joined) return;
    try {
      const { stats } = await sig.request('get-stats');
      const cam = stats.producers.find((p) => p.label === 'camera');
      const bench = stats.producers.find((p) => p.label === 'bench');
      if (cam) renderProducerStats('camStats', cam);
      if (bench) renderProducerStats('benchStats', bench);

      const t = stats.transports[0];
      const totalKbps = (stats.producers.reduce((a, p) => a + p.bitrate, 0)) / 1000;
      $('serverStats').innerHTML = `
        <table>
          <thead><tr><th>Producer</th><th>类型</th><th>码率(kbps)</th><th>累计字节</th><th>评分</th></tr></thead>
          <tbody>
            ${stats.producers.map((p) => `<tr>
              <td>${p.label}</td><td>${p.kind}</td>
              <td class="mono">${(p.bitrate / 1000).toFixed(1)}</td>
              <td class="mono">${p.bytesReceived.toLocaleString()}</td>
              <td class="mono">${p.score?.[0]?.score ?? '-'}</td></tr>`).join('')}
          </tbody>
        </table>
        <p class="muted" style="margin-top:8px">
          发送 Transport ICE=${t?.iceState || '-'} DTLS=${t?.dtlsState || '-'}，
          服务端接收总码率 <b class="mono">${totalKbps.toFixed(1)} kbps</b>，
          累计接收 ${t?.bytesReceived?.toLocaleString() || 0} 字节。
          这是 SFU 实测入流量，不是页面估算。
        </p>`;
    } catch (err) {
      log(`统计获取失败：${err.message}`, 'err');
    }
  }, 1000);
}

function leave() {
  joined = false;
  clearInterval(statsTimer);
  device?.closeAll();
  cleanupFns.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  cleanupFns = [];
  audioCtx?.close().catch(() => {});
  setStatus($('mediaStatus'), '已停止发布', 'off');
  setStatus($('iceStatus'), '-', 'off');
  log('已关闭所有 Producer 与 Transport；服务端将停止向学生转发', 'warn');
  $('publishBtn').disabled = false;
  // 关闭 WS 触发服务端 peer.close 完整回收
  sig.ws?.close();
  setStatus($('sigStatus'), '已离开', 'off');
}

$('joinBtn').addEventListener('click', join);
$('publishBtn').addEventListener('click', publish);
$('shareBtn').addEventListener('click', shareScreen);
$('leaveBtn').addEventListener('click', leave);
