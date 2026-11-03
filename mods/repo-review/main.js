// A full-size review tab for one repo: its changed files on the left, the selected file's diff
// on the right. repo-changes opens it (tab.new, or setShared("repo-review.open") on a tab that
// already shows the repo). The diff's header can stage or unstage the shown file, and discard it after
// an inline confirm (lib.js); nothing else is written, and nothing is committed or fetched here.
// The file list's width is a draggable divider, remembered in the mod's localStorage. Code is copied by clicking a line
// (shift-click extends, Escape clears) and pressing Ctrl+C or "Copy N lines"; "Copy file" and "Copy path" are in the header.
// Two modes: "working" (uncommitted changes, `git diff HEAD`) and "branch" (the branch against its base branch,
// `git diff <merge base>`: committed work plus uncommitted). Branch mode is read-only. A switch in the sidebar
// changes between them when both have something to show.
//
// props: { on, repo: "<absolute repo path>", name: "<repo name>", file?: "<path to select first>",
//          mode?: "working" | "branch" (default working) }

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, h_resizable, resizable_panel } from "gpui-base";
import { spaces, panes, exec, readTextFile, theme, settings, shared, props as modProps } from "herdr";
import {
    parseStatus,
    splitPath,
    diffRows,
    stageFile,
    unstageFile,
    discardFile,
    discardKind,
    openMode,
    effectiveMode,
    canWrite,
    findBase,
    parseNameStatus,
    branchFiles,
    selectLine,
    inSelection,
    selectionCopy,
} from "./lib.js";

const EVERY = 5000; // re-list the files this often while the tab is shown
const BASE_EVERY = 60000; // find the base branch again this often even when HEAD stays (origin may have been fetched)
const SIDE_DEFAULT = 280; // the file list's width until the user drags it
const SIDE_MIN = 160;
const SIDE_MAX = 720;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// Reads write nothing under .git (same flags as repo-changes).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// The file list's width, remembered in the mod's own storage (every Review tab shares it, and a restart keeps it).
function readSideWidth() {
    try {
        const n = Number(localStorage.getItem("sideWidth"));
        return n >= SIDE_MIN && n <= SIDE_MAX ? n : SIDE_DEFAULT;
    } catch {
        return SIDE_DEFAULT;
    }
}

function saveSideWidth(n) {
    try {
        localStorage.setItem("sideWidth", String(Math.round(n)));
    } catch {
        // storage full or unavailable: the width resets next time
    }
}

export default class RepoReview extends View {
    init(_props, cx) {
        const props = modProps() ?? {}; // what tab.new gave this copy; none under herdr-app check
        this.repo = props.repo ?? "";
        this.name = props.name ?? (this.repo.split("/").pop() || "Review");
        this.on = props.on ?? null;
        this.branch = "?";
        this.ahead = 0;
        this.behind = 0;
        this.unborn = false;
        this.files = []; // the list shown: the working one or the branch one, by this.view
        this.total = 0;
        this.mode = openMode(props); // the mode asked for (by the click that opened the tab, or the switch)
        this.view = this.mode; // the mode drawn: this.mode, unless it has nothing to show
        this.workFiles = [];
        this.workTotal = 0;
        this.branchList = [];
        this.base = null; // { ref, name, mergeBase, count, commits, more } while the branch is ahead of its base
        this.sel = null;
        this.want = props.file ?? null; // want: a file to select as soon as the list has it
        this.rows = [];
        this.diffWidth = 0;
        this.sig = "";
        this.listId = 0;
        this.seq = 0;
        this.error = null;
        this.loaded = false;
        this.loading = false;
        this.last = 0;
        this.handled = Number(shared("repo-review.open")?.at ?? 0); // older requests are not for us
        this.confirming = null; // the file whose Discard waits for its second click
        this.acting = false;
        this.note = null; // { ok, message } of the last action
        this.sideWidth = readSideWidth();
        this.range = null; // the selected diff lines: { anchor, end } (lib.js), or null
        this.shift = false; // is Shift held? (a row click does not report it, so the root and the list track it)
        this.handle = cx.focus_handle(); // so arrow keys reach this tab
        cx.timer.every(500, (cx) => this.tick(cx));
        this.refresh(cx);
    }

    // Cheap check twice a second: a new "open this file" request, and the 5 s re-list while shown.
    // Not from render: both notify, and render may not.
    tick(cx) {
        const open = shared("repo-review.open");
        if (open && open.repo === this.repo && open.at > this.handled) {
            this.handled = open.at;
            this.want = open.file ?? null;
            const mode = openMode(open);
            if (mode !== this.mode) {
                this.mode = mode; // an older request has no mode: working changes
                this.applyMode();
                this.resetSelection();
            }
            if (open.file && this.files.some((f) => f.path === open.file)) this.pick(open.file, cx);
            else if (open.file)
                this.last = 0; // maybe a new file: re-list now
            else this.switchTo(this.mode, cx);
        }
        if (this.shown() && Date.now() - this.last >= EVERY) this.refresh(cx);
    }

    // Is a review tab the one on screen? (Several copies live at once, one per tab; a hidden one stays quiet.)
    shown() {
        const tab = spaces()
            .find((s) => s.active)
            ?.tabs.find((t) => t.active);
        return Boolean(tab) && panes().some((p) => p.tab === tab.id && p.mod === "repo-review");
    }

    refresh(cx) {
        if (!this.repo) return;
        if (this.loading) {
            this.again = true; // an action changed the files during this read: read again right after
            return;
        }
        this.loading = true;
        cx.spawn(async (cx) => {
            try {
                const r = await exec(
                    "git",
                    [...READ, "-c", "core.quotePath=false", "status", "--porcelain=v1", "-b", "--no-renames"],
                    { cwd: this.repo, on: this.on },
                );
                if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().split("\n")[0]);
                const s = parseStatus(r.stdout);
                // The base costs a dozen git calls: find it again only when HEAD moves, or after a minute (a fetch).
                const head = s.unborn
                    ? null
                    : await exec("git", [...READ, "rev-parse", "HEAD"], { cwd: this.repo, on: this.on });
                const key = head?.code === 0 ? head.stdout.trim() : null;
                if (!key) this.baseFor = null;
                else if (key !== this.baseFor?.key || Date.now() - this.baseFor.at >= BASE_EVERY)
                    this.baseFor = { key, at: Date.now(), base: await findBase(this.git(), this.repo) };
                const base = this.baseFor?.base ?? null;
                let committed = [];
                if (base) {
                    const d = await exec(
                        "git",
                        [
                            ...READ,
                            "-c",
                            "core.quotePath=false",
                            "diff",
                            "--name-status",
                            "--no-renames",
                            base.mergeBase,
                        ],
                        { cwd: this.repo, on: this.on },
                    );
                    if (d.code === 0) committed = parseNameStatus(d.stdout);
                }
                Object.assign(this, {
                    branch: s.branch,
                    ahead: s.ahead,
                    behind: s.behind,
                    unborn: s.unborn,
                    workFiles: s.files,
                    workTotal: s.total,
                    base,
                    branchList: base ? branchFiles(committed, s.files) : [],
                });
                this.applyMode();
                this.error = null;
                this.loaded = true;
                this.fixSelection();
                await this.loadDiff();
            } catch (e) {
                this.error = String(e?.message ?? e).split("\n")[0];
            } finally {
                this.loading = false;
                this.last = this.again ? 0 : Date.now();
                this.again = false;
                cx.notify();
            }
        });
        cx.notify();
    }

    /** Herdr's exec on the tab's machine, as lib.js takes it. */
    git() {
        return (cmd, args, options) => exec(cmd, args, { ...options, on: this.on });
    }

    // Which list to draw: the asked-for mode if it has anything, else the other.
    applyMode() {
        this.view = effectiveMode(this.mode, this.workFiles.length > 0, Boolean(this.base));
        const branch = this.view === "branch";
        this.files = branch ? this.branchList : this.workFiles;
        this.total = branch ? this.branchList.length : this.workTotal;
    }

    resetSelection() {
        this.range = null;
        this.confirming = null;
        this.note = null;
        this.sel = null;
        this.fixSelection();
        this.rows = [];
        this.sig = "";
        this.listId += 1;
    }

    /** The switch in the sidebar (or a request for the other mode): draw that list, first file selected. */
    switchTo(mode, cx) {
        this.mode = mode;
        this.applyMode();
        this.resetSelection();
        cx.spawn(async (cx) => {
            await this.loadDiff();
            cx.notify();
        });
        cx.notify();
    }

    // After a listing: select the wanted file, else keep the current one, else the first (or none).
    fixSelection() {
        if (this.want && this.files.some((f) => f.path === this.want)) {
            this.sel = this.want;
            this.want = null;
            return;
        }
        if (this.files.some((f) => f.path === this.sel)) return;
        this.sel = this.files[0]?.path ?? null;
    }

    // The diff as the shipped changes mod gets it: a new file is shown whole, the rest from `git diff HEAD`.
    async diffLines(file) {
        if (!(file.fresh || this.unborn)) {
            const from = this.view === "branch" && this.base ? this.base.mergeBase : "HEAD";
            const r = await exec(
                "git",
                [...READ, "diff", from, "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path],
                { cwd: this.repo, on: this.on },
            );
            if (r.code !== 0) throw new Error(r.stderr);
            const all = r.stdout.replace(/\n$/, "").split("\n"),
                first = all.findIndex((l) => l.startsWith("@@"));
            return first < 0 ? ["No text diff available"] : all.slice(first);
        }
        if (file.path.endsWith("/")) return ["Untracked folder · open a terminal there to see its files"];
        const text = await readTextFile(`${this.repo}/${file.path}`, {
            on: this.on,
        }).catch(() => null);
        if (text === null) return ["Cannot preview this file (binary, too large, or unreadable)"];
        if (text.includes("\0")) return ["Binary file · no text diff"];
        const all = text.slice(0, 400000).replace(/\n$/, "").split("\n");
        return [`@@ -0,0 +1,${all.length} @@`, ...all.slice(0, 1500).map((l) => `+${l}`)];
    }

    // Loads the selected file's diff. A newer call makes an older one stale (this.seq), and an
    // unchanged diff is left alone, so the 5 s re-list does not redraw or reset the scroll.
    async loadDiff() {
        const seq = ++this.seq,
            file = this.files.find((f) => f.path === this.sel);
        if (!file) {
            this.rows = [];
            this.sig = "";
            return;
        }
        let lines;
        try {
            lines = await this.diffLines(file);
        } catch (e) {
            lines = [`Cannot preview this diff: ${String(e?.message ?? e).split("\n")[0]}`];
        }
        if (seq !== this.seq) return;
        const sig = `${file.path}\n${lines.join("\n")}`;
        if (sig === this.sig) return;
        this.sig = sig;
        this.range = null; // the rows are new: a selection would point at other lines
        const cut = lines.slice(0, 1500).map((l) => (l.length > 4000 ? `${l.slice(0, 4000)}… (line truncated)` : l));
        this.rows = diffRows(cut);
        this.diffWidth = Math.max(300, ...cut.map((l) => l.length * 7.5 + 60));
    }

    /** Stage, unstage or discard the shown file (lib.js), then list the files again at once. */
    act(cx, fn) {
        if (this.acting) return;
        this.acting = true;
        this.confirming = null;
        const on = this.on;
        const git = (cmd, args, options) => exec(cmd, args, { ...options, on });
        cx.spawn(async (cx) => {
            try {
                this.note = await fn(git);
            } catch (e) {
                this.note = {
                    ok: false,
                    message: String(e?.message ?? e).split("\n")[0],
                };
            }
            this.acting = false;
            this.last = 0;
            this.refresh(cx);
        });
        cx.notify();
    }

    /** Stage / Unstage and Discard for the shown file, or the discard confirm in their place. */
    fileActions(t, file) {
        if (!canWrite(this.view)) return [];
        const args = { checkout: this.repo, file: file.path };
        const kind = discardKind(file.xy);
        if (this.confirming === file.path)
            return [
                div()
                    .flex_none()
                    .text_size(11.5)
                    .text_color(kind === "delete" ? t.blocked : t.muted)
                    .child(kind === "delete" ? "Not in the last commit: DELETE the file?" : "Discard every change?"),
                this.textButton(t, "review-discard-no", "Cancel", false, (_e, cx) => {
                    this.confirming = null;
                    cx.notify();
                }),
                this.textButton(
                    t,
                    "review-discard-yes",
                    kind === "delete" ? "Delete file" : "Discard",
                    true,
                    (_e, cx) => this.act(cx, (git) => discardFile(git, { ...args, expect: kind })),
                ),
            ];
        return [
            this.textButton(t, "review-stage", file.staged ? "Unstage" : "Stage", false, (_e, cx) =>
                this.act(cx, (git) => (file.staged ? unstageFile(git, args) : stageFile(git, args))),
            ),
            file.path.endsWith("/")
                ? null
                : this.textButton(t, "review-discard", "Discard…", false, (_e, cx) => {
                      this.confirming = file.path;
                      cx.notify();
                  }),
        ].filter(Boolean);
    }

    textButton(t, id, label, danger, onClick, plain = false) {
        return div()
            .id(id)
            .flex_none()
            .h(22)
            .px(8)
            .flex()
            .items_center()
            .rounded(6)
            .text_size(11.5)
            .cursor_pointer()
            .bg(danger ? t.blocked : t.raised)
            .text_color(danger ? t.background : t.foreground)
            .hover((s) => s.opacity(0.85))
            .on_click(onClick)
            .child(this.acting && !plain ? "…" : label);
    }

    pick(path, cx) {
        this.range = null;
        this.confirming = null;
        this.note = null;
        this.sel = path;
        this.want = null;
        this.rows = [];
        this.sig = "";
        this.listId += 1; // a new list id starts the diff at the top
        cx.spawn(async (cx) => {
            await this.loadDiff();
            cx.notify();
        });
        cx.notify();
    }

    // Previous / next file (keys and the header buttons).
    step(by, cx) {
        const i = this.files.findIndex((f) => f.path === this.sel),
            next = this.files[i + by];
        if (next) this.pick(next.path, cx);
    }

    /** A message under the header for two seconds ("Copied 3 lines"), or until another replaces it. */
    flash(cx, ok, message) {
        const note = { ok, message };
        this.note = note;
        cx.notify();
        cx.timer.after(2000, (cx) => {
            if (this.note !== note) return;
            this.note = null;
            cx.notify();
        });
    }

    /** Copies the selected lines (lib.js: the code only; the new side unless every selected line was deleted). */
    copyLines(cx) {
        const copy = selectionCopy(this.rows, this.range);
        if (!copy) return;
        cx.write_to_clipboard(copy.text);
        this.flash(cx, true, `Copied ${copy.lines} line${copy.lines === 1 ? "" : "s"}`);
    }

    /** The file's current text: the one on disk, or for a deleted file its last version (the base in branch mode). */
    copyFile(cx, file) {
        if (file.path.endsWith("/")) return this.flash(cx, false, "That is a folder; there is no file to copy.");
        cx.spawn(async (cx) => {
            try {
                let text;
                if (file.status === "D") {
                    const from = this.view === "branch" && this.base ? this.base.mergeBase : "HEAD";
                    const r = await exec("git", [...READ, "show", `${from}:${file.path}`], {
                        cwd: this.repo,
                        on: this.on,
                    });
                    if (r.code !== 0) throw new Error(r.stderr);
                    text = r.stdout;
                } else text = await readTextFile(`${this.repo}/${file.path}`, { on: this.on });
                cx.write_to_clipboard(text);
                this.flash(cx, true, `Copied ${file.path}`);
            } catch {
                this.flash(cx, false, "Cannot copy this file (binary, too large, or unreadable)");
            }
        });
    }

    key(e, cx) {
        if (e.keystroke === "ctrl-c" || e.keystroke === "cmd-c") {
            if (!selectionCopy(this.rows, this.range)) return;
            cx.stop_propagation();
            return this.copyLines(cx);
        }
        if (e.keystroke === "escape" && this.range) {
            cx.stop_propagation();
            this.range = null;
            return cx.notify();
        }
        const down = e.keystroke === "down" || e.keystroke === "j",
            up = e.keystroke === "up" || e.keystroke === "k";
        if (!down && !up) return;
        cx.stop_propagation();
        this.step(down ? 1 : -1, cx);
    }

    fileRow(t, f) {
        const { dir, name } = splitPath(f.path),
            on = f.path === this.sel;
        const color =
            f.status === "A" || f.status === "??"
                ? t.ansi2
                : f.status === "D" || f.status === "U"
                  ? t.ansi1
                  : f.status === "R"
                    ? t.ansi5
                    : t.blocked;
        return h_flex()
            .id(`file-${f.path}`)
            .h(26)
            .flex_none()
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .when(on, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
                this.handle.focus();
                this.pick(f.path, cx);
            })
            .child(div().w(18).flex_none().text_size(11).text_color(color).child(f.status))
            .child(
                h_flex()
                    .flex_1()
                    .min_w(0)
                    .text_size(12.5)
                    .child(div().min_w(0).truncate().text_color(t.dim).child(dir))
                    .child(
                        div()
                            .flex_none()
                            .max_w(200)
                            .truncate()
                            .text_color(on ? t.foreground : t.muted)
                            .child(name),
                    ),
            );
    }

    // "Working changes" and "Branch vs <base>", side by side, when both have something to show. The shown one is filled.
    modeSwitch(t) {
        if (!this.base || !this.workFiles.length) return [];
        const seg = (id, label, mode) =>
            div()
                .id(id)
                .flex_1()
                .min_w(0)
                .h(24)
                .px(6)
                .flex()
                .items_center()
                .justify_center()
                .rounded(6)
                .truncate()
                .text_size(11.5)
                .cursor_pointer()
                .when(this.view === mode, (el) => el.bg(t.selected).text_color(t.foreground).font_semibold())
                .when(this.view !== mode, (el) =>
                    el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)),
                )
                .on_click((_e, cx) => this.switchTo(mode, cx))
                .child(label);
        return [
            h_flex()
                .flex_none()
                .p(6)
                .gap(4)
                .border_b(1)
                .border_color(t.border)
                .child(seg("review-mode-working", "Working changes", "working"))
                .child(seg("review-mode-branch", `Branch vs ${this.base.name}`, "branch")),
        ];
    }

    // Branch mode: "<branch> vs <base> · N commits", then the commits (short, newest first).
    branchHeader(t) {
        if (this.view !== "branch" || !this.base) return [];
        const { name, count, commits, more } = this.base;
        return [
            v_flex()
                .flex_none()
                .px(12)
                .py(6)
                .gap(2)
                .border_b(1)
                .border_color(t.border)
                .text_size(11)
                .child(
                    div()
                        .truncate()
                        .text_color(t.foreground)
                        .child(`${this.branch} vs ${name} · ${count} commit${count === 1 ? "" : "s"} · read-only`),
                )
                .children(commits.map((c) => div().truncate().text_color(t.muted).child(c)))
                .when(more > 0, (el) => el.child(div().text_color(t.dim).child(`+${more} older`))),
        ];
    }

    // Left column: repo name + Refresh, branch + file count, then the changed files.
    sidebar(t) {
        const more = this.total - this.files.length;
        return v_flex()
            .size_full()
            .border_r(1)
            .border_color(t.border)
            .child(
                h_flex()
                    .h(32)
                    .flex_none()
                    .px(12)
                    .gap(8)
                    .items_center()
                    .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.name))
                    .child(
                        div()
                            .id("review-refresh")
                            .flex_none()
                            .text_size(11)
                            .text_color(t.dim)
                            .cursor_pointer()
                            .hover((s) => s.text_color(t.foreground))
                            .on_click((_e, cx) => this.refresh(cx))
                            .child(this.loading ? "Loading…" : "Refresh"),
                    ),
            )
            .child(
                h_flex()
                    .h(22)
                    .flex_none()
                    .px(12)
                    .gap(8)
                    .items_center()
                    .text_size(11)
                    .text_color(t.muted)
                    .border_b(1)
                    .border_color(t.border)
                    .child(svg(ICON("branch")).size(11).flex_none())
                    .child(div().min_w(0).truncate().child(this.branch))
                    .when(this.ahead > 0, (el) =>
                        el.child(div().flex_none().text_color(t.foreground).child(`↑${this.ahead}`)),
                    )
                    .when(this.behind > 0, (el) =>
                        el.child(div().flex_none().text_color(t.blocked).child(`↓${this.behind}`)),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .flex_none()
                            .child(`${this.total} file${this.total === 1 ? "" : "s"}`),
                    ),
            )
            .children(this.modeSwitch(t))
            .children(this.branchHeader(t))
            .when(Boolean(this.error), (el) =>
                el.child(
                    div().flex_none().px(12).py(3).truncate().text_size(11).text_color(t.blocked).child(this.error),
                ),
            )
            .child(
                v_flex()
                    .id("review-files")
                    .flex_1()
                    .min_h(0)
                    .p(6)
                    .overflow_y_scrollbar()
                    .when(this.loaded && !this.files.length, (el) =>
                        el.child(div().p(8).text_color(t.dim).child("No changes")),
                    )
                    .when(!this.loaded && !this.error, (el) => el.child(div().p(8).text_color(t.dim).child("Loading…")))
                    .children(this.files.map((f) => this.fileRow(t, f)))
                    .when(more > 0, (el) =>
                        el.child(
                            div()
                                .px(8)
                                .py(3)
                                .text_size(11)
                                .text_color(t.dim)
                                .child(`+${more} more (first ${this.files.length} shown)`),
                        ),
                    ),
            );
    }

    // Added / removed rows: a tint behind the row, a full-strength bar at the left edge, and the line
    // number and marker in the same full-strength color. Text stays foreground so it reads over the tint.
    // (Colors take #rrggbbaa; the fallbacks are the dark theme's ansi1 / ansi2 in case a theme lacks them.)
    diffRow(t, { kind, number, text }, selected) {
        if (kind === "@")
            return div()
                .w_full()
                .px(12)
                .h(20)
                .flex_none()
                .truncate()
                .bg(t.surface)
                .text_color(t.ansi6 ?? "#6BD6E0")
                .child(text);
        const add = kind === "+",
            del = kind === "-",
            changed = add || del;
        const strong = add ? (t.ansi2 ?? "#C4F36B") : (t.ansi1 ?? "#FF8095");
        const tint = add ? `${t.ansi2 ?? "#C4F36B"}2A` : `${t.ansi1 ?? "#FF8095"}38`;
        return (
            h_flex()
                .w_full()
                .h(20)
                .flex_none()
                .items_center()
                .when(changed, (e) => e.bg(tint))
                // Selected lines in blue, so a selection never reads as an added (lime) or deleted (red) line.
                .when(selected, (e) => e.bg(`${t.ansi4 ?? "#6BA8FF"}55`))
                .child(
                    div()
                        .w(3)
                        .h_full()
                        .flex_none()
                        .when(changed, (e) => e.bg(strong))
                        .when(selected, (e) => e.bg(t.ansi4 ?? "#6BA8FF")),
                )
                .child(
                    div()
                        .w(44)
                        .flex_none()
                        .px(4)
                        .text_right()
                        .text_color(changed ? strong : t.dim)
                        .child(number === undefined ? "" : String(number)),
                )
                .child(
                    div()
                        .w(16)
                        .flex_none()
                        .text_center()
                        .text_color(strong)
                        .child(add ? "+" : del ? "−" : ""),
                )
                .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(text))
        );
    }

    // A small header button; disabled looks dim and does nothing.
    headerButton(t, id, label, enabled, onClick) {
        return div()
            .id(id)
            .flex_none()
            .w(22)
            .h(22)
            .flex()
            .items_center()
            .justify_center()
            .rounded(5)
            .text_color(enabled ? t.muted : t.dim)
            .when(enabled, (el) =>
                el
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(onClick),
            )
            .child(label);
    }

    // Right side: a 32 px header (path, +added −removed, prev/next), then the diff at full size.
    diffPanel(t) {
        const file = this.files.find((f) => f.path === this.sel);
        if (!file)
            return v_flex()
                .size_full()
                .min_w(0)
                .items_center()
                .justify_center()
                .text_color(t.dim)
                .child(this.loaded ? "No changes" : "Loading…");
        const add = this.rows.filter((r) => r.kind === "+").length,
            del = this.rows.filter((r) => r.kind === "-").length;
        const { dir, name } = splitPath(file.path),
            i = this.files.indexOf(file),
            list = `review-diff-${this.listId}`;
        const copy = selectionCopy(this.rows, this.range);
        return v_flex()
            .size_full()
            .min_w(0)
            .child(
                h_flex()
                    .h(32)
                    .flex_none()
                    .px(12)
                    .gap(10)
                    .items_center()
                    .border_b(1)
                    .border_color(t.border)
                    .text_size(12)
                    .child(
                        h_flex()
                            .flex_1()
                            .min_w(0)
                            .child(div().min_w(0).truncate().text_color(t.dim).child(dir))
                            .child(div().flex_none().font_semibold().child(name)),
                    )
                    .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`))
                    .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`))
                    .when(Boolean(copy), (el) =>
                        el.child(
                            this.textButton(
                                t,
                                "review-copy-lines",
                                `Copy ${copy.lines} line${copy.lines === 1 ? "" : "s"}`,
                                false,
                                (_e, cx) => this.copyLines(cx),
                                true,
                            ),
                        ),
                    )
                    .child(
                        this.textButton(
                            t,
                            "review-copy-file",
                            "Copy file",
                            false,
                            (_e, cx) => this.copyFile(cx, file),
                            true,
                        ),
                    )
                    .child(
                        this.textButton(
                            t,
                            "review-copy-path",
                            "Copy path",
                            false,
                            (_e, cx) => {
                                cx.write_to_clipboard(file.path);
                                this.flash(cx, true, `Copied ${file.path}`);
                            },
                            true,
                        ),
                    )
                    .children(this.fileActions(t, file))
                    .child(this.headerButton(t, "review-prev", "‹", i > 0, (_e, cx) => this.step(-1, cx)))
                    .child(
                        this.headerButton(t, "review-next", "›", i < this.files.length - 1, (_e, cx) =>
                            this.step(1, cx),
                        ),
                    ),
            )
            .when(Boolean(this.note), (el) =>
                el.child(
                    div()
                        .flex_none()
                        .px(12)
                        .py(3)
                        .truncate()
                        .text_size(11)
                        .text_color(this.note.ok ? t.done : t.blocked)
                        .child(this.note.message),
                ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(0)
                    .relative()
                    .font_family(settings().font_family ?? "JetBrains Mono")
                    .text_size(12)
                    .child(
                        div()
                            .id(`review-x-${this.listId}`)
                            .size_full()
                            .overflow_x_scrollbar()
                            .child(
                                div()
                                    .w_full()
                                    .min_w(this.diffWidth)
                                    .h_full()
                                    .child(
                                        v_virtual_list(
                                            list,
                                            this.rows.length,
                                            20,
                                            (n) => String(n),
                                            (range) =>
                                                this.rows
                                                    .slice(range.start, range.end)
                                                    .map((row, i) =>
                                                        this.diffRow(t, row, inSelection(this.range, range.start + i)),
                                                    ),
                                        )
                                            .on_item_click((key, cx) => {
                                                this.range = selectLine(this.rows, this.range, Number(key), this.shift);
                                                cx.notify();
                                            })
                                            .size_full(),
                                    ),
                            ),
                    )
                    .child(Scrollbar.vertical(list).viewport_from_layout().absolute().inset_0()),
            );
    }

    render(_cx) {
        const t = theme();
        return h_flex()
            .id("repo-review")
            .size_full()
            .min_h(0)
            .overflow_hidden()
            .bg(t.background)
            .text_color(t.foreground)
            .text_size(13)
            .track_focus(this.handle)
            .on_key_down((e, cx) => this.key(e, cx))
            .on_modifiers_changed((e) => {
                this.shift = e.modifiers.shift;
            })
            .on_mouse_down("left", (e) => {
                this.shift = e.modifiers.shift;
                this.handle.focus();
            })
            .child(
                h_resizable("review-split")
                    .size_full()
                    .on_resize((sizes) => {
                        this.sideWidth = sizes[0];
                        saveSideWidth(sizes[0]);
                    })
                    .child(resizable_panel().size(this.sideWidth).size_range(SIDE_MIN, SIDE_MAX).child(this.sidebar(t)))
                    .child(resizable_panel().child(this.diffPanel(t))),
            );
    }
}
