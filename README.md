# 远程实验授课直播间（真实 WebRTC SFU，服务端不转码）

教师用浏览器发布**摄像头**与**实验台**两路画面加一路麦克风，服务端用真实
WebRTC SFU（[mediasoup](https://mediasoup.org/) v3，C++ worker 做 RTP 路由）
把媒体转发给多名学生。服务端**只做 RTP 转发与层选择，不解码、不重编码**，
因此不会随学生数量重复转码。

---

## 1. 架构与关键设计

```
教师浏览器 (Producer)                      学生浏览器 (Consumer) x N
 camera  (VP8 Simulcast S0/S1/S2)  ┐
 bench   (VP8 Simulcast S0/S1/S2)  ├──► mediasoup Router ──► 每个学生独立 Transport/Consumer
 mic     (Opus)                    ┘      （只转发+选层）       按各自 BWE 下发不同层
        ▲                                                  ▲
        └────────── WebSocket 信令（独立于媒体）────────────┘
```

### 媒体库与可运行性
- **SFU：mediasoup 3.32**（含本地编译的原生 `mediasoup-worker`，已在本环境 arm64/Debian12 编译运行）。
- 浏览器端：`mediasoup-client`（已用 esbuild 打包到 `public/vendor/`，无需 CDN）。
- 信令：`ws`（Node `WebSocket`），HTTP 静态服务由 Node 内置 `http` 提供。

### 支持的分层方式（真实降码率，不是改 video 元素尺寸）
| 方式 | 编解码 | 空间层 | 码率（本系统配置） | 选层主体 |
|---|---|---|---|---|
| Simulcast（默认） | VP8 | S0/S1/S2 三路独立编码 | 150k / 500k / 1500k | mediasoup Transport BWE 自动，或手动固定 |
| SVC（浏览器支持时） | VP9 | L3T3，单层多空间/时间层 | 上限 1500k | 同上，切 `spatialLayer` 即切 SVC 层 |
| 单层兜底 | H264/VP8 | S0 | 跟随发送端 | 无层可切 |

- 教师端一次编码出三层（见 `public/js/test-media.js` 的 `videoSimulcastEncodings`）。
- mediasoup worker 根据每个学生接收 Transport 的**可用带宽估计（transport-cc BWE）**
  决定实际转发哪一层；worker 源码里 `preferredLayers` 是“不得超过的空间层上限”。
- 实测：强制 S0 时该路码率 **1576kbps → 148kbps**；限速 100kbps 时视频被 BWE
  暂停、**音频仍连续**。页面只负责显示，缩放视频窗口不会改变任何码率。

### 信令状态与媒体状态严格分离
- **信令在线**（WebSocket `join` 成功）只代表能收发控制消息，**不代表有画面**。
- **媒体就绪**必须真正收到并解码出第一帧（视频 `videoWidth>0` / 音频首个 RTP 包），
  学生页媒体状态才变为“已收到可解码画面”，并实测记录“首次出画时间”。
- 教师退出时学生信令仍在线，媒体状态变为“生产者退出，无画面”；教师重新发布后自动恢复。

### 故障处理与资源清理
- **ICE failed**：学生页与控制页均可 `restart-ice`，服务端调用 `transport.restartIce()`
  并回传新 `iceParameters`，客户端 `updateIceParameters` 后重新连通。
- **生产者退出**：Consumer 触发 `producerclose`，服务端关闭订阅并通知；空房间 15s 后回收 Router。
- **学生离开 / 同 ID 重新加入**：`Peer.close()` 关闭全部 Consumer/Producer/Transport，
  同 ID 重入先 `replacePeer` 回收旧会话再建新会话。测试验证离开后 SFU 出向码率归零、无残留 Consumer。

---

## 2. 本地部署

### 前置
- Node.js ≥ 18（本环境 Node 22）、Python3 + pip（编译 mediasoup worker 用）、C/C++ 工具链。

```bash
npm install          # 会自动编译 mediasoup 原生 worker（需要 gcc/g++/make/python3）
npm run build:vendor # 打包 mediasoup-client 到 public/vendor（仓库已带产物，可跳过）
npm start
```

启动后访问：
- 入口导航：`http://localhost:3000/`
- 教师端：`http://localhost:3000/teacher.html`
- 学生端：`http://localhost:3000/student.html`（多开几个浏览器标签/窗口即多学生）
- 流媒体控制页：`http://localhost:3000/control.html`

跨主机访问时声明本机可达 IP（否则默认 announce 127.0.0.1）：
```bash
ANNOUNCED_IP=192.168.1.10 RTC_MIN_PORT=40000 RTC_MAX_PORT=40100 npm start
```

### 界面怎样启动（手动操作顺序）
1. 打开**教师端** → 媒体来源选“测试媒体（动态画布+正弦音，免摄像头）”或“真实设备”
   → 点「加入房间（仅信令）」→ 状态显示“信令在线，尚无媒体” → 点「发布摄像头+实验台+麦克风」
   → 媒体状态变“发布中”，卡片显示三路真实发送码率。
2. 打开一个或多个**学生端**（可改学生 ID）→ 点「加入房间」→ 自动订阅三路并显示
   “首次出画 xx ms”、SFU 实际下发层、浏览器/服务端两套真实统计。
3. 打开**流媒体控制页** → 点「连接转发内核」→ 选目标学生和 Consumer，
   切层 / 限带宽 / 重启 ICE；「操作结果区」回显每次内核调用的成败，下方表格显示真实转发层与码率。

---

## 3. 测试媒体（无需真实摄像头/麦克风）

- 视频：`public/js/test-media.js` 用两个 `canvas.captureStream()` 生成 15fps 动态画面
  （渐变背景、运动圆、细密网格、帧号/时间戳），高码率清晰、低码率出现块效应，便于肉眼区分层级。
- 音频：`AudioContext` 生成 440Hz 正弦音 + 2Hz 节拍，断流能被听感和 `audioLevel` 统计捕捉。
- 真实授课：教师端媒体来源切到“真实设备”走 `getUserMedia`，也可用「追加屏幕/窗口共享」走 `getDisplayMedia`。

---

## 4. 可复现的网络限制（两套）

### 4.1 应用层（无需 root，逐学生，推荐用于课堂演示）
- 学生页：填 kbps →「应用带宽上限」，调用 `transport.setMaxOutgoingBitrate()`。
- 控制页：选预设（100k/300k/700k/2M/解除）→「应用到接收 Transport」。
- 这是在 mediasoup BWE 内部的真实码率约束，带宽不足自动降 Simulcast 空间层。

### 4.2 OS 层（Linux tc，模拟物理网络，需 root/NET_ADMIN）
```bash
# 对 RTC UDP 端口段 40000-40100 限速 1mbit、加 50ms 延迟、0 丢包
sudo IFACE=eth0 ./scripts/network-limit.sh on 1mbit 50ms 0
# 极端：100mbit 带宽、200ms 延迟、5% 丢包
sudo ./scripts/network-limit.sh on 100mbit 200ms 5
sudo ./scripts/network-limit.sh status
sudo ./scripts/network-limit.sh off
```
脚本只作用于 RTC UDP 端口段，不影响 3000 端口的信令。

### 4.3 无头浏览器假媒体（自动化测试用）
Playwright/Chromium 启动参数（已内置在 `tests/helpers.cjs`）：
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`。

---

## 5. 实测：多浏览器 + 不同限速

### 一键自动化（真实 Chromium 多实例 + WebRTC）
```bash
# 先确保服务已启动（npm start），再：
export LD_LIBRARY_PATH=<本机 chromium 依赖库路径>  # 仅在无 root 装库时需要，见下文“无 root 环境”
npm test            # = test:auto（6 场景 17 断言）+ test:control（控制页 7 断言）
```

`tests/run-tests.cjs` 覆盖六场景，输出到 `tests/reports/e2e-*.json`：
1. 1 教师 + 2 学生独立转发、首次出画时间；
2. 内核强制切层（S2→S0 码率 1576→148kbps），且学生间互不影响；
3. 限速 300k 自动降层、100k 视频暂停但音频连续、解除后恢复 S2；
4. 教师退出（信令在线/媒体中断）与重新发布后自动恢复；
5. 学生离开/同 ID 重入的资源回收与带宽释放；
6. ICE 重启与全程音频连续性。

### 最近一次实测结果（本环境，无头 Chromium）
```
场景1 两学生均 S2 出画；首帧 23~67ms，音频首包 ~210ms
场景2 强制 S0：1576kbps → 148kbps；学生 B 仍 S2
场景3 限速 300k：自动 S0，总出向 231kbps
      限速 100k：视频 0kbps（BWE 压制），音频稳定 44.8kbps
      解除限速：12s 内 BWE 探测回升到 S2 ~1.6Mbps
场景4/5/6 全部 PASS；汇总 17/17，控制页 7/7
```
页面统计全部来自真实数据源：浏览器 `RTCRtpReceiver.getStats()` 与服务端
`transport/consumer/producer.getStats()`，每秒刷新，无固定演示数值。

### 无 root 环境运行 Chromium（本环境的做法）
系统缺少 `libnss3/libnspr4/...` 且不能 apt 安装时，下载 bookworm arm64 的 `.deb`
解压到用户目录，用 `LD_LIBRARY_PATH` 注入（不写系统目录）：
```bash
# 库已解压在 ~/.local/chromium-libs 时：
export LD_LIBRARY_PATH=$HOME/.local/chromium-libs/usr/lib/aarch64-linux-gnu:$HOME/.local/chromium-libs/lib/aarch64-linux-gnu
npx playwright install chromium
```

---

## 6. 目录结构
```
server/
  config.js             媒体编解码/分层声明、端口、Transport 参数
  mediasoup-workers.js  Worker 池（RTP 路由子进程）
  room.js               Room/Peer 生命周期：Transport/Producer/Consumer、
                        选层、带宽上限、ICE 重启、退出清理、真实统计
  index.js              HTTP + WebSocket 信令，请求/事件编排
public/
  teacher/student/control.html + js/   三个页面
  js/test-media.js      动态画布/正弦音测试媒体、Simulcast/SVC 编码参数
  vendor/               打包后的 mediasoup-client
scripts/network-limit.sh  OS 级 tc 限速
tests/                  Playwright 多实例端到端、内核探针、控制页测试与 JSON 报告
```

## 7. 信令方法一览（WebSocket JSON，请求带数字 id，响应回同 id）
`join` `set-rtp-capabilities` `create-transport` `connect-transport` `produce`
`consume` `resume-consumer` `set-consumer-layers` `set-max-bitrate` `restart-ice`
`get-stats`，控制页另有 `room-snapshot` `control-set-layers` `control-set-bitrate`
`control-restart-ice`。事件：`new-producer` `producer-closed` `consumer-layers`
`consumer-closed` `ice-state` `dtls-state` `producer/consumer-score` `peer-joined/left` `session-ended`。
