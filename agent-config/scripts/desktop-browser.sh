#!/bin/sh
# External links from GUI apps must use the same display as agent browsers.
export DISPLAY=:99
if [ "$(id -u)" = 0 ]; then
  set -- --no-sandbox "$@"
fi
exec /usr/bin/chromium "$@"
