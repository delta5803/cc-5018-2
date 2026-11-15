import os from 'node:os';

export const CONFIG = {
  http: {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 3000),
  },
  mediasoup: {
    numWorkers: Number(process.env.WORKERS || 1),
    worker: {
      logLevel: process.env.MS_LOG || 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'simulcast', 'bwe'],
      rtcMinPort: Number(process.env.RTC_MIN_PORT || 40000),
      rtcMaxPort: Number(process.env.RTC_MAX_PORT || 40100),
    },
    // 本地部署默认回环地址；跨主机访问时用 ANNOUNCED_IP=<本机可达IP> 覆盖
    listenIp: process.env.LISTEN_IP || '0.0.0.0',
    announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1',
    webRtcTransport: {
      listenIps: [{ ip: process.env.LISTEN_IP || '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_500_000,
      minimumAvailableOutgoingBitrate: 80_000,
      maxSctpMessageSize: 262144,
    },
    // 媒体编解码与分层能力声明：
    //  - VP8：客户端发 3 路空间 Simulcast（低/中/高），每路内含时间层
    //  - VP9：单层 SVC 编码 L3T3（浏览器支持时可用，切换 spatialLayer 即切 SVC 层）
    //  - 服务端只做 RTP 转发与层选择，不做任何解码/重编码
    routerMediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: { 'x-google-start-bitrate': 1000 },
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: { 'profile-id': 0, 'x-google-decoder-bitrate-alignment': 0 },
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
        },
      },
    ],
  },
  statsIntervalMs: 1000,
};

export function getLocalIps() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  return out;
}
