import { CONFIG } from './config.js';
import { pickWorker } from './mediasoup-workers.js';

let roomSeq = 0;

/**
 * Room：一个 mediasoup Router 对应一间教室。
 * Router 只做 RTP 路由/转发与 Simulcast/SVC 层选择，不解码、不转码。
 */
export class Room {
  constructor(id) {
    this.id = id;
    this.worker = null;
    this.router = null;
    this.peers = new Map(); // peerId -> Peer
    this.seq = ++roomSeq;
  }

  static async create(id) {
    const room = new Room(id);
    room.worker = pickWorker();
    room.router = await room.worker.createRouter({
      mediaCodecs: CONFIG.mediasoup.routerMediaCodecs,
    });
    room.router.observer.on('close', () => console.log(`[room ${id}] router closed`));
    console.log(`[room ${id}] 已创建，rtpCapabilities 编解码数=${room.router.rtpCapabilities.codecs?.length}`);
    return room;
  }

  get producers() {
    const list = [];
    for (const peer of this.peers.values()) {
      for (const producer of peer.producers.values()) list.push(producer);
    }
    return list;
  }

  findProducer(producerId) {
    for (const peer of this.peers.values()) {
      const p = peer.producers.get(producerId);
      if (p) return { peer, producer: p };
    }
    return null;
  }

  findConsumer(consumerId) {
    for (const peer of this.peers.values()) {
      const c = peer.consumers.get(consumerId);
      if (c) return { peer, consumer: c };
    }
    return null;
  }

  // 同一 peerId 重新加入：先彻底回收旧节点的全部传输/订阅资源
  replacePeer(oldPeer) {
    if (oldPeer && !oldPeer.closed) {
      console.log(`[room ${this.id}] peer ${oldPeer.id} 重新加入，回收旧会话`);
      oldPeer.close('replaced-by-rejoin');
    }
  }

  snapshot() {
    return {
      roomId: this.id,
      routerClosed: this.router.closed,
      peers: [...this.peers.values()].map((p) => p.snapshot()),
    };
  }

  close() {
    for (const peer of [...this.peers.values()]) peer.close('room-closed');
    if (!this.router.closed) this.router.close();
  }
}

/**
 * Peer：一个浏览器连接（教师 / 学生 / 控制页）。
 * 信令（WebSocket 在线）与媒体（Transport/Producer/Consumer 可解码出画）分别建模。
 */
export class Peer {
  constructor(id, role, ws, room) {
    this.id = id;
    this.role = role; // teacher | student | controller
    this.ws = ws;
    this.room = room;
    this.rtpCapabilities = null;
    this.transports = new Map(); // id -> WebRtcTransport
    this.producers = new Map(); // id -> Producer
    this.consumers = new Map(); // id -> Consumer
    this.consumerLayers = new Map(); // consumerId -> 当前实际层（layerschange 上报）
    this.manualLayers = new Map(); // consumerId -> 手动指定层，null 表示自动
    this.bitrateCaps = new Map(); // recvTransportId -> bps 上限
    this.closed = false;
    this.joinedAt = Date.now();
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  notifyOthers(event) {
    for (const peer of this.room.peers.values()) {
      if (peer.id !== this.id && peer.role !== 'controller') peer.send(event);
    }
    // 控制页始终同步全部事件
    for (const peer of this.room.peers.values()) {
      if (peer.role === 'controller') peer.send(event);
    }
  }

  notifyControllers(event) {
    for (const peer of this.room.peers.values()) {
      if (peer.role === 'controller') peer.send(event);
    }
  }

  broadcast(event) {
    for (const peer of this.room.peers.values()) peer.send(event);
  }

  async createWebRtcTransport({ direction }) {
    const transport = await this.room.router.createWebRtcTransport({
      ...CONFIG.mediasoup.webRtcTransport,
      appData: { peerId: this.id, direction },
    });
    this.transports.set(transport.id, transport);

    transport.on('icestatechange', (iceState) => {
      console.log(`[ice] peer=${this.id} transport=${transport.id} -> ${iceState}`);
      this.send({ type: 'ice-state', transportId: transport.id, iceState });
      this.notifyControllers({
        type: 'ice-state',
        peerId: this.id,
        transportId: transport.id,
        iceState,
      });
    });
    transport.on('dtlsstatechange', (dtlsState) => {
      this.send({ type: 'dtls-state', transportId: transport.id, dtlsState });
    });
    // 传输被对端关闭或 ICE 失败终结时回收
    transport.observer.on('close', () => {
      this.transports.delete(transport.id);
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport({ transportId, dtlsParameters }) {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error(`transport ${transportId} 不存在`);
    await transport.connect({ dtlsParameters });
  }

  async produce({ transportId, kind, rtpParameters, appData }) {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error(`transport ${transportId} 不存在`);
    const producer = await transport.produce({ kind, rtpParameters, appData: { ...appData, peerId: this.id } });
    this.producers.set(producer.id, producer);

    producer.on('score', (score) => {
      this.send({ type: 'producer-score', producerId: producer.id, score });
      this.notifyControllers({ type: 'producer-score', peerId: this.id, producerId: producer.id, score });
    });
    producer.observer.on('close', () => {
      this.producers.delete(producer.id);
      this.broadcast({ type: 'producer-closed', producerId: producer.id, peerId: this.id });
    });

    // 通知房间内已有学生：新的媒体轨道可用（学生端据此发起订阅）
    this.notifyOthers({
      type: 'new-producer',
      producer: {
        id: producer.id,
        peerId: this.id,
        kind: producer.kind,
        mimeType: rtpParameters.codecs?.[0]?.mimeType,
        appData: producer.appData,
      },
    });
    console.log(`[produce] peer=${this.id} kind=${kind} label=${appData?.label || ''} id=${producer.id}`);
    return { id: producer.id };
  }

  async consume({ transportId, producerId }) {
    if (!this.rtpCapabilities) throw new Error('尚未上报 rtpCapabilities');
    const found = this.room.findProducer(producerId);
    if (!found) throw new Error(`producer ${producerId} 不存在或已退出`);
    const { producer } = found;
    if (!this.room.router.canConsume({ producerId, rtpCapabilities: this.rtpCapabilities })) {
      throw new Error('本机 RTP 能力无法消费该 Producer（编解码不兼容）');
    }
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error(`transport ${transportId} 不存在`);

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: this.rtpCapabilities,
      paused: true, // 标准流程：先建立 Consumer，客户端完成连接后再 resume
      appData: { producerPeerId: found.peer.id, label: producer.appData?.label || '' },
    });
    this.consumers.set(consumer.id, consumer);
    this.manualLayers.set(consumer.id, null); // 默认自动：由 BWE 决定层级

    consumer.on('layerschange', (layers) => {
      // 这是 SFU 实际转发给该学生的空间/时间层（null 表示暂停或暂无可解码帧）
      this.consumerLayers.set(consumer.id, layers);
      this.send({ type: 'consumer-layers', consumerId: consumer.id, layers });
      this.notifyControllers({
        type: 'consumer-layers',
        peerId: this.id,
        consumerId: consumer.id,
        layers,
      });
    });
    consumer.on('score', (score) => {
      this.send({ type: 'consumer-score', consumerId: consumer.id, score });
      this.notifyControllers({ type: 'consumer-score', peerId: this.id, consumerId: consumer.id, score });
    });
    consumer.on('producerclose', () => {
      // 生产者退出：服务端主动关闭订阅并通知，学生端媒体状态变为“无画面”，但信令仍在线
      this.consumers.delete(consumer.id);
      if (!consumer.closed) consumer.close();
      this.send({ type: 'consumer-closed', consumerId: consumer.id, reason: 'producer-closed' });
    });
    consumer.observer.on('close', () => {
      this.consumers.delete(consumer.id);
      this.consumerLayers.delete(consumer.id);
      this.manualLayers.delete(consumer.id);
    });

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      mimeType: consumer.rtpParameters.codecs?.[0]?.mimeType,
      paused: consumer.paused,
      producerPaused: consumer.producerPaused,
      appData: consumer.appData,
    };
  }

  async resumeConsumer({ consumerId }) {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) throw new Error(`consumer ${consumerId} 不存在`);
    await consumer.resume();
  }

  /**
   * 手动切换订阅层（真实的 Simulcast/SVC 空间层选择，不是改 CSS 尺寸）。
   * mode='auto'：把偏好上限放宽到生产者最高空间层，交还给 mediasoup BWE
   *              在 0~最高层间按带宽自动选层。
   * 说明：mediasoup 3.32 的 Consumer 没有 unsetPreferredLayers()，preferredLayers
   *       在 worker 中是“不得超过的空间层上限”，因此自动模式 = 上限设为最高层。
   */
  async setConsumerLayers({ consumerId, spatialLayer, temporalLayer, mode }) {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) throw new Error(`consumer ${consumerId} 不存在`);
    if (mode === 'auto') {
      // 生产者 Simulcast/SVC 的空间层数量；取不到时按本系统三层兜底
      const found = this.room.findProducer(consumer.producerId);
      const encodings = found?.producer.rtpParameters?.encodings || [];
      const maxSpatial = Math.max(0, encodings.length - 1, 2);
      const pref = { spatialLayer: maxSpatial };
      await consumer.setPreferredLayers(pref);
      this.manualLayers.set(consumerId, null); // null 表示自动（无人工固定层）
      consumer.requestKeyFrame().catch(() => {});
    } else {
      const pref = { spatialLayer };
      if (temporalLayer !== undefined && temporalLayer !== null) pref.temporalLayer = temporalLayer;
      await consumer.setPreferredLayers(pref);
      this.manualLayers.set(consumerId, pref);
      consumer.requestKeyFrame().catch(() => {});
    }
    return this.manualLayers.get(consumerId);
  }

  /**
   * 限制该学生接收方向 Transport 的最大出向码率（bps）。
   * mediasoup 在 Transport BWE 中生效，带宽不足时 Simulcast 自动降到低空间层。
   * 这是真实网络层码率约束，与页面视频元素尺寸无关。
   */
  async setMaxOutgoingBitrate({ transportId, bitrate }) {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error(`transport ${transportId} 不存在`);
    await transport.setMaxOutgoingBitrate(bitrate);
    this.bitrateCaps.set(transportId, bitrate);
    return { transportId, bitrate };
  }

  async restartIce({ transportId }) {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error(`transport ${transportId} 不存在`);
    const iceParameters = await transport.restartIce();
    console.log(`[ice] peer=${this.id} transport=${transportId} 已重启 ICE`);
    return { iceParameters };
  }

  // 聚合真实统计：服务端侧字节/码率/层/评分，全部来自 mediasoup getStats 与事件
  async getStats() {
    const transports = [];
    for (const t of this.transports.values()) {
      const stats = await t.getStats();
      const tuple = stats.find((s) => s.type === 'transport') || {};
      transports.push({
        id: t.id,
        direction: t.appData?.direction,
        iceState: t.iceState,
        dtlsState: t.dtlsState,
        bytesReceived: tuple.bytesReceived || 0,
        bytesSent: tuple.bytesSent || 0,
        recvBitrate: tuple.recvBitrate || 0, // bps，mediasoup 实测
        sentBitrate: tuple.sentBitrate || 0,
        maxOutgoingBitrate: this.bitrateCaps.get(t.id) ?? null,
      });
    }
    const producers = [];
    for (const p of this.producers.values()) {
      const stats = await p.getStats();
      const rtp = stats.find((s) => s.type === 'inbound-rtp') || {};
      producers.push({
        id: p.id,
        kind: p.kind,
        label: p.appData?.label || '',
        mimeType: rtp.mimeType || p.rtpParameters?.codecs?.[0]?.mimeType,
        bytesReceived: rtp.bytesReceived || 0,
        bitrate: rtp.bitrate || 0,
        jitter: rtp.jitter || 0,
        score: p.score,
        paused: p.paused,
      });
    }
    const consumers = [];
    for (const c of this.consumers.values()) {
      const stats = await c.getStats();
      const rtp = stats.find((s) => s.type === 'outbound-rtp') || {};
      consumers.push({
        id: c.id,
        producerId: c.producerId,
        kind: c.kind,
        label: c.appData?.label || '',
        mimeType: rtp.mimeType || c.rtpParameters?.codecs?.[0]?.mimeType,
        bytesSent: rtp.bytesSent || 0,
        bitrate: rtp.bitrate || 0,
        currentLayers: this.consumerLayers.get(c.id) ?? null,
        manualLayers: this.manualLayers.get(c.id) ?? null,
        score: c.score,
        paused: c.paused,
        producerPaused: c.producerPaused,
        firCount: rtp.firCount || 0,
        pliCount: rtp.pliCount || 0,
        nackCount: rtp.nackCount || 0,
      });
    }
    return { peerId: this.id, role: this.role, transports, producers, consumers };
  }

  snapshot() {
    return {
      id: this.id,
      role: this.role,
      closed: this.closed,
      joinedAt: this.joinedAt,
      rtpCapabilitiesReady: Boolean(this.rtpCapabilities),
      transports: [...this.transports.values()].map((t) => ({
        id: t.id,
        direction: t.appData?.direction,
        iceState: t.iceState,
        dtlsState: t.dtlsState,
        maxOutgoingBitrate: this.bitrateCaps.get(t.id) ?? null,
      })),
      producers: [...this.producers.values()].map((p) => ({
        id: p.id,
        kind: p.kind,
        label: p.appData?.label || '',
        paused: p.paused,
      })),
      consumers: [...this.consumers.values()].map((c) => ({
        id: c.id,
        producerId: c.producerId,
        kind: c.kind,
        label: c.appData?.label || '',
        paused: c.paused,
        currentLayers: this.consumerLayers.get(c.id) ?? null,
        manualLayers: this.manualLayers.get(c.id) ?? null,
      })),
    };
  }

  // 离开/被替换/教师退出时的完整资源回收
  close(reason = 'peer-left') {
    if (this.closed) return;
    this.closed = true;
    for (const consumer of [...this.consumers.values()]) {
      if (!consumer.closed) consumer.close();
    }
    this.consumers.clear();
    for (const producer of [...this.producers.values()]) {
      if (!producer.closed) producer.close();
    }
    this.producers.clear();
    for (const transport of [...this.transports.values()]) {
      if (!transport.closed) transport.close();
    }
    this.transports.clear();
    this.consumerLayers.clear();
    this.manualLayers.clear();
    this.bitrateCaps.clear();
    this.room.peers.delete(this.id);

    // 通知其他在线节点：信令层面的离开
    for (const peer of this.room.peers.values()) {
      peer.send({ type: 'peer-left', peerId: this.id, reason });
    }
    console.log(`[peer] ${this.id}(${this.role}) 已关闭，原因=${reason}，剩余节点=${this.room.peers.size}`);
    try {
      this.send({ type: 'session-ended', reason });
    } catch { /* ws 可能已关闭 */ }
  }
}
