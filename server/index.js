import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CONFIG, getLocalIps } from './config.js';
import { startWorkers, workerCount } from './mediasoup-workers.js';
import { Room, Peer } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const rooms = new Map(); // roomId -> Room

async function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room || room.router.closed) {
    room = await Room.create(roomId);
    rooms.set(roomId, room);
  }
  return room;
}

function findPeerByWs(ws) {
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) {
      if (peer.ws === ws) return { room, peer };
    }
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  // 只允许 public 目录内文件
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ type: 'error', error: '非法 JSON' }));
    }
    const { id, method } = msg;
    const reply = (ok, data = {}, error) => {
      // 展开在前、id 在后：保证回传的一定是客户端数字请求 id，
      // 不被业务数据（如 producer/consumer 的 UUID id）覆盖
      const payload = { ...(ok ? data : {}), ...(error ? { error: String(error.message || error) } : {}), id, ok };
      ws.send(JSON.stringify(payload));
    };

    try {
      // 任何需要已加入房间的方法，先定位 Peer
      let ctx = null;
      if (method !== 'join') {
        ctx = findPeerByWs(ws);
        if (!ctx) throw new Error('尚未加入房间（信令未就绪）');
      }

      switch (method) {
        case 'join': {
          const { roomId, peerId, role, rtpCapabilities } = msg;
          if (!roomId || !peerId || !['teacher', 'student', 'controller'].includes(role)) {
            throw new Error('join 参数非法：需要 roomId / peerId / role(teacher|student|controller)');
          }
          const room = await getRoom(roomId);
          const old = room.peers.get(peerId);
          if (old) room.replacePeer(old); // 重新加入：回收旧会话资源
          const peer = new Peer(peerId, role, ws, room);
          peer.rtpCapabilities = rtpCapabilities || null;
          room.peers.set(peerId, peer);
          console.log(`[join] room=${roomId} peer=${peerId} role=${role}`);
          // 信令就绪 != 媒体就绪。现有 producers 仅表示“可订阅”，不代表已出画
          reply(true, {
            roomId,
            peerId,
            role,
            rtpCapabilities: room.router.rtpCapabilities,
            peers: room.snapshot().peers.filter((p) => p.id !== peerId),
            producers: room.producers.map((p) => ({
              id: p.id,
              peerId: p.appData?.peerId,
              kind: p.kind,
              mimeType: p.rtpParameters?.codecs?.[0]?.mimeType,
              appData: p.appData,
            })),
          });
          // 通知其他人有新节点上线（仅信令状态）
          for (const other of room.peers.values()) {
            if (other.id !== peerId) {
              other.send({ type: 'peer-joined', peer: { id: peerId, role } });
            }
          }
          break;
        }

        case 'set-rtp-capabilities': {
          ctx.peer.rtpCapabilities = msg.rtpCapabilities;
          reply(true);
          break;
        }

        case 'create-transport': {
          const t = await ctx.peer.createWebRtcTransport({ direction: msg.direction });
          reply(true, { transport: t });
          break;
        }

        case 'connect-transport': {
          await ctx.peer.connectTransport({ transportId: msg.transportId, dtlsParameters: msg.dtlsParameters });
          reply(true);
          break;
        }

        case 'produce': {
          const r = await ctx.peer.produce({
            transportId: msg.transportId,
            kind: msg.kind,
            rtpParameters: msg.rtpParameters,
            appData: msg.appData,
          });
          reply(true, r);
          break;
        }

        case 'consume': {
          const r = await ctx.peer.consume({ transportId: msg.transportId, producerId: msg.producerId });
          reply(true, { consumer: r });
          break;
        }

        case 'resume-consumer': {
          await ctx.peer.resumeConsumer({ consumerId: msg.consumerId });
          reply(true);
          break;
        }

        case 'set-consumer-layers': {
          const pref = await ctx.peer.setConsumerLayers({
            consumerId: msg.consumerId,
            spatialLayer: msg.spatialLayer,
            temporalLayer: msg.temporalLayer,
            mode: msg.mode,
          });
          reply(true, { manualLayers: pref });
          break;
        }

        case 'set-max-bitrate': {
          const r = await ctx.peer.setMaxOutgoingBitrate({
            transportId: msg.transportId,
            bitrate: Number(msg.bitrate),
          });
          reply(true, r);
          break;
        }

        case 'restart-ice': {
          const r = await ctx.peer.restartIce({ transportId: msg.transportId });
          reply(true, r);
          break;
        }

        case 'get-stats': {
          const stats = await ctx.peer.getStats();
          reply(true, { stats });
          break;
        }

        // 控制页：拉取整个房间的真实状态，或对任意目标节点执行操作
        case 'room-snapshot': {
          if (ctx.peer.role !== 'controller') throw new Error('仅控制页可调用 room-snapshot');
          const room = ctx.room;
          const peerStats = await Promise.all([...room.peers.values()].map((p) => p.getStats()));
          reply(true, { snapshot: room.snapshot(), stats: peerStats });
          break;
        }

        case 'control-set-layers': {
          if (ctx.peer.role !== 'controller') throw new Error('仅控制页可控制分层');
          const target = ctx.room.peers.get(msg.targetPeerId);
          if (!target) throw new Error(`目标节点 ${msg.targetPeerId} 不在线`);
          const pref = await target.setConsumerLayers({
            consumerId: msg.consumerId,
            spatialLayer: msg.spatialLayer,
            temporalLayer: msg.temporalLayer,
            mode: msg.mode,
          });
          reply(true, { targetPeerId: target.id, manualLayers: pref });
          break;
        }

        case 'control-set-bitrate': {
          if (ctx.peer.role !== 'controller') throw new Error('仅控制页可限制带宽');
          const target = ctx.room.peers.get(msg.targetPeerId);
          if (!target) throw new Error(`目标节点 ${msg.targetPeerId} 不在线`);
          const r = await target.setMaxOutgoingBitrate({
            transportId: msg.transportId,
            bitrate: Number(msg.bitrate),
          });
          reply(true, { targetPeerId: target.id, ...r });
          break;
        }

        case 'control-restart-ice': {
          if (ctx.peer.role !== 'controller') throw new Error('仅控制页可重启 ICE');
          const target = ctx.room.peers.get(msg.targetPeerId);
          if (!target) throw new Error(`目标节点 ${msg.targetPeerId} 不在线`);
          const r = await target.restartIce({ transportId: msg.transportId });
          reply(true, { targetPeerId: target.id, ...r });
          break;
        }

        default:
          throw new Error(`未知方法 ${method}`);
      }
    } catch (err) {
      console.warn(`[signaling] ${method || '?'} 失败:`, err.message);
      reply(false, {}, err);
    }
  });

  ws.on('close', () => {
    const ctx = findPeerByWs(ws);
    if (ctx) ctx.peer.close('ws-disconnected');
  });
  ws.on('error', (err) => console.warn('[ws] error', err.message));
});

// 心跳：检测僵死连接并触发清理
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 10_000);
wss.on('close', () => clearInterval(heartbeat));

// 定时清理空房间（全部节点离开后回收 Router，停止占用转发资源）
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.peers.size === 0) {
      console.log(`[room ${id}] 房间已空，回收 Router`);
      room.close();
      rooms.delete(id);
    }
  }
}, 15_000);

async function main() {
  await startWorkers();
  server.listen(CONFIG.http.port, CONFIG.http.host, () => {
    const ips = getLocalIps();
    console.log('=========================================================');
    console.log(` 远程实验授课 SFU 已启动（mediasoup worker=${workerCount()}）`);
    console.log(` 本机访问:   http://localhost:${CONFIG.http.port}/`);
    for (const { name, ip } of ips) console.log(` 局域网访问: http://${ip}:${CONFIG.http.port}/  (${name})`);
    console.log(' 教师页 /teacher.html  学生页 /student.html  控制页 /control.html');
    console.log('=========================================================');
  });
}

main().catch((err) => {
  console.error('启动失败', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  for (const room of rooms.values()) room.close();
  process.exit(0);
});
