#!/bin/sh
# Usage, from the workspace root:
#   sh scripts/template-snapshot.sh save             after a save answered 200
#   sh scripts/template-snapshot.sh diff             before a check or a save; exits 1 when template/ differs
#   sh scripts/template-snapshot.sh restore <path>…  put the saved copy of each path back
set -u

source_dir=template
saved_dir=.cache/template-saved
listing=$PWD/.cache/template-snapshot.files
before=$PWD/.cache/template-snapshot.before

say() { printf 'template-snapshot: %s\n' "$*"; }

usage() {
  echo "usage: sh scripts/template-snapshot.sh save | diff | restore <path>..." >&2
  exit 2
}

list_files() {
  [ -d "$1" ] || return 0
  (
    cd "$1" && find . \
      \( -name .git -o -name .opencode -o -name .opsiforce -o -name .xdg \
         -o -name node_modules -o -name .pnpm-store -o -name data -o -name .cache -o -name .config \
         -o -name .bun -o -name user_uploaded_files -o -name generated_files \
         -o -path '*/.yarn/cache' -o -path '*/.yarn/unplugged' \) -prune \
      -o \( -type f -o -type l \) -print
  ) | sed 's|^\./||' | LC_ALL=C sort
}

save() {
  mkdir -p .cache && list_files "$source_dir" > "$listing" || exit 1
  rm -rf "$saved_dir" && mkdir -p "$saved_dir" || { rm -f "$listing"; exit 1; }
  if [ -s "$listing" ]; then
    (cd "$source_dir" && tar -cf - -T "$listing") | (cd "$saved_dir" && tar -xpf -) || {
      rm -f "$listing"
      say "could not copy $source_dir/ into $saved_dir/"
      exit 1
    }
  fi
  say "saved $(wc -l < "$listing" | tr -d ' ') files of $source_dir/ into $saved_dir/"
  rm -f "$listing"
}

compare() {
  if [ ! -d "$saved_dir" ]; then
    say "no snapshot yet, so nothing to compare"
    exit 0
  fi
  list_files "$source_dir" > "$listing" && list_files "$saved_dir" > "$before" || exit 1
  changes=$(
    LC_ALL=C comm -13 "$before" "$listing" | sed 's/^/A /'
    LC_ALL=C comm -23 "$before" "$listing" | sed 's/^/D /'
    LC_ALL=C comm -12 "$before" "$listing" | while IFS= read -r file; do
      cmp -s "$saved_dir/$file" "$source_dir/$file" || printf 'M %s\n' "$file"
    done
  )
  rm -f "$listing" "$before"
  if [ -z "$changes" ]; then
    say "$source_dir/ matches the last save"
    exit 0
  fi
  printf '%s\n' "$changes" | LC_ALL=C sort -k2
  exit 1
}

restore() {
  [ "$#" -gt 0 ] || usage
  [ -d "$saved_dir" ] || { say "no snapshot yet, so nothing to restore"; exit 1; }
  status=0
  for file in "$@"; do
    file=${file#./}
    file=${file#"$source_dir"/}
    case "/$file/" in
      */../* | //*) say "refusing $file: give a path inside $source_dir/"; status=1; continue ;;
    esac
    if [ -e "$saved_dir/$file" ] || [ -L "$saved_dir/$file" ]; then
      mkdir -p "$(dirname "$source_dir/$file")" && rm -f "$source_dir/$file" \
        && cp -p "$saved_dir/$file" "$source_dir/$file" && say "restored $file" || status=1
    elif [ -e "$source_dir/$file" ] || [ -L "$source_dir/$file" ]; then
      rm -f "$source_dir/$file" && say "removed $file, which the last save did not have" || status=1
    else
      say "$file is in neither $source_dir/ nor the last save"
      status=1
    fi
  done
  exit "$status"
}

case "${1-}" in
  save) save ;;
  diff) compare ;;
  restore) shift; restore "$@" ;;
  *) usage ;;
esac
