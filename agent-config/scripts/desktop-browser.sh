#!/bin/sh
# External links from GUI apps must use the same display as agent browsers.
export DISPLAY=:99
if [ "$(id -u)" = 0 ]; then
  set -- --no-sandbox "$@"
fi
if [ "${AGENT_BROWSER_IGNORE_HTTPS_ERRORS:-}" = 1 ]; then
  set -- --ignore-certificate-errors "$@"
fi

/usr/bin/chromium "$@" &
browser=$!

# A login a command opens is for the user, so bring its window up for them.
(
  for attempt in $(seq 1 50); do
    window=$(wmctrl -lp 2>/dev/null | awk -v pid="$browser" '$3 == pid { print $1; exit }')
    if [ -n "$window" ]; then
      desktop show "$window" >/dev/null 2>&1
      exit 0
    fi
    kill -0 "$browser" 2>/dev/null || break
    sleep 0.2
  done
  desktop show >/dev/null 2>&1
) &

wait "$browser"
