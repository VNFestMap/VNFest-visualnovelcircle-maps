#!/usr/bin/env bash
set -euo pipefail

target="${TARGET:-/www/wwwroot/162.251.93.178}"
work="${WORK:-$target/.codex_site_header_20260827_184500}"
backup="${BACKUP:-$target/_deploy_backup_site_header_20260827_184500}"
payload="$work/payload"

test -d "$target"
test -f "$work/pages.txt"
test -f "$payload/css/site-header.css"
test -f "$payload/js/site-header.js"
test -f "$payload/user-v2-assets/index-DHfV2Xv6.js"
test -f "$payload/user-v2-assets/index-B4WJc6Ia.css"
test -f "$payload/new/star_map_3d.html"

mapfile -t pages < <(sed '/^[[:space:]]*$/d' "$work/pages.txt")
existing_pages=()
for rel in "${pages[@]}"; do
  if [ "$rel" = "star_map_3d.html" ]; then
    continue
  fi
  if [ ! -f "$target/$rel" ]; then
    printf 'MISSING_REMOTE|%s\n' "$rel"
    exit 20
  fi
  if grep -Iq 'site-header.css' "$target/$rel" || grep -Iq 'site-header.js' "$target/$rel"; then
    printf 'UNEXPECTED_EXISTING_HEADER|%s\n' "$rel"
    exit 21
  fi
  if ! grep -Iq '<title' "$target/$rel"; then
    printf 'MISSING_TITLE|%s\n' "$rel"
    exit 22
  fi
  existing_pages+=("$rel")
done

stage_page() {
  local rel="$1"
  local prefix="$2"
  local candidate="$work/candidates/$rel"
  mkdir -p "$(dirname "$candidate")"
  cp -- "$target/$rel" "$candidate"
  python3 - "$candidate" "$prefix" <<'PY'
import re
import sys
from pathlib import Path

candidate = Path(sys.argv[1])
prefix = sys.argv[2]
with candidate.open('r', encoding='utf-8', newline='') as handle:
    text = handle.read()
if 'site-header.css' in text or 'site-header.js' in text:
    raise SystemExit(f'existing site header marker in {candidate}')
match = re.search(r'(?im)^([ \t]*)<title\b[^>]*>.*?</title>[ \t]*(\r?\n)', text)
if not match:
    raise SystemExit(f'missing title marker in {candidate}')
indent = match.group(1)
newline = match.group(2)
insert = (
    f'{indent}<link rel="stylesheet" href="{prefix}css/site-header.css?v=20260827-site-header" />{newline}'
    f'{indent}<script defer src="{prefix}js/site-header.js?v=20260827-site-header"></script>{newline}'
)
with candidate.open('w', encoding='utf-8', newline='') as handle:
    handle.write(text[:match.end()] + insert + text[match.end():])
PY
}

for rel in "${existing_pages[@]}"; do
  dir="${rel%/*}"
  if [ "$dir" = "$rel" ]; then
    prefix=''
  else
    IFS='/' read -r -a parts <<< "$dir"
    prefix=''
    for _part in "${parts[@]}"; do prefix+='../'; done
  fi
  stage_page "$rel" "$prefix"
done

user_candidate="$work/candidates/user.html"
cp -- "$target/user.html" "$user_candidate"
python3 - "$user_candidate" <<'PY'
import re
import sys
from pathlib import Path

candidate = Path(sys.argv[1])
with candidate.open('r', encoding='utf-8', newline='') as handle:
    text = handle.read()
if 'site-header.css' in text:
    raise SystemExit('user.html already has an independent site-header marker')
text, js_count = re.subn(r'((?:\./)?user-v2-assets/)index-[^"\']+\.js', r'\g<1>index-DHfV2Xv6.js', text, count=1)
text, css_count = re.subn(r'((?:\./)?user-v2-assets/)index-[^"\']+\.css', r'\g<1>index-B4WJc6Ia.css', text, count=1)
if js_count != 1 or css_count != 1:
    raise SystemExit(f'user bundle refs unexpected: js={js_count} css={css_count}')
match = re.search(r'(?im)^([ \t]*)(<link\b[^>]*theme-tokens\.css[^>]*>[ \t]*)(\r?\n)', text)
if match:
    indent = match.group(1)
    newline = match.group(3)
    insertion = f'{indent}<link rel="stylesheet" href="./css/site-header.css?v=20260827-site-header" />{newline}'
    text = text[:match.end()] + insertion + text[match.end():]
else:
    match = re.search(r'(?im)^([ \t]*)</head>[ \t]*(\r?\n)', text)
    if not match:
        raise SystemExit('user.html has no head marker')
    indent = match.group(1)
    newline = match.group(2)
    insertion = f'{indent}<link rel="stylesheet" href="./css/site-header.css?v=20260827-site-header" />{newline}'
    text = text[:match.start()] + insertion + text[match.start():]
with candidate.open('w', encoding='utf-8', newline='') as handle:
    handle.write(text)
PY

cp -- "$payload/new/star_map_3d.html" "$work/candidates/star_map_3d.html"

mkdir -p "$backup" "$work/candidates"
chmod 0750 "$backup" "$work/candidates"
: > "$backup/baseline.tsv"
record_baseline() {
  local rel="$1"
  local file="$target/$rel"
  local hash
  local meta
  hash="$(sha256sum "$file" | awk '{print $1}')"
  meta="$(stat -c '%U|%G|%a|%s' "$file")"
  printf '%s|%s|%s\n' "$rel" "$hash" "$meta" >> "$backup/baseline.tsv"
}

for rel in "${existing_pages[@]}" user.html; do
  file="$target/$rel"
  mkdir -p "$backup/$(dirname "$rel")"
  cp -a -- "$file" "$backup/$rel"
  record_baseline "$rel"
done
for rel in css/site-header.css js/site-header.js user-v2-assets/index-DHfV2Xv6.js user-v2-assets/index-B4WJc6Ia.css star_map_3d.html; do
  file="$target/$rel"
  if [ -e "$file" ]; then
    mkdir -p "$backup/$(dirname "$rel")"
    cp -a -- "$file" "$backup/$rel"
    record_baseline "$rel"
  else
    printf 'NO_OLD_FILE|%s\n' "$rel" | tee -a "$backup/baseline.tsv"
  fi
done

printf '%s\n' '--- payload hashes'
sha256sum "$payload/css/site-header.css" "$payload/js/site-header.js" "$payload/user-v2-assets/index-DHfV2Xv6.js" "$payload/user-v2-assets/index-B4WJc6Ia.css" "$payload/new/star_map_3d.html"

install_existing() {
  local rel="$1"
  local expected="$2"
  local file="$target/$rel"
  local candidate="$work/candidates/$rel"
  local actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    printf 'OLD_HASH_CHANGED|%s|expected=%s|actual=%s\n' "$rel" "$expected" "$actual"
    exit 30
  fi
  chown www:www "$candidate"
  chmod 0644 "$candidate"
  mv -f -- "$candidate" "$file"
}

for rel in "${existing_pages[@]}" user.html; do
  expected="$(awk -F'|' -v wanted="$rel" '$1 == wanted {print $2; exit}' "$backup/baseline.tsv")"
  install_existing "$rel" "$expected"
done

if [ -e "$target/star_map_3d.html" ]; then
  printf 'NEW_FILE_RACE|star_map_3d.html\n'
  exit 31
fi
chown www:www "$work/candidates/star_map_3d.html"
chmod 0644 "$work/candidates/star_map_3d.html"
mv -f -- "$work/candidates/star_map_3d.html" "$target/star_map_3d.html"

install_new() {
  local rel="$1"
  local expected="$2"
  local source="$payload/$rel"
  local destination="$target/$rel"
  mkdir -p "$(dirname "$destination")"
  if [ -e "$destination" ]; then
    local actual
    actual="$(sha256sum "$destination" | awk '{print $1}')"
    if [ "$actual" != "$expected" ]; then
      printf 'NEW_ASSET_CONFLICT|%s|expected=%s|actual=%s\n' "$rel" "$expected" "$actual"
      exit 32
    fi
    chown www:www "$destination"
    chmod 0644 "$destination"
    return
  fi
  chown www:www "$source"
  chmod 0644 "$source"
  mv -f -- "$source" "$destination"
}
install_new css/site-header.css 70aa626b3870665bc4c2245d5f496d2459941f1b334de02019c967059a95d182
install_new js/site-header.js 9b68e3b434b5c329e3f73d4a23c51130aba0f76e51ba75d8f893330e0b78aa8c
install_new user-v2-assets/index-DHfV2Xv6.js 996d6de4d92dd1fe5c1d10194ab55016fd32b6806788df3fdb60987b9667d27b
install_new user-v2-assets/index-B4WJc6Ia.css 87d50f315e0fb87620e329e21b98370f39b3fd556d69aefb7659b75fbdd1d6f0

for directory in "$target/css" "$target/js" "$target/user-v2-assets" "$target/admin" "$target/Forum" "$target/Galgame_events" "$target/JUYOU" "$target/moe" "$target/twelve" "$target/wiki" "$target/wiki/pages" "$target/wiki/guide" "$target/wiki/library"; do
  if [ -d "$directory" ]; then
    chown www:www "$directory"
    chmod 0755 "$directory"
  fi
done

printf '%s\n' '--- installed files'
for rel in css/site-header.css js/site-header.js user.html user-v2-assets/index-DHfV2Xv6.js user-v2-assets/index-B4WJc6Ia.css star_map_3d.html; do
  file="$target/$rel"
  sha256sum "$file"
  stat -c '%n|%U|%G|%a|%s' "$file"
done
printf 'installed_html_pages=%s\n' "${#existing_pages[@]}"
printf 'backup=%s\n' "$backup"
rm -rf -- "$work"
printf 'temp_removed=%s\n' "$work"
