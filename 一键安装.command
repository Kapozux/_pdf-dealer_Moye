#!/bin/zsh
# 双击运行。第一次从网上下载的 .command 会被 macOS 拦下：右键 → 打开 → 打开，只需一次。
cd -- "$(dirname -- "$0")"
./install.sh "$@"
status=$?
echo
read -r "?按回车关闭这个窗口…"
exit $status
