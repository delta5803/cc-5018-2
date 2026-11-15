// 独立信令探针：以 controller 身份接入，直接取 mediasoup 内核 room-snapshot，
// 用于在测试中独立核验转发码率、实际层、带宽上限与资源清理（不依赖页面 DOM）。
const WebSocket = require('ws');

const BASE_WS = process.env.BASE_WS || 'ws://localhost:3000/ws';

class CoreProbe {
  constructor(roomId) {
    this.roomId = roomId;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE_WS);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.ok ? resolve(msg) : reject(new Error(msg.error));
        }
      });
    });
  }

  request(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, ...params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 8000);
    });
  }

  async join() {
    await this.connect();
    await this.request('join', {
      roomId: this.roomId,
      peerId: `probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'controller',
    });
  }

  async snapshot() {
    const { snapshot, stats } = await this.request('room-snapshot');
    return { snapshot, stats };
  }

  // 汇总某个学生的所有 video consumer 的实际空间层与 SFU 出向码率
  async studentVideo(peerId) {
    const { stats } = await this.snapshot();
    const st = stats.find((s) => s.peerId === peerId);
    if (!st) return null;
    const videos = st.consumers
      .filter((c) => c.kind === 'video')
      .map((c) => ({
        label: c.label,
        bitrate: c.bitrate,
        spatialLayer: c.currentLayers?.spatialLayer ?? null,
        temporalLayer: c.currentLayers?.temporalLayer ?? null,
        manualLayers: c.manualLayers,
        bytesSent: c.bytesSent,
        paused: c.paused,
      }));
    const recv = st.transports.find((t) => t.direction === 'recv');
    return {
      videos,
      totalOutBitrate: st.consumers.reduce((a, c) => a + c.bitrate, 0),
      audioBitrate: st.consumers.filter((c) => c.kind === 'audio').reduce((a, c) => a + c.bitrate, 0),
      transportOpen: Boolean(recv),
      iceState: recv?.iceState || null,
      maxOutgoingBitrate: recv?.maxOutgoingBitrate ?? null,
      bytesSent: recv?.bytesSent || 0,
      consumerCount: st.consumers.length,
    };
  }

  async peerExists(peerId) {
    const { snapshot } = await this.snapshot();
    return snapshot.peers.some((p) => p.id === peerId);
  }

  async setBitrate(targetPeerId, bitrate) {
    const { stats } = await this.snapshot();
    const st = stats.find((s) => s.peerId === targetPeerId);
    const recv = st?.transports.find((t) => t.direction === 'recv');
    if (!recv) throw new Error('目标无接收 Transport');
    return this.request('control-set-bitrate', { targetPeerId, transportId: recv.id, bitrate });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

module.exports = { CoreProbe };
