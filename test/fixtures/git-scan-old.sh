root=$(cd "$1" 2>/dev/null && pwd -P) || root=$1
printf '@@root %s\n' "$root"
top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)
find_repos() {
  for a in "$root"/*/; do
    case $a in */node_modules/) continue;; esac
    if [ -d "$a.git" ]; then echo "${a%/}"; continue; fi
    for b in "$a"*/; do
      case $b in */node_modules/) continue;; esac
      if [ -d "$b.git" ]; then echo "${b%/}"; continue; fi
      for c in "$b"*/; do
        case $c in */node_modules/) continue;; esac
        [ -d "$c.git" ] && echo "${c%/}"
      done
    done
  done
}
branch_base() {
  cur=$(git -C "$1" symbolic-ref -q --short HEAD 2>/dev/null)
  hd=$(git -C "$1" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  hb=$(printf %s "$hd" | sed 's|^origin/||')
  case $cur in develop|main|master) return 0;; esac
  [ -n "$hb" ] && [ "$cur" = "$hb" ] && return 0
  bn=
  for c in origin/develop "$hd" origin/main origin/master develop main master; do
    [ -n "$c" ] || continue
    sha=$(git -C "$1" rev-parse --verify -q "$c^{commit}" 2>/dev/null) || continue
    case $c in origin/*) ;; *) tw=$(git -C "$1" rev-parse --verify -q "origin/$c^{commit}" 2>/dev/null) && [ "$tw" = "$sha" ] && continue;; esac
    mb=$(git -C "$1" merge-base "$c" HEAD 2>/dev/null) || continue
    n=$(git -C "$1" rev-list --count "$mb..HEAD" 2>/dev/null) || continue
    if [ -z "$bn" ] || [ "$n" -lt "$bn" ]; then best=$c; bmb=$mb; bn=$n; fi
  done
  [ -n "$bn" ] && [ "$bn" -gt 0 ] && printf '@@base %s\t%s\t%s\n' "$best" "$bmb" "$bn"
  return 0
}
scan() {
  printf '@@git %s\n' "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir --absolute-git-dir 2>/dev/null | tr '\n' '\t')"
  git -C "$1" remote get-url origin >/dev/null 2>&1 && printf '@@remote origin\n'
  head=$(git -C "$1" log -1 --format='%h%x1f%s%x1f%ct' 2>/dev/null) && printf '@@head %s\n' "$head"
  branch_base "$1"
  git -C "$1" --no-optional-locks -c core.fsmonitor=false -c core.quotePath=false status --porcelain=v1 -b --no-renames 2>&1 \
    | awk -v cap=200 'NR <= cap + 1 { print } END { print "=" (NR > 0 ? NR - 1 : 0) }'
}
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
if [ -n "${2-}" ]; then
  printf '%s
' "$2" > "$tmp/list"
else
  { if [ -n "$top" ]; then echo "$top"; else find_repos; fi; } | awk '!seen[$0]++' > "$tmp/list"
fi
n=0
while IFS= read -r repo; do
  [ -d "$repo" ] || continue
  printf '%s' "$repo" > "$tmp/$n.path"
  scan "$repo" > "$tmp/$n.out" &
  n=$((n + 1))
  [ $((n % 8)) -eq 0 ] && wait
done < "$tmp/list"
wait
i=0
while [ $i -lt $n ]; do
  printf '@@repo %s\n' "$(cat "$tmp/$i.path")"
  cat "$tmp/$i.out"
  i=$((i + 1))
done