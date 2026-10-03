#!/bin/sh

set -u

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR" || exit 1

RUNTIME_DIR="$PROJECT_DIR/.ffp-game"
PID_FILE="$RUNTIME_DIR/pid"
MODE_FILE="$RUNTIME_DIR/mode"
DEV_LOG="$RUNTIME_DIR/dev.log"
PROD_LOG="$RUNTIME_DIR/prod.log"

info() {
  printf '%s\n' "$1"
}

warn() {
  printf '警告：%s\n' "$1"
}

error() {
  printf '错误：%s\n' "$1" >&2
}

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

check_environment() {
  if ! command -v node >/dev/null 2>&1; then
    error "未找到 Node.js，请先安装 Node.js 22 或更高版本。"
    return 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    error "未找到 npm，请先安装 Node.js 22 或更高版本。"
    return 1
  fi

  node_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')
  if [ "$node_major" -lt 22 ]; then
    error "当前 Node.js 版本过低，需要 22 或更高版本。"
    return 1
  fi

  return 0
}

read_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  case "$pid" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac
  printf '%s' "$pid"
}

read_mode() {
  [ -f "$MODE_FILE" ] || return 1
  mode=$(cat "$MODE_FILE" 2>/dev/null || true)
  case "$mode" in
    dev|prod)
      printf '%s' "$mode"
      ;;
    *)
      return 1
      ;;
  esac
}

is_running() {
  pid=$(read_pid 2>/dev/null || true)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1

  process_state=$(ps -p "$pid" -o stat= 2>/dev/null | tr -d '[:space:]')
  case "$process_state" in
    Z*)
      return 1
      ;;
  esac

  return 0
}

cleanup_stale_runtime() {
  if ! is_running; then
    rm -f "$PID_FILE"
  fi
}

mode_label() {
  case "$1" in
    dev) printf '%s' '开发模式' ;;
    prod) printf '%s' '生产模式' ;;
    *) printf '%s' '未知模式' ;;
  esac
}

log_file_for_mode() {
  case "$1" in
    dev) printf '%s' "$DEV_LOG" ;;
    prod) printf '%s' "$PROD_LOG" ;;
    *) return 1 ;;
  esac
}

kill_tree() {
  target_pid=$1
  signal_name=$2
  child_pids=$(pgrep -P "$target_pid" 2>/dev/null || true)

  for child_pid in $child_pids; do
    kill_tree "$child_pid" "$signal_name"
  done

  kill -s "$signal_name" "$target_pid" 2>/dev/null || true
}

wait_for_health() {
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if curl -fsS --max-time 1 "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null 2>&1; then
      return 0
    fi

    if ! is_running; then
      return 1
    fi

    attempts=$((attempts + 1))
    sleep 0.5
  done

  return 1
}

show_start_failure() {
  mode=$1
  log_file=$(log_file_for_mode "$mode" 2>/dev/null || true)
  if [ -n "$log_file" ] && [ -f "$log_file" ]; then
    printf '\n最近日志：\n'
    tail -n 30 "$log_file"
  fi
}

start_service() {
  mode=$1
  check_environment || return 1
  ensure_runtime_dir

  if is_running; then
    running_pid=$(read_pid)
    running_mode=$(read_mode 2>/dev/null || printf 'unknown')
    warn "服务已在运行，PID=${running_pid}，模式=$(mode_label "$running_mode")。"
    return 1
  fi

  cleanup_stale_runtime

  case "$mode" in
    dev)
      log_file=$DEV_LOG
      : > "$log_file"
      info "正在启动开发模式..."
      nohup npm run dev >"$log_file" 2>&1 </dev/null &
      ;;
    prod)
      log_file=$PROD_LOG
      : > "$log_file"
      info "正在启动生产模式..."
      nohup npm start >"$log_file" 2>&1 </dev/null &
      ;;
    *)
      error "不支持的启动模式：$mode"
      return 1
      ;;
  esac

  service_pid=$!
  printf '%s\n' "$service_pid" >"$PID_FILE"
  printf '%s\n' "$mode" >"$MODE_FILE"

  if wait_for_health; then
    info "启动成功，PID=${service_pid}，模式=$(mode_label "$mode")。"
    if [ "$mode" = "dev" ]; then
      info "H5 开发地址：http://localhost:5173"
      info "测试端地址：http://localhost:5173/test"
    else
      info "访问地址：http://localhost:${PORT:-3000}"
    fi
    info "日志文件：$log_file"
    return 0
  fi

  if is_running; then
    warn "进程已启动，但健康检查尚未通过。"
    info "服务可能仍在初始化，请查看日志：$log_file"
    return 0
  fi

  error "启动失败。"
  rm -f "$PID_FILE"
  show_start_failure "$mode"
  return 1
}

start_dev() {
  start_service dev
}

build_project() {
  check_environment || return 1
  ensure_runtime_dir
  info "正在构建项目..."
  if npm run build; then
    info "构建完成。"
    return 0
  fi
  error "构建失败。"
  return 1
}

start_prod() {
  check_environment || return 1

  if is_running; then
    running_pid=$(read_pid)
    running_mode=$(read_mode 2>/dev/null || printf 'unknown')
    warn "服务已在运行，PID=${running_pid}，模式=$(mode_label "$running_mode")。"
    return 1
  fi

  build_project || return 1
  start_service prod
}

stop_service() {
  if ! is_running; then
    cleanup_stale_runtime
    info "服务未运行。"
    return 0
  fi

  service_pid=$(read_pid)
  mode=$(read_mode 2>/dev/null || printf 'unknown')
  info "正在停止服务，PID=${service_pid}，模式=$(mode_label "$mode")..."

  kill -s TERM "$service_pid" 2>/dev/null || true

  attempts=0
  while is_running && [ "$attempts" -lt 20 ]; do
    attempts=$((attempts + 1))
    sleep 0.5
  done

  if is_running; then
    warn "服务未在超时时间内退出，正在强制结束。"
    kill_tree "$service_pid" KILL
  fi

  rm -f "$PID_FILE"
  info "服务已停止。"
}

restart_service() {
  mode=$(read_mode 2>/dev/null || true)

  if [ -z "$mode" ]; then
    warn "没有可恢复的启动模式，将按开发模式启动。"
    mode=dev
  fi

  stop_service || return 1

  if [ "$mode" = "prod" ]; then
    start_prod
  else
    start_dev
  fi
}

show_status() {
  ensure_runtime_dir
  cleanup_stale_runtime

  if is_running; then
    service_pid=$(read_pid)
    mode=$(read_mode 2>/dev/null || printf 'unknown')
    log_file=$(log_file_for_mode "$mode" 2>/dev/null || true)
    info "状态：运行中"
    info "PID：$service_pid"
    info "模式：$(mode_label "$mode")"

    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null 2>&1; then
      info "健康检查：正常（http://127.0.0.1:${PORT:-3000}/api/health）"
    else
      info "健康检查：未通过"
    fi

    if [ "$mode" = "dev" ]; then
      info "H5 地址：http://localhost:5173"
      info "测试端地址：http://localhost:5173/test"
    fi

    [ -n "$log_file" ] && info "日志文件：$log_file"
    return 0
  fi

  info "状态：未运行"
  return 1
}

show_logs() {
  mode=$(read_mode 2>/dev/null || true)
  if [ -z "$mode" ]; then
    warn "当前没有运行中的服务，无法确定日志文件。"
    return 1
  fi

  log_file=$(log_file_for_mode "$mode" 2>/dev/null || true)
  if [ ! -f "$log_file" ]; then
    error "日志文件不存在：$log_file"
    return 1
  fi

  info "正在查看 $(mode_label "$mode") 日志：$log_file"
  info "按 Ctrl+C 返回。"
  tail -n 100 -f "$log_file"
}

show_menu() {
  printf '\n'
  printf '%s\n' '=============================='
  printf '%s\n' '       FFP-Game 服务管理'
  printf '%s\n' '=============================='
  printf '%s\n' '  1. 开发模式启动'
  printf '%s\n' '  2. 生产模式启动（自动构建）'
  printf '%s\n' '  3. 停止服务'
  printf '%s\n' '  4. 重启当前模式'
  printf '%s\n' '  5. 查看状态'
  printf '%s\n' '  6. 查看日志'
  printf '%s\n' '  7. 构建项目'
  printf '%s\n' '  0. 退出'
  printf '%s\n' '=============================='
}

pause_menu() {
  printf '\n按 Enter 返回菜单...'
  IFS= read -r _ || true
}

interactive_menu() {
  while true; do
    show_menu
    printf '请选择：'
    IFS= read -r choice || exit 0

    case "$choice" in
      1)
        start_dev
        pause_menu
        ;;
      2)
        start_prod
        pause_menu
        ;;
      3)
        stop_service
        pause_menu
        ;;
      4)
        restart_service
        pause_menu
        ;;
      5)
        show_status || true
        pause_menu
        ;;
      6)
        show_logs || true
        pause_menu
        ;;
      7)
        build_project
        pause_menu
        ;;
      0)
        info "已退出。"
        exit 0
        ;;
      *)
        warn "无效选项，请输入 0-7。"
        pause_menu
        ;;
    esac
  done
}

show_usage() {
  cat <<'EOF'
用法：
  ./start.sh                打开交互菜单
  ./start.sh start-dev      开发模式启动
  ./start.sh start-prod     构建后以生产模式启动
  ./start.sh stop           停止服务
  ./start.sh restart        重启当前模式
  ./start.sh status         查看状态
  ./start.sh logs           查看日志
  ./start.sh build          构建项目
  ./start.sh help           显示帮助

可选环境变量：
  PORT                      服务端端口，默认 3000
EOF
}

case "${1:-}" in
  '')
    interactive_menu
    ;;
  start-dev|dev)
    start_dev
    ;;
  start-prod|prod)
    start_prod
    ;;
  stop)
    stop_service
    ;;
  restart)
    restart_service
    ;;
  status)
    show_status || exit 1
    ;;
  logs)
    show_logs
    ;;
  build)
    build_project
    ;;
  help|-h|--help)
    show_usage
    ;;
  *)
    error "未知参数：$1"
    show_usage
    exit 2
    ;;
esac
