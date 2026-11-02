#!/bin/sh
# SCGC browser-watch — keeps the VNC session's browser state known and fresh.
#
# Every 30 seconds it checks (1) is a Firefox process running in this display
# session, and (2) does any open window's title carry "ChatGPT" (a ChatGPT tab
# is open and visible). State CHANGES are appended to
# /home/cos/cos-logs/browser-watch.log — one line per transition, quiet while
# nothing moves.
#
# Every 4 hours it refreshes Firefox: the ChatGPT page and the companion
# extension go stale when idle (the MV3-style worker suspends, the native model
# picker stops reading, queued inputs stop being claimed). Restarting Firefox
# restores the previous session — the ChatGPT tab and the installed extension
# come back — so the bridge reconnects and the picker/model catalog read again.
# The refresh only fires while Firefox is running and is logged.
#
# Started by xstartup so it survives app restarts inside the container.

LOG=/home/cos/cos-logs/browser-watch.log
REFRESH_EVERY=$((4 * 3600))
STATE="firefox=no chatgpt=no"
LAST_REFRESH=$(date +%s)

firefox_bin() {
  command -v firefox >/dev/null 2>&1 && { echo firefox; return; }
  command -v firefox-esr >/dev/null 2>&1 && { echo firefox-esr; return; }
  echo ""
}

while true; do
  firefox=no
  chatgpt=no
  BIN=$(firefox_bin)
  if [ -n "$BIN" ] && { pgrep -x firefox >/dev/null 2>&1 || pgrep -x firefox-esr >/dev/null 2>&1; }; then
    firefox=yes
    for w in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/[^0-9a-fx]/ /g' | tr ' ' '\n' | grep '^0x'); do
      title=$(xprop -id "$w" WM_NAME 2>/dev/null)
      case "$title" in
        *ChatGPT* | *chatgpt*)
          chatgpt=yes
          break
          ;;
      esac
    done
  fi
  cur="firefox=$firefox chatgpt=$chatgpt"
  if [ "$cur" != "$STATE" ]; then
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') state $cur" >> "$LOG"
    STATE="$cur"
  fi

  NOW=$(date +%s)
  if [ $((NOW - LAST_REFRESH)) -ge "$REFRESH_EVERY" ] && [ "$firefox" = "yes" ]; then
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') refreshing firefox (4h)" >> "$LOG"
    pkill -x firefox 2>/dev/null
    pkill -x firefox-esr 2>/dev/null
    # wait for the old process to fully exit before relaunching, so the
    # session-restore lock is released and the tabs come back cleanly.
    i=0
    while [ $i -lt 20 ] && { pgrep -x firefox >/dev/null 2>&1 || pgrep -x firefox-esr >/dev/null 2>&1; }; do
      sleep 1
      i=$((i + 1))
    done
    if [ -n "$BIN" ]; then
      setsid "$BIN" >/dev/null 2>&1 < /dev/null &
    fi
    LAST_REFRESH=$(date +%s)
  fi

  sleep 30
done
