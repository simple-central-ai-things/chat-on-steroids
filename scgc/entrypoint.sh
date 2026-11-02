#!/bin/sh
# SCGC entrypoint — start Xvnc in the background, wait for the display, then
# run the session (xstartup) as PID 1.
#
# Why not `CMD vncserver :1`: vncserver daemonizes Xtigervnc and returns, so
# Docker sees PID 1 exit and kills the container immediately. Running Xvnc
# directly keeps the CoS process (xstartup's exec target) as PID 1, so a CoS
# crash exits the container and compose restarts it.
#
# No `-localhost` => Xvnc listens on all interfaces, so the published host
# port is reachable; auth is the VncAuth passwd file.
set -e
# A hard-killed or crashed container leaves display :1's lock/socket files in
# /tmp; Xvnc refuses to start against them, and once a PID gets reused the
# lock even looks live. The entrypoint is the sole owner of display :1 inside
# the container's PID namespace, so clearing stale state here is safe.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvnc :1 -geometry 1920x1080 -depth 24 \
  -rfbauth /home/cos/.config/tigervnc/passwd \
  -SecurityTypes VncAuth &
i=0
while [ $i -lt 30 ] && [ ! -e /tmp/.X11-unix/X1 ]; do sleep 1; i=$((i+1)); done
[ -e /tmp/.X11-unix/X1 ] || { echo "X display :1 never came up"; exit 1; }
export DISPLAY=:1
exec /home/cos/.config/tigervnc/xstartup
