import mediasoup from 'mediasoup';
import { CONFIG } from './config.js';

// 全局 mediasoup Worker 池。每个 Worker 是一个独立的 mediasoup-worker 子进程，
// 在子进程内做 RTP 路由/转发，Node 主进程只负责信令与编排，不接触解码/编码。
const workers = [];
let nextWorker = 0;

export async function startWorkers() {
  for (let i = 0; i < CONFIG.mediasoup.numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: CONFIG.mediasoup.worker.logLevel,
      logTags: CONFIG.mediasoup.worker.logTags,
      rtcMinPort: CONFIG.mediasoup.worker.rtcMinPort,
      rtcMaxPort: CONFIG.mediasoup.worker.rtcMaxPort,
    });
    worker.on('died', () => {
      console.error(`[worker] mediasoup worker 异常退出 pid=${worker.pid}`);
    });
    workers.push(worker);
    console.log(`[worker] 已启动 pid=${worker.pid}`);
  }
}

// 简单轮询：新房间分配到下一个 Worker
export function pickWorker() {
  const w = workers[nextWorker % workers.length];
  nextWorker++;
  return w;
}

export function workerCount() {
  return workers.length;
}
