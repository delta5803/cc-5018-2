const { Device } = window.mediasoupClient;

/**
 * Signaling：WebSocket 信令通道。
 * 信令只负责建立/协商媒体，与“是否已收到可解码画面”是两个独立状态。
 */
export class Signaling {
  constructor() {
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.ok ? resolve(msg) : reject(new Error(msg.error || '请求失败'));
        } else if (msg.type) {
          (this.listeners.get(msg.type) || []).forEach((fn) => fn(msg));
        }
      };
      this.ws.onclose = () => this.emit('socket-close', {});
    });
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  emit(type, payload) {
    (this.listeners.get(type) || []).forEach((fn) => fn(payload));
  }

  request(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, ...params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`请求 ${method} 超时`));
        }
      }, 10000);
    });
  }
}

/**
 * MediasoupDevice：封装 mediasoup-client 的 Device 与 Transport 生命周期。
 * 所有媒体真实经过 SFU，页面视频元素只负责显示，不参与“降码率”。
 */
export class MediasoupDevice {
  constructor(signaling) {
    this.signaling = signaling;
    this.device = new Device();
    this.sendTransport = null;
    this.recvTransport = null;
    this.producers = new Map();
    this.consumers = new Map();
  }

  async load(routerRtpCapabilities) {
    await this.device.load({ routerRtpCapabilities });
  }

  get rtpCapabilities() {
    return this.device.rtpCapabilities;
  }

  async createSendTransport() {
    const { transport } = await this.signaling.request('create-transport', { direction: 'send' });
    this.sendTransport = this.device.createSendTransport(transport);
    this._wireTransport(this.sendTransport);
    return this.sendTransport;
  }

  async createRecvTransport() {
    const { transport } = await this.signaling.request('create-transport', { direction: 'recv' });
    this.recvTransport = this.device.createRecvTransport(transport);
    this._wireTransport(this.recvTransport);
    return this.recvTransport;
  }

  _wireTransport(t) {
    t.on('connect', ({ dtlsParameters }, resolve, reject) => {
      this.signaling
        .request('connect-transport', { transportId: t.id, dtlsParameters })
        .then(resolve)
        .catch(reject);
    });
    t.on('produce', async ({ kind, rtpParameters, appData }, resolve, reject) => {
      try {
        const { id } = await this.signaling.request('produce', {
          transportId: t.id,
          kind,
          rtpParameters,
          appData,
        });
        resolve({ id });
      } catch (err) {
        reject(err);
      }
    });
    t.on('connectionstatechange', (state) => {
      this.signaling.emit('client-connection-state', { transportId: t.id, state });
    });
  }

  async produce(track, appData = {}, encodings) {
    if (!this.sendTransport) await this.createSendTransport();
    const producer = await this.sendTransport.produce({ track, appData, ...(encodings ? { encodings } : {}) });
    this.producers.set(producer.id, producer);
    return producer;
  }

  // 订阅一个远端 Producer，返回 mediasoup-client Consumer（paused 由服务端控制）
  async consume(producerId, recvTransportId) {
    const { consumer: info } = await this.signaling.request('consume', {
      transportId: recvTransportId || this.recvTransport?.id,
      producerId,
    });
    const consumer = await this.recvTransport.consume({
      id: info.id,
      producerId: info.producerId,
      kind: info.kind,
      rtpParameters: info.rtpParameters,
      appData: info.appData,
    });
    this.consumers.set(consumer.id, consumer);
    await this.signaling.request('resume-consumer', { consumerId: consumer.id });
    return { consumer, info };
  }

  closeAll() {
    for (const p of this.producers.values()) p.close();
    for (const c of this.consumers.values()) c.close();
    this.producers.clear();
    this.consumers.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
  }
}

export const LAYER_NAMES = ['低 (S0)', '中 (S1)', '高 (S2)'];

export function layerText(layers) {
  if (!layers || layers.spatialLayer === undefined || layers.spatialLayer === null) return '无（暂无可解码帧）';
  const s = LAYER_NAMES[layers.spatialLayer] || `S${layers.spatialLayer}`;
  const t = layers.temporalLayer ?? '-';
  return `${s} / 时间层 T${t}`;
}

// 读取 PC 端真实 getStats（接收侧），用于页面展示，不使用固定演示数值
export async function getReceiverStats(consumer) {
  if (!consumer || !consumer.track) return null;
  const recv = consumer.rtpReceiver;
  if (!recv || typeof recv.getStats !== 'function') return null;
  // 直接用 RTCRtpReceiver.getStats()（W3C 标准 API），按 track 标识匹配本路 inbound
  const report = await recv.getStats();
  const trackId = consumer.track.id;
  let inbound = null;
  let codec = null;
  let audioLevel = null;
  let totalPacketsLost = 0;
  let totalPacketsReceived = 0;
  let framesDecoded = 0;
  let framesDropped = 0;
  let jitter = 0;
  for (const s of report.values()) {
    if (s.type === 'inbound-rtp' && s.kind === consumer.kind &&
        (s.trackIdentifier === trackId || s.trackId === trackId || !inbound)) {
      inbound = s;
    }
  }
  if (inbound) {
    for (const s of report.values()) {
      if (s.type === 'codec' && s.id === inbound.codecId) codec = s;
    }
    totalPacketsLost = inbound.packetsLost || 0;
    totalPacketsReceived = inbound.packetsReceived || 0;
    jitter = inbound.jitter || 0;
    if (consumer.kind === 'video') {
      framesDecoded = inbound.framesDecoded || 0;
      framesDropped = inbound.framesDropped || 0;
    }
    if (consumer.kind === 'audio') audioLevel = inbound.audioLevel ?? null;
  }
  return {
    inbound,
    codec: codec ? `${codec.mimeType}${codec.sdpFmtpLine ? ' ' + codec.sdpFmtpLine : ''}` : (inbound?.codecId || ''),
    packetsLost: totalPacketsLost,
    packetsReceived: totalPacketsReceived,
    jitter,
    framesDecoded,
    framesDropped,
    audioLevel,
    bytesReceived: inbound?.bytesReceived || 0,
  };
}
