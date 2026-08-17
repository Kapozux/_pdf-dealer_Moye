#!/bin/zsh
set -e

cd -- "$(dirname -- "$0")"
exec "./启动全部服务.command"
