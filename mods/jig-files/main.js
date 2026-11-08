// The Files panel of the jig layout: a lazy file browser for the focused pane's folder. A click on a file opens it in its
// own tab (the file-view mod, one tab per file); a second click selects that tab. Folders open in place, and files with
// uncommitted changes carry a letter.
//
// Derived from the `files` mod shipped with the Herdr app (mods/files/main.js, version 0.1.11), Copyright the Herdr authors,
// licensed under the Apache License, Version 2.0 (the LICENSE file in the Herdr app's folder,
// http://www.apache.org/licenses/LICENSE-2.0). Changed: a click opens the file in a `file-view` tab instead of a preview
// inside the panel, the tab bookkeeping that goes with it, and the icons, which are Herdr's own `workspace-chrome` ones.

import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import {
    appHome,
    exec,
    focused,
    layout,
    panes,
    readTextFile,
    run,
    setShared,
    shared,
    spaces,
    theme,
    watchFolder,
    window,
} from "herdr";

import { deletedPaths, FIND, filterPaths, parseConfig, searchDue } from "./lib.js";
import {
    focusRegained,
    RefreshScheduler,
    RefreshState,
    readDeadline,
    readTimeoutSeconds,
    refreshSeconds,
} from "./refresh.js";

function location() {
    const space = spaces().find((s) => s.active),
        f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const on =
        f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
    return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const OWN = (name) => `mods/jig-files/${name}.svg`;

// A 22x20 icon button for the header, like the Changes panel's.
function iconButton(t, id, icon, tip, onClick, busy = false) {
    return div()
        .id(id)
        .flex_none()
        .w(22)
        .h(20)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(busy ? t.dim : t.muted)
        .when(busy, (el) => el.opacity(0.6))
        .cursor_pointer()
        .hover((s) => s.bg(t.raised).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
            cx.stop_propagation();
            onClick(cx);
        })
        .tooltip(tip)
        .child(svg(icon).size(13));
}

const PER_FOLDER = 500,
    TOTAL = 5000;

async function directory(path, on) {
    if (!on && window()?.platform === "windows") {
        const r = await this.execD("powershell", [
            "-NoProfile",
            "-Command",
            "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" +
                path.replaceAll("'", "''") +
                "'",
        ]);
        if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
        const result = JSON.parse(r.stdout || "[]");
        return Array.isArray(result) ? result : [result];
    }
    const script = `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=\${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"`;
    const r = await this.execD("sh", ["-c", script, "files", path], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const fields = r.stdout.split("\0"),
        out = [];
    for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
    return out;
}

export default class Files extends View {
    init(_props, cx) {
        this.saved = new Map();
        this.entries = new Map();
        this.folders = new Set();
        this.pending = new Set();
        this.marks = {};
        this.opening = []; // file tabs just asked for, waiting to appear: { key, space, name, before, at }
        this.config = parseConfig(null);
        this.configAt = 0;
        this.loaded = false;
        this.started = false;
        this.filterDirty = false;
        this.readTimeoutSeconds = 20;
        this.readGeneration = 0;
        this.deleted = [];
        this.filter = "";
        this.matches = null;
        this.filterLoading = false;
        this.filterAt = 0;
        this.refreshState = new RefreshState();
        this.refreshScheduler = new RefreshScheduler({ seconds: refreshSeconds(this.config) });
        this.windowActive = window()?.active === true;
        this.seen = false;
        this.width = 0;
        this.lastRenderAt = Date.now();
        this.input = InputState.new({ placeholder: "Filter files" });
        this.input.on("change", (_e, cx) => {
            this.filter = this.input.value();
            this.matches = null;
            this.filterDirty = true;
            this.filterAt = Date.now();
            cx.notify();
        });
        this.loadConfig(cx);
        cx.timer.every(1000, (cx) => this.tick(cx));
        cx.timer.every(500, () => this.claim());
        this.refresh(cx, false);
    }

    execD(cmd, args, opts) {
        const seconds = Math.max(1, Math.ceil(this.readTimeoutSeconds));
        const wrapper = `if command -v timeout >/dev/null 2>&1; then exec timeout ${seconds} "$@"; fi; exec "$@"`;
        const once = () => exec("sh", ["-c", wrapper, "sh", cmd, ...args], opts);
        // Some Herdr shells cannot make or cancel a timer: readDeadline can throw before it returns (or reject with that
        // instead of a result). The command itself is read-only, so run it once more without the deadline; the app still
        // caps every command at 30 s.
        let bounded;
        try {
            bounded = readDeadline(once(), this.readTimeoutSeconds);
        } catch (e) {
            if (String(e?.message ?? e).includes("clearTimeout")) return once();
            throw e;
        }
        return bounded.catch((e) => {
            if (String(e?.message ?? e).includes("clearTimeout")) return once();
            throw e;
        });
    }

    watch(root, cx) {
        if (this.on || this.watched === root) return;
        this.watched = root;
        const context = this.context;
        cx.spawn(async (cx) => {
            try {
                while (this.context === context) {
                    await watchFolder(root);
                    if (this.current(context)) {
                        this.refreshScheduler.trigger();
                        cx.notify();
                    }
                }
            } catch {
                if (this.context === context) this.watched = null;
            }
        });
    }

    current(context) {
        return this.context === context && key() === context.key;
    }

    async loadFolder(path, context) {
        const { on, cwd: root } = context;
        const entries = await directory(path ? `${root}/${path}` : root, on);
        if (!this.current(context) || (path && !this.folders.has(path))) return;
        const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
        this.entries.set(
            path,
            entries
                .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
                .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
        );
        if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
    }

    tick(cx) {
        const shown = Boolean(this.lastRenderAt) && Date.now() - this.lastRenderAt < 2500;
        if (!shown) {
            if (this.refreshScheduler.due()) cx.notify();
            this.seen = false;
            return;
        }
        if (!this.seen) {
            this.seen = true;
            this.refreshScheduler.trigger();
        }
        const active = window()?.active === true;
        if (focusRegained(this.windowActive, active)) this.refreshScheduler.trigger();
        this.windowActive = active;
        this.loadConfig(cx);
        if (key() !== this.context?.key) this.refreshScheduler.trigger();
        if (
            searchDue({
                filter: this.filter,
                dirty: this.filterDirty,
                loading: this.filterLoading,
                at: this.filterAt,
                now: Date.now(),
            })
        )
            this.search(cx);
        if (!this.loading && this.refreshScheduler.due()) this.refresh(cx, false);
    }

    loadConfig(cx) {
        if (this.configAt && Date.now() - this.configAt < 5000) return;
        this.configAt = Date.now();
        cx.spawn(async (cx) => {
            const text = await readTextFile(`${appHome()}/mods/jig-files/config.json`).catch(() => null);
            this.config = parseConfig(text);
            this.readTimeoutSeconds = readTimeoutSeconds(this.config);
            this.refreshScheduler.setSeconds(refreshSeconds(this.config));
            cx.notify();
        });
    }

    /** The flat filter: a bounded find over the folder, matching paths (case aside). */
    search(cx) {
        if (!this.root || this.filterLoading) return;
        this.filterAt = Date.now();
        this.filterDirty = false;
        this.filterLoading = true;
        const root = this.root,
            on = this.on,
            query = this.filter,
            context = this.context;
        cx.spawn(async (cx) => {
            try {
                const r = await this.execD("sh", ["-c", FIND, "sh", root], { on }).catch(() => null);
                if (context !== this.context || query !== this.filter) return;
                this.matches = r?.code === 0 ? filterPaths(r.stdout, root, query) : [];
            } finally {
                this.filterLoading = false;
                cx.notify();
            }
        });
    }

    refresh(cx, user = false) {
        const { cwd, on } = location(),
            next = key();
        if (next !== this.context?.key) {
            if (this.context) this.saved.set(this.context.key, { folders: this.folders });
            const saved = this.saved.get(next);
            this.context = { key: next, cwd, on };
            this.root = cwd;
            this.on = on;
            this.entries = new Map();
            this.folders = new Set(saved?.folders);
            this.pending = new Set();
            this.marks = {};
            this.deleted = [];
            this.watched = null;
            this.error = null;
            this.limited = false;
            this.loading = false;
        }
        if (!cwd) return;
        if (!this.refreshState.start({ user, first: !this.started, notify: () => cx.notify() })) return;
        this.started = true;
        this.refreshScheduler.sweep();
        this.limited = false;
        const context = this.context,
            run = ++this.readGeneration;
        this.loading = true;
        cx.spawn(async (cx) => {
            let timedOut = false;
            try {
                for (const path of ["", ...this.folders]) {
                    if (!this.current(context)) return;
                    await this.loadFolder(path, context);
                }
                const top = await this.execD("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
                const marks = {};
                let deleted = [];
                if (top?.code === 0) {
                    // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
                    const status = await this.execD(
                        "git",
                        [
                            "--no-optional-locks",
                            "-c",
                            "core.fsmonitor=false",
                            "status",
                            "--porcelain=v1",
                            "-z",
                            "--no-renames",
                            "--untracked-files=normal",
                        ],
                        { cwd, on },
                    ).catch(() => null);
                    if (status?.code === 0) {
                        deleted = deletedPaths(status.stdout, top.stdout.trim());
                        for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
                            const xy = entry.slice(0, 2);
                            if (xy.includes("D")) continue; // a deleted path has no row in the listing; it is added below
                            marks[`${top.stdout.trim()}/${entry.slice(3)}`] =
                                xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : "M";
                        }
                    }
                }
                if (run !== this.readGeneration || !this.current(context)) return;
                this.marks = marks;
                this.deleted = deleted;
                this.error = null;
                this.loaded = true;
                if (this.filter.trim()) {
                    this.filterDirty = true;
                    this.filterAt = Date.now();
                }
                this.watch(cwd, cx);
            } catch (e) {
                if (run !== this.readGeneration) return;
                timedOut = String(e?.message ?? e).includes("Reading timed out");
                if (timedOut) this.readGeneration++;
                else if (this.current(context)) this.error = String(e);
            } finally {
                if (run === this.readGeneration || timedOut) {
                    this.loading = false;
                    const again = this.refreshState.finish();
                    if (again) this.refreshScheduler.trigger();
                    cx.notify();
                }
            }
        });
    }

    toggle(path, cx) {
        if (this.folders.has(path)) {
            for (const folder of [...this.folders])
                if (folder === path || folder.startsWith(`${path}/`)) {
                    this.folders.delete(folder);
                    this.entries.delete(folder);
                }
        } else {
            this.folders.add(path);
            if (!this.entries.has(path) && !this.pending.has(path)) {
                const context = this.context;
                this.pending.add(path);
                cx.spawn(async (cx) => {
                    try {
                        await this.loadFolder(path, context);
                    } catch (e) {
                        if (this.current(context)) this.error = String(e);
                    } finally {
                        if (this.context === context) this.pending.delete(path);
                        cx.notify();
                    }
                });
            }
        }
        cx.notify();
    }

    // The file's tab in the shown space: its id from the path -> tab map, if that tab is still there.
    // (A tab entry does not expose its props, so the map is how a path finds its tab.)
    fileTab(key, space) {
        const id = shared("file-view.tabs")?.[key];
        return id && space.tabs.some((t) => t.id === id) && panes().some((p) => p.tab === id && p.mod === "file-view")
            ? id
            : null;
    }

    // A click on a file: select its tab, or open a new one and remember which tab it became.
    open(path) {
        const space = spaces().find((s) => s.active);
        if (!space) return;
        const abs = `${this.root}/${path}`,
            key = `${this.on ?? ""}|${abs}`,
            name = path.split("/").pop();
        const id = this.fileTab(key, space);
        if (id) return run("tab.select", { id });
        if (this.opening.some((o) => o.key === key)) return; // already on its way
        this.opening.push({ key, space: space.id, name, before: new Set(space.tabs.map((t) => t.id)), at: Date.now() });
        run("tab.new", { space: space.id, name, mod: "file-view", props: { on: this.on, path: abs } });
    }

    // tab.new does not hand back the new tab's id to a mod: find it as the tab that was not there before.
    // Every 500 ms, and only does work while a file is opening.
    claim() {
        if (!this.opening.length) return;
        const map = shared("file-view.tabs") ?? {},
            taken = new Set(Object.values(map)),
            found = {};
        this.opening = this.opening.filter((o) => {
            if (Date.now() - o.at > 8000) return false;
            const fresh =
                spaces()
                    .find((s) => s.id === o.space)
                    ?.tabs.filter((t) => !o.before.has(t.id) && !taken.has(t.id)) ?? [];
            const tab = fresh.find((t) => t.name === o.name) ?? fresh[0];
            if (!tab) return true;
            found[o.key] = tab.id;
            taken.add(tab.id);
            return false;
        });
        if (!Object.keys(found).length) return;
        // Drop entries for tabs that were closed, so a path opens a fresh tab next time.
        const live = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
        const next = Object.fromEntries(Object.entries({ ...map, ...found }).filter(([, id]) => live.has(id)));
        setShared("file-view.tabs", next);
    }

    rows(prefix, depth, out, t) {
        if (out.length >= TOTAL || depth > 40) return out;
        for (const entry of this.entries.get(prefix) ?? []) {
            if (out.length >= TOTAL) break;
            const path = prefix ? `${prefix}/${entry.name}` : entry.name,
                open = this.folders.has(path),
                mark = this.marks[`${this.root}/${path}`];
            out.push(
                h_flex()
                    .id(`file-${path}`)
                    .h(28)
                    .flex_none()
                    .pl(8 + depth * 18)
                    .pr(8)
                    .gap(7)
                    .items_center()
                    .rounded(7)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .when(entry.dir, (el) => el.tooltip(`${this.root}/${path}`))
                    .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.open(path)))
                    .child(
                        entry.dir
                            ? svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`)
                                  .size(12)
                                  .flex_none()
                                  .text_color(t.dim)
                            : div().w(12).flex_none(),
                    )
                    .child(
                        svg(`mods/workspace-chrome/${entry.dir ? "folder" : "file-text"}.svg`)
                            .size(14)
                            .flex_none()
                            .text_color(t.muted),
                    )
                    .child(div().flex_1().min_w(0).truncate().child(entry.name))
                    .when(Boolean(mark), (el) =>
                        el.child(
                            div()
                                .text_size(11)
                                .text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked)
                                .child(mark),
                        ),
                    ),
            );
            if (entry.dir && open) this.rows(path, depth + 1, out, t);
        }
        // Files that git knows are gone have no listing entry: show them greyed, without a click.
        const dirAbs = prefix ? `${this.root}/${prefix}` : this.root,
            listed = new Set((this.entries.get(prefix) ?? []).map((e) => e.name));
        for (const deleted of this.deleted ?? []) {
            if (out.length >= TOTAL) break;
            if (deleted.slice(0, deleted.lastIndexOf("/")) !== dirAbs) continue;
            const name = deleted.slice(deleted.lastIndexOf("/") + 1);
            if (!name || listed.has(name)) continue;
            out.push(
                h_flex()
                    .h(28)
                    .flex_none()
                    .pl(8 + depth * 18)
                    .pr(8)
                    .gap(7)
                    .items_center()
                    .rounded(7)
                    .text_color(t.dim)
                    .tooltip(`${deleted} — deleted, not on disk`)
                    .child(div().w(12).flex_none())
                    .child(svg(ICON("file-text")).size(14).flex_none().text_color(t.dim))
                    .child(div().flex_1().min_w(0).truncate().child(name))
                    .child(div().text_size(11).text_color(t.ansi1).child("D")),
            );
        }
        return out;
    }

    matchRows(t) {
        const rows = [];
        for (const rel of this.matches ?? []) {
            const name = rel.slice(rel.lastIndexOf("/") + 1),
                dir = rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
            rows.push(
                h_flex()
                    .id(`file-match-${rel}`)
                    .h(28)
                    .flex_none()
                    .px(8)
                    .gap(7)
                    .items_center()
                    .rounded(7)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .tooltip(`${this.root}/${rel}`)
                    .on_click(() => this.open(rel))
                    .child(div().w(12).flex_none())
                    .child(svg(ICON("file-text")).size(14).flex_none().text_color(t.muted))
                    .child(div().flex_1().min_w(0).truncate().child(name))
                    .child(div().min_w(0).max_w(180).truncate().text_size(11).text_color(t.dim).child(dir)),
            );
        }
        if (rows.length === 0)
            rows.push(
                div()
                    .p(8)
                    .text_size(12)
                    .text_color(t.dim)
                    .child(this.filterLoading ? "Searching…" : "No file matches."),
            );
        return rows;
    }

    render(_cx) {
        this.lastRenderAt = Date.now();
        const t = theme();
        if (key() !== this.context?.key) this.refreshScheduler.trigger();
        return v_flex()
            .id("files")
            .size_full()
            .min_h(0)
            .rounded(10)
            .overflow_hidden()
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .text_color(t.foreground)
            .text_size(13)
            .on_size_change((size, cx) => {
                if (Math.round(size.width) === Math.round(this.width)) return;
                this.width = size.width;
                cx.notify();
            })
            .child(
                h_flex()
                    .h(42)
                    .flex_none()
                    .px(12)
                    .gap(7)
                    .items_center()
                    .border_b(1)
                    .border_color(t.border)
                    .child(
                        div()
                            .flex_1()
                            .min_w(0)
                            .truncate()
                            .font_semibold()
                            .tooltip(this.root ?? "No folder")
                            .child(this.root?.split(/[\\/]/).pop() ?? "Files"),
                    )
                    .child(
                        iconButton(
                            t,
                            "files-refresh",
                            OWN("refresh"),
                            this.refreshState.busy ? "Reading the files…" : "Read the folder again",
                            (cx) => this.refresh(cx, true),
                            this.refreshState.busy,
                        ),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .p(8)
                    .pb(4)
                    .child(
                        div()
                            .id("files-filter")
                            .h(30)
                            .px(10)
                            .flex()
                            .items_center()
                            .rounded(8)
                            .border_1()
                            .border_color(t.border)
                            .cursor_text()
                            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                            .child(Input.new(this.input).h_full().w_full().text_size(12).text_color(t.foreground)),
                    ),
            )
            .child(
                v_flex()
                    .id("files-tree")
                    .flex_1()
                    .min_h(0)
                    .overflow_y_scrollbar()
                    .p(6)
                    .when(this.filter.trim() !== "", (el) => el.children(this.matchRows(t)))
                    .when(this.filter.trim() === "", (el) =>
                        el
                            .children(this.rows("", 0, [], t))
                            .when(Boolean(this.error) || !this.entries.get("")?.length, (x) =>
                                x.child(
                                    div()
                                        .p(8)
                                        .text_size(12)
                                        .text_color(t.dim)
                                        .child(
                                            this.error ||
                                                (!this.loaded && this.loading
                                                    ? "Reading files…"
                                                    : !this.root
                                                      ? "No folder"
                                                      : "No files"),
                                        ),
                                ),
                            ),
                    )
                    .when(this.limited, (el) =>
                        el.child(
                            div()
                                .p(8)
                                .text_size(11)
                                .text_color(t.dim)
                                .child("File list limited to 500 entries per folder and 5,000 total"),
                        ),
                    ),
            );
    }
}
