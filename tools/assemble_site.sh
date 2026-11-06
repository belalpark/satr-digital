#!/usr/bin/env bash
# Assemble the Pages deployment: `main` at the root, every other branch under
# preview/<branch>/. Each copy gets build-info.json {sha, branch, builtAt}.
#
#   bash tools/assemble_site.sh dist
#
# Requires a full clone (fetch-depth: 0) so every remote branch is available.
set -euo pipefail

out=${1:-dist}
rm -rf "$out"
mkdir -p "$out"

SITE_PATHS=(index.html assets data media .nojekyll)

copy_ref() {
  local ref=$1 dest=$2 branch=$3
  mkdir -p "$dest"
  local present
  present=$(git ls-tree --name-only "$ref" -- "${SITE_PATHS[@]}" 2>/dev/null || true)
  if [ -n "$present" ]; then
    # shellcheck disable=SC2086
    git archive "$ref" $present | tar -x -C "$dest"
  fi
  printf '{"sha":"%s","branch":"%s","builtAt":"%s"}\n' \
    "$(git rev-parse "$ref")" "$branch" "$(date -u +%FT%TZ)" > "$dest/build-info.json"
  echo "  $branch -> $dest ($(git rev-parse --short "$ref"))"
}

echo "assembling into $out/"
if git show-ref --verify --quiet refs/remotes/origin/main; then
  copy_ref origin/main "$out" main
elif git show-ref --verify --quiet refs/heads/main; then
  copy_ref main "$out" main
fi

previews=()
# Full ref names: `%(refname:short)` turns the symbolic origin/HEAD into plain
# "origin", which would slip past the filter and publish a bogus preview/origin/.
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/origin/); do
  branch=${ref#refs/remotes/origin/}
  case "$branch" in main|HEAD) continue ;; esac
  copy_ref "$ref" "$out/preview/$branch" "$branch"
  previews+=("$branch")
done

# A root index that lists the previews when main does not ship a site yet.
if [ ! -f "$out/index.html" ]; then
  {
    cat <<'HTML'
<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>معاينات الفروع</title>
<style>body{font-family:"Segoe UI",Tahoma,system-ui,sans-serif;background:#f4f1ec;color:#1b1a17;margin:0;padding:48px 20px}
main{max-width:640px;margin:auto}h1{font-size:24px}ul{padding:0;list-style:none}li{margin:10px 0}
a{display:block;padding:14px 18px;background:#fff;border:1px solid #e3ddd3;border-radius:12px;color:#9a4521;text-decoration:none;font-weight:600}
p{color:#7a7368}</style></head><body><main>
<h1>التوأم الرقمي للمكتب — معاينات الفروع</h1>
<p>الفرع الرئيسي لا يحوي نسخة منشورة بعد. اختر معاينة:</p><ul>
HTML
    for b in "${previews[@]}"; do
      printf '<li><a href="preview/%s/">%s</a></li>\n' "$b" "$b"
    done
    cat <<'HTML'
</ul></main></body></html>
HTML
  } > "$out/index.html"
fi

echo "done: $(find "$out" -type f | wc -l) files"
