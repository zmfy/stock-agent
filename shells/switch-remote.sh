#!/bin/bash
# switch-remote.sh — 切换本仓库 origin 指向
# 用法: bash shells/switch-remote.sh github
#       bash shells/switch-remote.sh gitee

GITHUB="git@github.com/zmfy/stock-agent.git"
GITEE="git@gitee.com:unknow3/stock-agent.git"

case "${1:-}" in
  github)
    git remote set-url origin "$GITHUB"
    echo "origin → GitHub: $GITHUB"
    ;;
  gitee)
    git remote set-url origin "$GITEE"
    echo "origin → Gitee: $GITEE"
    ;;
  *)
    echo "用法: $0 <github|gitee>"
    echo ""
    echo "当前 origin: $(git remote get-url origin)"
    exit 1
    ;;
esac
