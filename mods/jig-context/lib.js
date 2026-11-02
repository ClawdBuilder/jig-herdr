// Pure helpers of jig-context, kept apart from main.js so they can be tested outside Herdr. Mods cannot import each other,
// so the session finding (SCRIPT, parseSessions, pickSession, isShown) is a copy of jig-work's; a test runs both copies.

// Run with `sh -c SCRIPT sh <state folder or "">` on the machine where Pi runs. Prints each status file jig-session wrote in
// <state folder>/sessions with a line before it: "@@file <1 if its pid runs, else 0> <path>". With no folder it uses
// jig-core's rule: $JIG_STATE_DIR, else ${XDG_STATE_HOME:-~/.local/state}/jig. Reads only; at most 64 files of 256 KiB.
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

// Run with `sh -c WRITE sh <request file> <json>`: writes the request through a temporary file and a rename, so the session
// never reads half of one. The only thing this panel writes.
export const WRITE = 'printf %s "$2" > "$1.tmp" && mv "$1.tmp" "$1"';

// The Work panel's config.json (mods/jig-work/config.json) as { machine, stateDir }: both panels show the same sessions.
export function parseConfig(text) {
    const config = { machine: null, stateDir: null, problems: [] };
    if (text == null || text.trim() === "") return config;
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        config.problems.push(`jig-work's config.json is not valid JSON: ${e.message}`);
        return config;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return config;
    for (const key of ["machine", "stateDir"]) {
        if (typeof raw[key] === "string" && raw[key].trim() !== "") config[key] = raw[key].trim();
    }
    return config;
}

// The script's output as [{ file, alive, status }]; a file that is not a status of schema 1 is left out.
export function parseSessions(stdout) {
    const sessions = [];
    for (const part of stdout.split(/\n@@file /).slice(1)) {
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

// The address Herdr gives the session's terminal: "t7" here, "<machine>/t7" on another machine; only herdr-core's names.
export function addressOf(status, machine) {
    if (typeof status?.terminal !== "string" || status.terminal === "") return null;
    if (status.terminalFrom != null && status.terminalFrom !== "HC_TERMINAL_ID") return null;
    return machine ? `${machine}/${status.terminal}` : status.terminal;
}

const updated = (s) => Date.parse(s.status.updatedAt ?? "") || 0;

// The session to show: the focused terminal's (or the agent shown), else the one updated last. Live ones only.
export function pickSession(sessions, { machine = null, focused = null, agent = null } = {}) {
    const live = sessions.filter((s) => s.alive);
    if (live.length === 0) return { session: null, by: null };
    for (const address of [focused, agent]) {
        if (!address) continue;
        const hit = live.find((s) => addressOf(s.status, machine) === address);
        if (hit) return { session: hit, by: "focus" };
    }
    return { session: [...live].sort((a, b) => updated(b) - updated(a))[0], by: "recent" };
}

function chainTo(node, mod) {
    if (!node) return null;
    if (node.content?.mod === mod) return [node];
    for (const child of node.children ?? []) {
        const rest = chainTo(child, mod);
        if (rest) return [node, ...rest];
    }
    return null;
}

// Whether a mod's block is on screen: nothing hidden on the way down, every stack showing the right child.
export function isShown(root, mod) {
    const chain = chainTo(root, mod);
    if (!chain) return true;
    return chain.every((node, i) => {
        if (node.hidden) return false;
        if (node.type !== "stack") return true;
        return (node.active ?? node.children?.[0]?.id) === chain[i + 1]?.id;
    });
}

// The request file of a session, next to its status file: <state>/requests/<name> for <state>/sessions/<name>.
export function requestPath(statusFile) {
    const m = /^(.*)\/sessions\/([^/]+\.json)$/.exec(statusFile ?? "");
    return m ? `${m[1]}/requests/${m[2]}` : null;
}

// Tokens as "12k", "1.2k", "1.2M".
export function short(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "?";
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
}

// A share of the window as "6.1%", "<0.1%" or "0%".
export function percent(tokens, window) {
    if (!window || typeof tokens !== "number") return "";
    const p = (tokens / window) * 100;
    if (p === 0) return "0%";
    if (p < 0.1) return "<0.1%";
    return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

// The parts in the order the panel lists them, with the theme colour each is drawn in. `estimate` marks the ones counted
// as characters / 4 (shown with "≈"); the reserve is a setting and the free space what the others leave.
export const PARTS = [
    { key: "messages", label: "Messages", color: "accent", estimate: true },
    { key: "tools", label: "Tools", color: "ansi6", estimate: true },
    { key: "system", label: "System prompt", color: "foreground", estimate: true },
    { key: "skills", label: "Skills", color: "ansi5", estimate: true },
    { key: "contextFiles", label: "Context files", color: "ansi3", estimate: true },
    { key: "reserve", label: "Compaction buffer", color: "dim", estimate: false },
    { key: "free", label: "Free space", color: "raised", estimate: false },
];

// The bar and its legend: [{ key, label, color, tokens, share, estimate }] where share is the part of the window, 0 to 1.
// An unknown part (Messages after a compaction, until the next reply) has tokens null and share 0.
export function segments(detail) {
    if (!detail || typeof detail !== "object") return [];
    const window = typeof detail.window === "number" && detail.window > 0 ? detail.window : null;
    const parts = detail.parts ?? {};
    return PARTS.map((p) => {
        const raw = p.key === "reserve" || p.key === "free" ? detail[p.key] : parts[p.key];
        const tokens = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
        return { ...p, tokens, share: window && tokens ? tokens / window : 0 };
    });
}

// The headline: "62% used · 124k / 200k", or what is unknown.
export function headline(detail) {
    if (!detail || typeof detail !== "object") return "No context figures from this session";
    const { used, window } = detail;
    if (typeof window !== "number" || window <= 0) return used == null ? "Context size unknown" : `${short(used)} used`;
    if (typeof used !== "number") return `Unknown until the next reply · ${short(window)} window`;
    return `${Math.round((used / window) * 100)}% used · ${short(used)} / ${short(window)}`;
}

// The switches waiting for an answer, merged: a newer request carries every unanswered switch, so a request the session
// had not taken yet is never lost when the next one replaces its file. Returns the new pending set.
export function addSwitch(pending, kind, name, on) {
    const next = {
        tools: { ...(pending?.tools ?? {}) },
        skills: { ...(pending?.skills ?? {}) },
        reload: !!pending?.reload,
    };
    if (kind === "reload") next.reload = true;
    else next[kind][name] = on;
    return next;
}

// The request file's text for a pending set (the jig-session request contract, schema 1).
export function requestJson(id, pending) {
    const out = { schema: 1, id };
    if (Object.keys(pending.tools).length) out.tools = pending.tools;
    if (Object.keys(pending.skills).length) out.skills = pending.skills;
    if (pending.reload) out.reload = true;
    return JSON.stringify(out);
}

// A switch as the panel draws it: the pending wish while one waits, else the session's state.
export function shownOn(pending, kind, name, on) {
    const wish = pending?.[kind]?.[name];
    return typeof wish === "boolean" ? wish : on;
}

// "/a/b/AGENTS.md" as { dir: "/a/b/", name: "AGENTS.md" }.
export function splitPath(p) {
    const cut = p.lastIndexOf("/");
    return { dir: cut < 0 ? "" : p.slice(0, cut + 1), name: cut < 0 ? p : p.slice(cut + 1) };
}

// A folder's last part, for the header ("~" for the home folder).
export function folderName(cwd, home) {
    if (!cwd) return "?";
    if (home && cwd.replace(/\/+$/, "") === home.replace(/\/+$/, "")) return "~";
    return cwd.replace(/\/+$/, "").split("/").pop() || "/";
}
