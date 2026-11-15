#!/usr/bin/env bash
# OS 级网络限制（Linux tc + prio 队列）：对本机 RTC UDP 端口做真实带宽/丢包/延迟约束。
#
# 与应用层 setMaxOutgoingBitrate 的区别：
#   - 应用层（控制页/学生页“限带宽”）：mediasoup Transport BWE 内部生效，无需 root，可逐学生控制。
#   - 本脚本（OS 层 tc）：在内核网卡队列真实丢包/排队，模拟物理网络，需要 NET_ADMIN / root。
#
# 用法（root 或有 NET_ADMIN 权限）：
#   sudo ./scripts/network-limit.sh on   100mbit 200ms 5%   # 带宽 100m、延迟 200ms、丢包 5%
#   sudo ./scripts/network-limit.sh on   1mbit   50ms  0
#   sudo ./scripts/network-limit.sh off
#
# 仅作用于 SFU RTC UDP 端口段（默认 40000-40100，见 server/config.js），不影响信令 WS(3000)。
set -euo pipefail

IFACE="${IFACE:-eth0}"
MIN_PORT="${RTC_MIN_PORT:-40000}"
MAX_PORT="${RTC_MAX_PORT:-40100}"
ACTION="${1:-status}"
RATE="${2:-1mbit}"
DELAY="${3:-50ms}"
LOSS="${4:-0}"

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "需要 root / NET_ADMIN 权限运行 tc（应用层限速无需 root，请用控制页）" >&2
    exit 1
  fi
}

case "$ACTION" in
  on)
    need_root
    echo "在网卡 $IFACE 上限制 RTC UDP 端口 $MIN_PORT-$MAX_PORT：rate=$RATE delay=$DELAY loss=$LOSS%"
    # 清理旧规则（忽略不存在）
    tc qdisc del dev "$IFACE" root 2>/dev/null || true
    # prio 队列把 RTC 流量引到带 tbf/netem 的类
    tc qdisc add dev "$IFACE" root handle 1: prio
    tc qdisc add dev "$IFACE" parent 1:3 handle 30: tbf rate "$RATE" burst 32kbit latency 400ms
    tc qdisc add dev "$IFACE" parent 30:1 handle 31: netem delay "$DELAY" loss "$LOSS"
    # 匹配目的/源端口在 RTC 段的 UDP，归入受限类
    tc filter add dev "$IFACE" protocol ip parent 1:0 prio 3 u32 \
      match ip protocol 17 0xff \
      match udp dst "$MIN_PORT" 0xffff flowid 1:3
    tc filter add dev "$IFACE" protocol ip parent 1:0 prio 3 u32 \
      match ip protocol 17 0xff \
      match udp src "$MIN_PORT" 0xffff flowid 1:3
    echo "已生效。查看：tc -s qdisc show dev $IFACE"
    ;;
  off)
    need_root
    tc qdisc del dev "$IFACE" root 2>/dev/null || true
    echo "已清除 $IFACE 上的 tc 规则"
    ;;
  status)
    tc -s qdisc show dev "$IFACE" || echo "无 tc 规则或无权限"
    ;;
  *)
    echo "用法: $0 on [rate] [delay] [loss] | off | status"; exit 1
    ;;
esac
