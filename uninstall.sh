#!/bin/zsh
# 撤掉墨页的开机自启服务。不删任何数据：转换结果在 data/，删掉项目文件夹才算彻底清空。
# Ollama、LibreOffice、Homebrew 装的 llama.cpp 是独立程序，别的软件也可能在用，这里不动。
set -u
service_domain="gui/$(id -u)"
for service_name in com.kapozux.moye-ocr com.kapozux.moye-web; do
  launchctl bootout "$service_domain/$service_name" 2>/dev/null && echo "已停止 $service_name"
  rm -f "$HOME/Library/LaunchAgents/$service_name.plist"
done
echo "开机自启已撤掉。要彻底删除，把这个文件夹移到废纸篓即可（Node / Python 环境都在里面的 .runtime、.venv）。"
