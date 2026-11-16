import { CONFIG } from './config.js';
import { pickWorker } from './mediasoup-workers.js';
import { planScheme, DEFAULT_AUDIO_RESERVE_BPS, DEFAULT_TRANSPORT_OVERHEAD } from './scheduler.js';

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
    // 调度原型状态：最近一次实际下发到转发入口的决策与依据
    this.scheduling = {
      scheme: null,
      appliedAt: null,
      audioReserveBps: null,
      groupPeerIds: [],
      receiverBudgets: {},
      plan: null,
      applied: [],
      errors: [],
    };
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
      scheduling: this.scheduling,
      peers: [...this.peers.values()].map((p) => p.snapshot()),
    };
  }

  /**
   * 收集一个学生的全部视频订阅成本，按“接收者”聚合。
   *
   * VP8 Simulcast 的关键事实：三层是三个独立的 RTP 流（各带 rid），
   * producer.getStats() 会返回多条 inbound-rtp，每条对应一个空间层；
   * 单条内部的 bitrateByLayer 是时间层成本，不是空间层。
   * 因此必须按 rid / encoding 下标映射空间层，不能只取第一条统计。
   *
   * SVC（VP9 L3T3）则是单流内多空间层，此时用 bitrateByLayer 的 "s.t" 键。
   *
   * 成本来源：实测优先（source=measured），否则退回 encodings.maxBitrate
   * （source=configured，属待验假设），都没有则 missing，绝不按 0 参与选层。
   *
   * 关键：setMaxOutgoingBitrate 限制整条接收 Transport，所以这里把一个学生的
   * 所有视频订阅都收进来，用 scheduled 标记哪些是本轮要改层的；未调度的视频
   * 仍占用同一条出向预算，必须按其当前层成本计入，不能当它不存在。
   */
  async collectReceiverCosts(peer, label) {
    const streams = [];
    const producerStatsCache = new Map();
    for (const consumer of peer.consumers.values()) {
      if (consumer.kind !== 'video') continue;
      const consumerLabel = consumer.appData?.label || '';
      const found = this.findProducer(consumer.producerId);
      if (!found) continue;
      const producer = found.producer;
      let stats = producerStatsCache.get(producer.id);
      if (!stats) {
        stats = (await producer.getStats()).filter((s) => s.type === 'inbound-rtp');
        producerStatsCache.set(producer.id, stats);
      }
      const encodings = producer.rtpParameters?.encodings || [];
      const ridToIndex = new Map();
      encodings.forEach((enc, idx) => { if (enc.rid) ridToIndex.set(enc.rid, idx); });

      // 空间层成本表：下标 = 空间层
      const measured = new Map();
      let svcLayerMap = null;
      for (const s of stats) {
        const streamSpatial = Number.isFinite(ridToIndex.get(s.rid)) ? ridToIndex.get(s.rid) : (stats.length === 1 ? 0 : null);
        if (streamSpatial != null) {
          // Simulcast：整条流的 bitrate 就是该空间层的实测成本
          const prev = measured.get(streamSpatial);
          if (prev == null || (s.bitrate || 0) > prev) measured.set(streamSpatial, s.bitrate || null);
        }
        // SVC：单流内 bitrateByLayer 键为 "spatial.temporal"
        const byLayer = s.bitrateByLayer || {};
        if (Object.keys(byLayer).length) {
          if (!svcLayerMap) svcLayerMap = new Map();
          for (const [key, bps] of Object.entries(byLayer)) {
            const [sp] = key.split('.').map(Number);
            if (!Number.isFinite(sp) || !Number.isFinite(bps) || bps <= 0) continue;
            const prev = svcLayerMap.get(sp);
            if (prev == null || bps > prev) svcLayerMap.set(sp, bps);
          }
        }
      }

      const layerIndices = new Set([...measured.keys(), ...(svcLayerMap ? svcLayerMap.keys() : [])]);
      encodings.forEach((_, idx) => layerIndices.add(idx));
      const layerCount = layerIndices.size ? Math.max(...layerIndices) + 1 : 1;
      const costs = [];
      for (let s = 0; s < layerCount; s++) {
        const configuredBps = encodings[s]?.maxBitrate ?? null;
        const measuredBps = measured.get(s) ?? svcLayerMap?.get(s) ?? null;
        const bps = measuredBps ?? configuredBps ?? null;
        costs.push({
          spatialLayer: s,
          bps,
          source: measuredBps != null ? 'measured' : configuredBps != null ? 'configured' : 'missing',
          measuredBps,
          configuredBps,
        });
      }
      const currentLayer = peer.consumerLayers.get(consumer.id)?.spatialLayer ?? null;
      const currentCost = currentLayer == null ? null : costs.find((c) => c.spatialLayer === currentLayer);
      streams.push({
        consumerId: consumer.id,
        producerId: producer.id,
        label: consumerLabel,
        // 未指定 label 表示调度全部视频；指定了则只调度匹配的那一路，
        // 其余视频仍占同一接收 Transport 的出向预算。
        scheduled: !label || consumerLabel === label,
        costs,
        currentLayer,
        currentCostBps: currentCost?.bps ?? null,
        currentCostSource: currentCost?.source ?? 'missing',
      });
    }
    return streams;
  }

  /**
   * 教学转发原型真正的生产接点：
   *   1) 每个接收者轨迹预算 + 该接收 Transport 的 BWE 实测；
   *   2) 按方案计算逐 Consumer 的目标空间层与出向预算；
   *   3) 调 Consumer.setPreferredLayers() 与 WebRtcTransport.setMaxOutgoingBitrate()。
   * 任何一步失败都逐条记入 errors 返回给控制页，不用默认值掩盖。
   */
  async applySchedulingScheme({
    scheme,
    groupPeerIds = [],
    receiverBudgets = {},
    audioReserveBps = DEFAULT_AUDIO_RESERVE_BPS,
    transportOverhead = DEFAULT_TRANSPORT_OVERHEAD,
    label = null,
  }) {
    if (!['per-receiver', 'group-shared'].includes(scheme)) {
      throw new Error(`未知调度方案 ${scheme}`);
    }
    const peers = groupPeerIds.map((id) => this.peers.get(id)).filter(Boolean);
    if (!peers.length) throw new Error('共同层组为空：请选择至少一个在线学生');

    // 读取每个接收者 Transport 的 BWE（真实网络估计）
    const bweByTransport = new Map();
    for (const peer of peers) {
      for (const transport of peer.transports.values()) {
        if (transport.appData?.direction !== 'recv') continue;
        try {
          const stats = await transport.getStats();
          const tuple = stats.find((s) => s.type === 'webrtc-transport');
          bweByTransport.set(transport.id, {
            availableOutgoingBitrate: tuple?.availableOutgoingBitrate ?? null,
            maxOutgoingBitrate: tuple?.maxOutgoingBitrate ?? null,
          });
        } catch (err) {
          bweByTransport.set(transport.id, { error: err.message });
        }
      }
    }

    const receivers = [];
    for (const peer of peers) {
      const streams = await this.collectReceiverCosts(peer, label);
      if (!streams.some((s) => s.scheduled)) continue;
      // 接收者级：预算跟人走，选层按该接收 Transport 上全部视频合计
      const budgetBps = Number(receiverBudgets[peer.id] ?? NaN);
      const recvTransportId = streams
        .map((s) => peer.consumerTransports.get(s.consumerId))
        .find(Boolean) ?? null;
      const bwe = bweByTransport.get(recvTransportId);
      receivers.push({
        peerId: peer.id,
        transportId: recvTransportId,
        streams,
        budgetBps: Number.isFinite(budgetBps) ? budgetBps : null,
        budgetSource: Number.isFinite(budgetBps) ? 'input' : 'unset',
        bweBps: Number.isFinite(bwe?.availableOutgoingBitrate) ? bwe.availableOutgoingBitrate : null,
      });
    }
    if (!receivers.length) throw new Error('所选学生没有可调度的视频订阅');

    const plan = planScheme(scheme, receivers, { audioReserveBps, transportOverhead });

    const applied = [];
    const errors = [];
    const requested = new Map();
    for (const d of plan.receivers) {
      if (d.requestedSpatialLayer == null) {
        errors.push({ peerId: d.peerId, stage: 'plan', message: `未选层：${d.reason}` });
        continue;
      }
      for (const s of d.streams) {
        if (!s.scheduled) continue;
        if (s.requestedSpatialLayer == null) {
          errors.push({ peerId: d.peerId, consumerId: s.consumerId, stage: 'plan', message: `未选层：${d.reason}` });
          continue;
        }
        const found = this.findConsumer(s.consumerId);
        if (!found) {
          errors.push({ peerId: d.peerId, consumerId: s.consumerId, stage: 'plan', message: 'Consumer 已不存在' });
          continue;
        }
        requested.set(s.consumerId, { decision: d, stream: s, found });
      }
    }

    // 先设层，再设预算（预算极限会把层压低，这里保留 worker 的合法压制）
    for (const [consumerId, { decision, stream, found }] of requested) {
      try {
        await found.consumer.setPreferredLayers({ spatialLayer: stream.requestedSpatialLayer });
        found.peer.manualLayers.set(consumerId, { spatialLayer: stream.requestedSpatialLayer });
        found.consumer.requestKeyFrame().catch(() => {});
        applied.push({
          peerId: decision.peerId,
          consumerId,
          label: stream.label,
          transportId: decision.transportId,
          action: 'setPreferredLayers',
          spatialLayer: stream.requestedSpatialLayer,
        });
      } catch (err) {
        errors.push({ consumerId, peerId: decision.peerId, stage: 'setPreferredLayers', message: err.message });
      }
    }

    // 未调度的视频仍在同一条接收 Transport 上，且预算核算已按它“当前层”成本计入。
    // 若不钉住，它会继续自动选层并向上扩张，挤掉被调度视频的预算。
    // 钉在采集时的当前层；采集不到当前层则如实记失败，不能假装成功。
    for (const d of plan.receivers) {
      for (const s of d.streams) {
        if (s.scheduled) continue;
        const found = this.findConsumer(s.consumerId);
        if (!found) continue;
        if (s.currentLayer == null) {
          errors.push({
            consumerId: s.consumerId,
            peerId: d.peerId,
            stage: 'pin-unscheduled',
            message: '未调度视频没有当前层，无法钉住，可能挤占预算',
          });
          continue;
        }
        try {
          await found.consumer.setPreferredLayers({ spatialLayer: s.currentLayer });
          found.peer.manualLayers.set(s.consumerId, { spatialLayer: s.currentLayer, pinned: true });
          applied.push({
            peerId: d.peerId,
            consumerId: s.consumerId,
            label: s.label,
            transportId: d.transportId,
            action: 'pin-unscheduled',
            spatialLayer: s.currentLayer,
          });
        } catch (err) {
          errors.push({ consumerId: s.consumerId, peerId: d.peerId, stage: 'pin-unscheduled', message: err.message });
        }
      }
    }

    // setMaxOutgoingBitrate 是“整条接收 Transport”的共享上限，计划里的 capBps
    // 已经按该接收者全部视频 + 音频预留合计算好，所以每个 Transport 直接用它。
    const transportCapsApplied = new Set();
    for (const d of plan.receivers) {
      if (!d.transportId || d.capBps == null) continue;
      if (transportCapsApplied.has(d.transportId)) continue;
      const peer = this.peers.get(d.peerId);
      const transport = peer?.transports.get(d.transportId);
      if (!transport) {
        errors.push({ peerId: d.peerId, transportId: d.transportId, stage: 'setMaxOutgoingBitrate', message: '接收 Transport 不存在' });
        continue;
      }
      try {
        await transport.setMaxOutgoingBitrate(d.capBps);
        peer.bitrateCaps.set(d.transportId, d.capBps);
        transportCapsApplied.add(d.transportId);
        applied.push({
          peerId: d.peerId,
          transportId: d.transportId,
          action: 'setMaxOutgoingBitrate',
          bitrate: d.capBps,
        });
      } catch (err) {
        errors.push({ peerId: d.peerId, transportId: d.transportId, stage: 'setMaxOutgoingBitrate', message: err.message });
      }
    }

    this.scheduling = {
      scheme,
      appliedAt: Date.now(),
      audioReserveBps,
      transportOverhead,
      groupPeerIds: peers.map((p) => p.id),
      receiverBudgets,
      plan,
      applied,
      errors,
    };

    // 通知控制页/学生页：策略已下发（失败也广播，便于界面提示异常）
    const event = {
      type: 'scheduling-applied',
      scheme,
      appliedAt: this.scheduling.appliedAt,
      appliedCount: applied.length,
      errorCount: errors.length,
      commonSpatialLayer: plan.commonSpatialLayer ?? null,
      receivers: plan.receivers.map((r) => ({
        peerId: r.peerId,
        transportId: r.transportId,
        requestedSpatialLayer: r.requestedSpatialLayer,
        capBps: r.capBps,
        costSource: r.costSource,
        score: r.score,
        streams: r.streams.map((s) => ({
          consumerId: s.consumerId,
          label: s.label,
          scheduled: s.scheduled,
          requestedSpatialLayer: s.requestedSpatialLayer ?? null,
        })),
      })),
      warnings: plan.warnings,
    };
    for (const peer of this.peers.values()) peer.send(event);
    return this.scheduling;
  }

  // 控制页可对单个接收者恢复自动选层（逐接收者独立评分之外的兜底）
  async clearSchedulingForPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`目标节点 ${peerId} 不在线`);
    const results = [];
    for (const consumer of peer.consumers.values()) {
      if (consumer.kind !== 'video') continue;
      try {
        await consumer.setPreferredLayers({ spatialLayer: 2 });
        peer.manualLayers.set(consumer.id, null);
        results.push({ consumerId: consumer.id, action: 'auto-max-spatial' });
      } catch (err) {
        results.push({ consumerId: consumer.id, error: err.message });
      }
    }
    return results;
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
    this.consumerTransports = new Map(); // consumerId -> recvTransportId
    this.clientStats = new Map(); // consumerId -> 浏览器实测（可解码帧等），学生页上报
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
    this.consumerTransports.set(consumer.id, transport.id);
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
      this.consumerTransports.delete(consumer.id);
      this.clientStats.delete(consumer.id);
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
      // mediasoup 3.32 WebRtcTransportStat.type 实测为 'webrtc-transport'，不是 'transport'
      const tuple = stats.find((s) => s.type === 'webrtc-transport') || {};
      transports.push({
        id: t.id,
        direction: t.appData?.direction,
        iceState: t.iceState,
        dtlsState: t.dtlsState,
        bytesReceived: tuple.bytesReceived || 0,
        bytesSent: tuple.bytesSent || 0,
        recvBitrate: tuple.recvBitrate || 0, // bps，mediasoup 实测
        sendBitrate: tuple.sendBitrate || 0,
        rtpSendBitrate: tuple.rtpSendBitrate || 0,
        availableOutgoingBitrate: tuple.availableOutgoingBitrate ?? null,
        maxOutgoingBitrate: tuple.maxOutgoingBitrate ?? this.bitrateCaps.get(t.id) ?? null,
      });
    }
    const producers = [];
    for (const p of this.producers.values()) {
      const stats = await p.getStats();
      // RtpStreamRecvStats 用 byteCount，没有 bytesReceived
      const rtp = stats.find((s) => s.type === 'inbound-rtp') || {};
      producers.push({
        id: p.id,
        kind: p.kind,
        label: p.appData?.label || '',
        mimeType: rtp.mimeType || p.rtpParameters?.codecs?.[0]?.mimeType,
        bytesReceived: rtp.byteCount || 0,
        packetCount: rtp.packetCount || 0,
        bitrate: rtp.bitrate || 0,
        jitter: rtp.jitter || 0,
        bitrateByLayer: rtp.bitrateByLayer || {},
        score: p.score,
        paused: p.paused,
      });
    }
    const consumers = [];
    for (const c of this.consumers.values()) {
      const stats = await c.getStats();
      // RtpStreamSendStats 同样用 byteCount
      const rtp = stats.find((s) => s.type === 'outbound-rtp') || {};
      consumers.push({
        id: c.id,
        producerId: c.producerId,
        kind: c.kind,
        label: c.appData?.label || '',
        mimeType: rtp.mimeType || c.rtpParameters?.codecs?.[0]?.mimeType,
        bytesSent: rtp.byteCount || 0,
        packetCount: rtp.packetCount || 0,
        bitrate: rtp.bitrate || 0,
        currentLayers: this.consumerLayers.get(c.id) ?? null,
        manualLayers: this.manualLayers.get(c.id) ?? null,
        clientStats: this.clientStats.get(c.id) ?? null,
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
        clientStats: this.clientStats.get(c.id) ?? null,
      })),
    };
  }

  /**
   * 学生页回报浏览器端实测（RTCRtpReceiver.getStats）：
   * 可解码帧数、丢帧、收包、实时码率。控制页据此对照“SFU 实际转发层”与
   * “浏览器实际解码”，而不是只信服务端出向数值。
   */
  reportClientStats(payload = {}) {
    const updated = [];
    for (const item of payload.consumers || []) {
      if (!item || !this.consumers.has(item.consumerId)) continue;
      const prev = this.clientStats.get(item.consumerId);
      const record = {
        consumerId: item.consumerId,
        kind: item.kind || this.consumers.get(item.consumerId).kind,
        framesDecoded: Number.isFinite(item.framesDecoded) ? item.framesDecoded : null,
        framesDropped: Number.isFinite(item.framesDropped) ? item.framesDropped : null,
        packetsReceived: Number.isFinite(item.packetsReceived) ? item.packetsReceived : null,
        packetsLost: Number.isFinite(item.packetsLost) ? item.packetsLost : null,
        bitrateBps: Number.isFinite(item.bitrateBps) ? item.bitrateBps : null,
        jitter: Number.isFinite(item.jitter) ? item.jitter : null,
        at: Date.now(),
      };
      // 首帧只记第一次，之后保持；避免轮询覆盖掉真实首帧时间
      record.firstFrameAt = prev?.firstFrameAt ?? (item.firstFrameAt ?? null);
      this.clientStats.set(item.consumerId, record);
      updated.push(item.consumerId);
    }
    return updated;
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
    this.consumerTransports.clear();
    this.clientStats.clear();
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
