// 测试媒体：动态画布 + 可识别内容，用于无真实摄像头环境下的可复现实验。
// 真实授课时教师页同样支持 getUserMedia 摄像头与 getDisplayMedia 实验台画面。

export function makeLabeledCanvas(label, { width = 1280, height = 720, color = '#0b3d91' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  let t = 0;
  const timer = setInterval(() => {
    t += 1;
    // 背景渐变更替，保证帧间有真实变化，编码器会产生不同码率
    const g = ctx.createLinearGradient(0, 0, width, height);
    const hue = (t * 4) % 360;
    g.addColorStop(0, `hsl(${hue},70%,45%)`);
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    // 运动方块：高空间层可保留细节，低空间层会模糊，便于肉眼/码率区分层级
    const x = (t * 6) % width;
    ctx.fillStyle = '#ffd166';
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc((x + i * 90) % width, 120 + (i % 3) * 160, 28, 0, Math.PI * 2);
      ctx.fill();
    }
    // 细密网格与文字，高码率下清晰，低码率下出现块效应
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < width; gx += 40) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }
    for (let gy = 0; gy < height; gy += 40) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 56px sans-serif';
    ctx.fillText(label, 40, height - 60);
    ctx.font = '32px monospace';
    ctx.fillText(`frame=${t} ${new Date().toISOString().slice(11, 19)}`, 40, 70);
  }, 1000 / 15);
  return { canvas, stop: () => clearInterval(timer) };
}

// 音频测试源：正弦音 + 节拍，便于核验音频连续性（断流会出现静音/中断）
export function makeToneStream({ freq = 440 } = {}) {
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const osc = ac.createOscillator();
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  const gain = ac.createGain();
  osc.frequency.value = freq;
  osc.type = 'sine';
  lfo.frequency.value = 2; // 2Hz 节拍，听感上可辨别中断
  lfoGain.gain.value = 0.08;
  gain.gain.value = 0.12;
  lfo.connect(lfoGain).connect(gain.gain);
  osc.connect(gain).connect(dest);
  osc.start();
  lfo.start();
  return {
    stream: dest.stream,
    stop: () => {
      try { osc.stop(); lfo.stop(); ac.close(); } catch { /* ignore */ }
    },
  };
}

// 视频 Simulcast 三层编码参数（VP8）。
// 三个独立空间层，maxBitrate 逐层递增；mediasoup 按 BWE 在三层间真实切换。
export function videoSimulcastEncodings() {
  return [
    { rid: 'r0', maxBitrate: 150_000, scaleResolutionDownBy: 4, maxFramerate: 15 }, // 低：~320x180
    { rid: 'r1', maxBitrate: 500_000, scaleResolutionDownBy: 2, maxFramerate: 25 }, // 中：~640x360
    { rid: 'r2', maxBitrate: 1_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 }, // 高：1280x720
  ];
}

// VP9 SVC 单层多空间层（浏览器支持时），L3T3：3 空间层 x 3 时间层
export function videoSvcEncodings() {
  return [{ rid: 'r0', maxBitrate: 1_500_000, scalabilityMode: 'L3T3_KEY', maxFramerate: 30 }];
}
