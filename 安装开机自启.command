#!/bin/zsh
set -e

project_dir="/Users/kapozux/Documents/Playground/pdf2md-web"
agent_dir="/Users/kapozux/Library/LaunchAgents"
current_uid="$(id -u)"
service_domain="gui/${current_uid}"
services=(com.kapozux.moye-ocr com.kapozux.moye-web)

cd -- "$project_dir"
mkdir -p "$project_dir/logs" "$agent_dir"

echo "正在构建墨页网页…"
/opt/homebrew/bin/npm run build

for service_name in "${services[@]}"; do
  source_plist="$project_dir/launchd/${service_name}.plist"
  target_plist="$agent_dir/${service_name}.plist"
  plutil -lint "$source_plist"
  /usr/bin/install -m 644 "$source_plist" "$target_plist"
  launchctl bootout "$service_domain/$service_name" 2>/dev/null || true
done

# launchd 偶尔需要一点时间释放刚退出的 KeepAlive 任务；等待后重试，避免错误 5。
sleep 1
for service_name in "${services[@]}"; do
  target_plist="$agent_dir/${service_name}.plist"
  loaded="false"
  for retry_number in {1..5}; do
    if launchctl bootstrap "$service_domain" "$target_plist" 2>/dev/null; then
      loaded="true"
      break
    fi
    sleep 1
  done
  if [[ "$loaded" != "true" ]]; then
    echo "无法注册服务：$service_name"
    exit 1
  fi
  launchctl enable "$service_domain/$service_name"
done

echo "已安装开机自启，正在等待服务就绪…"
for attempt_number in {1..40}; do
  moye_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)"
  ocr_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/health || true)"
  if [[ "$moye_code" == "200" && "$ocr_code" == "200" ]]; then
    echo "墨页网页和识别服务均已就绪。"
    open "http://localhost:3000/"
    exit 0
  fi
  sleep 1
done

echo "服务尚未全部就绪，请查看：$project_dir/logs"
exit 1
