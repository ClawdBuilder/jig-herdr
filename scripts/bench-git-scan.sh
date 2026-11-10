#!/bin/sh
# Bench the git scan on throwaway repos. Usage: scripts/bench-git-scan.sh [N] [scan-file]
# SCAN_FILE may point at an old frozen script; otherwise the current SCRIPT is extracted from lib.js.
set -eu
N=${1:-20}
SCAN=${2:-}
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/jig-scan-bench.XXXXXX") || exit 1
trap 'rm -rf "$ROOT"' EXIT
if [ -z "$SCAN" ]; then
    SCAN=$ROOT/scan.sh
    node --input-type=module -e 'import { SCRIPT } from "./mods/jig-git/lib.js"; process.stdout.write(SCRIPT)' > "$SCAN"
fi
git init -q --bare "$ROOT/origin.git"
i=0
while [ "$i" -lt "$N" ]; do
    d=$ROOT/repo-$i
    git init -q -b main "$d"
    cd "$d"
    mkdir -p src
    files=200
    case $i in 0|1|2) files=2500;; esac
    j=0
    while [ "$j" -lt "$files" ]; do printf 'export const v%s = %s;\n' "$j" "$j" > "src/file-$j.js"; j=$((j + 1)); done
    git add -A
    git -c user.name=Bench -c user.email=bench@example.com commit -qm 'seed'
    git remote add origin "$ROOT/origin.git"
    if [ $((i % 3)) -eq 0 ]; then
        git switch -qc "feature/$i"
        printf 'change\n' >> README.md
        git add -A && git -c user.name=Bench -c user.email=bench@example.com commit -qm "feature $i"
        git push -q origin "feature/$i" 2>/dev/null || true
    fi
    if [ $((i % 4)) -eq 0 ]; then printf dirty > untracked.txt; fi
    cd "$ROOT"
    i=$((i + 1))
done
run_once() {
    start=$(date +%s%N 2>/dev/null || date +%s000000000)
    sh -c "$(cat "$SCAN")" sh "$ROOT" >/dev/null
    end=$(date +%s%N 2>/dev/null || date +%s000000000)
    echo $(( (end - start) / 1000000 ))
}
times=
i=0
while [ "$i" -lt 7 ]; do
    ms=$(run_once)
    times="$times $ms"
    i=$((i + 1))
done
median=$(printf '%s\n' $times | sort -n | sed -n '4p')
printf 'repos=%s median_ms=%s runs=%s\n' "$N" "$median" "$(printf '%s' "$times" | sed 's/^ //')"
if command -v strace >/dev/null 2>&1; then
    count=$(strace -f -c -e trace=execve -o "$ROOT/strace" sh -c "$(cat "$SCAN")" sh "$ROOT" >/dev/null 2>&1; awk '/execve/ {print $4}' "$ROOT/strace")
    printf 'execve=%s\n' "${count:-?}"
else
    mkdir -p "$ROOT/bin"
    GIT=$(command -v git)
    printf '#!/bin/sh\necho x >> "$JIG_GIT_COUNT"\nexec %s "$@"\n' "$GIT" > "$ROOT/bin/git"
    chmod +x "$ROOT/bin/git"
    rm -f "$ROOT/count"
    JIG_GIT_COUNT="$ROOT/count" PATH="$ROOT/bin:$PATH" sh -c "$(cat "$SCAN")" sh "$ROOT" >/dev/null
    printf 'git_processes=%s\n' "$(wc -l < "$ROOT/count" | tr -d ' ')"
fi
