#!/bin/zsh
set -e

project_dir="/Users/kapozux/Documents/Playground/pdf2md-web"
current_uid="$(id -u)"
service_domain="gui/${current_uid}"
services=(com.kapozux.moye-ocr com.kapozux.moye-web)

if ! launchctl print "$service_domain/com.kapozux.moye-web" >/dev/null 2>&1; then
  exec "$project_dir/安装开机自启.command"
fi

for service_name in "${services[@]}"; do
  launchctl kickstart "$service_domain/$service_name" 2>/dev/null || true
done

echo "正在等待服务就绪…"
for attempt_number in {1..30}; do
  moye_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)"
  ocr_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/health || true)"
  if [[ "$moye_code" == "200" && "$ocr_code" == "200" ]]; then
    echo "全部服务已启动。"
    open "http://localhost:3000/"
    exit 0
  fi
  sleep 1
done

echo "启动超时，请查看：$project_dir/logs"
exit 1
