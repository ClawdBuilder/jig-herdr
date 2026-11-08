// One reader for the Pi session status files, shared by jig-work and jig-context (each mod imports its own copy of this
// file; a test checks the copies are identical). It reads the files the jig-session plugin writes, as its contract says:
// `<state dir>/sessions/*.json`, schema 1. Three scripts: SCRIPT reads every file (a full sweep), MTIMES only prints each
// file's mtime (the cheap check while a session works), and READ reads the files named as arguments (only those that moved).

// Run with `sh -c SCRIPT sh <state folder or "">`. Prints "@@dir <folder>" and each status file with a line before it:
// "@@file <1 if its pid runs, else 0> <path>". With no folder it uses jig-core's rule: $JIG_STATE_DIR, else
// ${XDG_STATE_HOME:-~/.local/state}/jig. Reads only; at most 64 files of 256 KiB.
// (No dollar-brace in here except the escaped ones: this is a JS template string.)
export const SCRIPT = `base=$1
case $base in
  "") base=\${JIG_STATE_DIR:-}
      if [ -z "$base" ]; then
        case \${XDG_STATE_HOME:-} in /*) base="$XDG_STATE_HOME/jig";; *) base="$HOME/.local/state/jig";; esac
      fi;;
  "~") base=$HOME;;
  "~/"*) base="$HOME/\${base#\\~/}";;
esac
d="$base/sessions"
printf '@@dir %s\\n' "$d"
n=0
for f in "$d"/*.json; do
  [ -f "$f" ] || continue
  n=$((n + 1)); [ $n -gt 64 ] && break
  pid=$(sed -n 's/^ *"pid": *\\([0-9][0-9]*\\).*/\\1/p' "$f" | head -n 1)
  alive=0
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
  printf '\\n@@file %s %s\\n' "$alive" "$f"
  head -c 262144 "$f"
done`;

// Run with `sh -c MTIMES sh <state folder or "">`. Prints one "@@mtime <path> <seconds>" line per status file and no
// bodies: the cheap check, so a panel can read only the files that moved.
export const MTIMES = `base=$1
case $base in
  "") base=\${JIG_STATE_DIR:-}
      if [ -z "$base" ]; then
        case \${XDG_STATE_HOME:-} in /*) base="$XDG_STATE_HOME/jig";; *) base="$HOME/.local/state/jig";; esac
      fi;;
  "~") base=$HOME;;
  "~/"*) base="$HOME/\${base#\\~/}";;
esac
d="$base/sessions"
printf '@@dir %s\\n' "$d"
n=0
for f in "$d"/*.json; do
  [ -f "$f" ] || continue
  n=$((n + 1)); [ $n -gt 64 ] && break
  m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
  s=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo 0)
  printf '@@mtime %s %s %s\\n' "$f" "$m" "$s"
done`;

// Run with `sh -c READ sh <status file>...`. The same "@@file <alive> <path>" + body format as SCRIPT, for the files
// named as arguments only.
export const READ = `n=0
for f in "$@"; do
  [ -f "$f" ] || continue
  n=$((n + 1)); [ $n -gt 64 ] && break
  pid=$(sed -n 's/^ *"pid": *\\([0-9][0-9]*\\).*/\\1/p' "$f" | head -n 1)
  alive=0
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
  printf '\\n@@file %s %s\\n' "$alive" "$f"
  head -c 262144 "$f"
done`;

// SCRIPT/READ output as [{ file, alive, status }]; a file that is not a status of schema 1 is left out.
export function parseSessions(stdout) {
    const sessions = [];
    for (const part of String(stdout ?? "")
        .split(/\n@@file /)
        .slice(1)) {
        const nl = part.indexOf("\n");
        const head = nl < 0 ? part : part.slice(0, nl);
        const body = nl < 0 ? "" : part.slice(nl + 1);
        const [alive, ...file] = head.split(" ");
        let status;
        try {
            status = JSON.parse(body);
        } catch {
            continue; // being written, or not ours
        }
        if (status?.schema !== 1 || typeof status.session !== "string") continue;
        sessions.push({ file: file.join(" "), alive: alive === "1", status });
    }
    return sessions;
}

/** MTIMES output as a map of status file -> "mtime:size" (seconds and bytes, so a same-second write still shows). */
export function parseMtimes(stdout) {
    const out = {};
    for (const line of String(stdout ?? "").split("\n")) {
        const m = /^@@mtime (.*) (\d+) (\d+)$/.exec(line.trim());
        if (m) out[m[1]] = `${m[2]}:${m[3]}`;
    }
    return out;
}

/** The status files whose mtime differs from the previous reading (new files count as changed). */
export function changedSince(previous, next) {
    const before = previous ?? {};
    return Object.entries(next ?? {})
        .filter(([file, at]) => before[file] !== at)
        .map(([file]) => file);
}

/** The sessions after reading only `incoming` files: the unchanged ones are kept, the read ones replace their old entry,
 *  and entries whose file is no longer listed are dropped. */
export function mergeSessions(previous, incoming, present) {
    const alive = new Set(present ?? []);
    const fresh = new Map((incoming ?? []).map((s) => [s.file, s]));
    const kept = (previous ?? []).filter((s) => alive.has(s.file) && !fresh.has(s.file));
    return [...kept, ...fresh.values()];
}

// The address Herdr gives the session's terminal: "t7" here, "<machine>/t7" on another machine. Only a terminal named by
// herdr-core (`terminalFrom` HC_TERMINAL_ID) has one; a tmux pane inside it does not.
export function addressOf(status, machine) {
    if (typeof status?.terminal !== "string" || status.terminal === "") return null;
    if (status.terminalFrom != null && status.terminalFrom !== "HC_TERMINAL_ID") return null;
    return machine ? `${machine}/${status.terminal}` : status.terminal;
}

const updated = (s) => Date.parse(s.status.updatedAt ?? "") || 0;

// The session to show: the one whose terminal is focused (or is the agent shown), else the one picked before while it
// lives, else the one updated last. `live` sessions only; returns { session, by } with by "focus", "picked" or "recent".
export function pickSession(sessions, { machine = null, focused = null, agent = null, picked = null } = {}) {
    const live = (sessions ?? []).filter((s) => s.alive);
    if (live.length === 0) return { session: null, by: null };
    for (const address of [focused, agent]) {
        if (!address) continue;
        const hit = live.find((s) => addressOf(s.status, machine) === address);
        if (hit) return { session: hit, by: "focus" };
    }
    const kept = picked && live.find((s) => s.status.session === picked);
    if (kept) return { session: kept, by: "picked" };
    return { session: [...live].sort((a, b) => updated(b) - updated(a))[0], by: "recent" };
}

/** The panel becoming visible again: the event that makes Work and Context read at once. */
export function shownAgain(previous, current) {
    return current === true && previous !== true;
}

/** Whether the followed terminal's Herdr status changed (working/idle/done) since the previous reading: the event that
 *  makes Work and Context read at once. */
export function terminalStateChanged(previous, current, address) {
    if (!address) return false;
    const before = (previous ?? []).find((t) => t.address === address)?.status;
    const now = (current ?? []).find((t) => t.address === address)?.status;
    return before !== now;
}
