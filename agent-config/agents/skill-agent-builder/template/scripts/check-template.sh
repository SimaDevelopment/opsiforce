#!/bin/bash
# Usage, from the workspace root:
#   sh scripts/check-template.sh ['<first-time setup command>']   development, on a kept copy
#   sh scripts/check-template.sh --production                     production, on a fresh copy of what git tracks
[ -n "${BASH_VERSION-}" ] || exec bash "$0" "$@"
set -u -o pipefail

mode=development
if [ "${1-}" = --production ]; then
  mode=production
  shift
  [ "$#" -eq 0 ] || { echo "usage: sh scripts/check-template.sh --production (Publish runs no setup, so it takes none)" >&2; exit 2; }
fi
setup=${1-}
source_dir=template
cache_dir=$PWD/.cache
copy_dir=$cache_dir/template-check
synced_list=$cache_dir/template-check.files
log=$cache_dir/template-check.log
if [ "$mode" = production ]; then
  copy_dir=$cache_dir/template-check-production
  synced_list=$cache_dir/template-check-production.files
  log=$cache_dir/template-check-production.log
fi
shim_dir=$cache_dir/template-check-bin
boot_timeout=${CHECK_TEMPLATE_TIMEOUT:-300}
group=""

say() { printf 'check-template: %s\n' "$*"; }

stop_group() {
  [ -n "$group" ] || return 0
  kill -TERM -- "-$group" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 -- "-$group" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -- "-$group" 2>/dev/null
  wait "$group" 2>/dev/null
  group=""
}

fail() {
  stop_group
  say "FAIL: $*"
  echo "--- last 40 lines of $log ---"
  tail -n 40 "$log" 2>/dev/null
  exit 1
}

trap stop_group EXIT
trap 'stop_group; exit 130' INT TERM

[ -d "$source_dir" ] || { say "no $source_dir/ here, so nothing to check (run it from the workspace root)"; exit 0; }

[ "$mode" = development ] || rm -rf "$copy_dir" "$synced_list"
mkdir -p "$copy_dir" "$shim_dir"
: > "$log"

sync_copy() {
  local listing=$synced_list.new
  (
    cd "$source_dir" && find . \
      \( -name .git -o -name .opencode -o -name .opsiforce -o -name .xdg \
         -o -name node_modules -o -name .pnpm-store -o -name data -o -name .cache -o -name .config \
         -o -name .bun -o -name user_uploaded_files -o -name generated_files \
         -o -path '*/.yarn/cache' -o -path '*/.yarn/unplugged' \) -prune \
      -o \( -type f -o -type l \) ! -name '.pnp.*' -print
  ) | sort > "$listing"
  if [ -f "$synced_list" ]; then
    comm -23 "$synced_list" "$listing" | while IFS= read -r gone; do
      rm -f "$copy_dir/$gone"
    done
  fi
  (cd "$source_dir" && tar -cf - -T "$listing") | (cd "$copy_dir" && tar -xpf -) || return 1
  mv "$listing" "$synced_list"
}

drop_git_ignored() {
  (
    cd "$copy_dir" && git init -q . && git ls-files -z --others --ignored --exclude-standard | xargs -0 rm -f
    status=$?
    rm -rf .git
    find . -mindepth 1 -type d -empty -delete
    exit "$status"
  ) >> "$log" 2>&1
}

sync_copy || fail "could not copy $source_dir/ into $copy_dir/"
if [ "$mode" = production ]; then
  drop_git_ignored || fail "could not drop what the Template's .gitignore files exclude from $copy_dir/"
  (cd "$copy_dir" && find . -type f | sed 's|^\./||' | sort) > "$synced_list"
fi
say "synced $source_dir/ into $copy_dir/ ($(wc -l < "$synced_list" | tr -d ' ') files)"

cat > "$shim_dir/guard" <<'SHIM'
#!/bin/sh
name=$1
shift
echo "[guard:$name] starting: $*"
exec "$@"
SHIM
chmod +x "$shim_dir/guard"

run_setup() {
  cd "$copy_dir" && exec bash -c "$setup" >> "$log" 2>&1
}

boot() {
  cd "$copy_dir" || return 1
  if [ "$mode" = production ]; then export OPSIFORCE_ENV=production; else unset OPSIFORCE_ENV; fi
  export APP_PORT="$port" PATH="$shim_dir:$PATH" && exec ./app/startup.sh >> "$log" 2>&1
}

in_own_group() {
  set -m
  "$@" &
  group=$!
  set +m
}

if [ -n "$setup" ]; then
  say "setup: $setup"
  in_own_group run_setup
  wait "$group"
  status=$?
  group_after_setup=$group
  group=""
  kill -KILL -- "-$group_after_setup" 2>/dev/null
  [ "$status" -eq 0 ] || fail "the setup exited $status"
fi

startup=$copy_dir/app/startup.sh
if [ ! -e "$startup" ]; then
  say "nothing to boot: $source_dir/ has no app/startup.sh${setup:+, and the setup passed}"
  exit 0
fi
[ -x "$startup" ] || fail "app/startup.sh is not executable (chmod +x $source_dir/app/startup.sh)"

port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})') \
  || fail "could not find a spare port"

say "booting app/startup.sh in $mode on port $port (up to ${boot_timeout}s)"
in_own_group boot

started=$SECONDS
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:$port/" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    say "PASS: answered HTTP $code on port $port after $((SECONDS - started))s; logs kept in $log"
    stop_group
    exit 0
  fi
  if ! kill -0 "$group" 2>/dev/null; then
    wait "$group" 2>/dev/null
    fail "app/startup.sh exited ($?) before anything answered on port $port"
  fi
  [ $((SECONDS - started)) -lt "$boot_timeout" ] || fail "nothing answered on port $port within ${boot_timeout}s"
  sleep 1
done
