// A full-size review tab for one repo: its changed files on the left, the selected file's diff
// on the right. repo-changes opens it (tab.new, or setShared("repo-review.open") on a tab that
// already shows the repo). The diff's header can stage or unstage the shown file, and discard it after
// an inline confirm (lib.js); nothing else is written, and nothing is committed or fetched here.
//
// props: { on, repo: "<absolute repo path>", name: "<repo name>", file?: "<path to select first>" }

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, exec, readTextFile, theme, settings, shared, props as modProps } from "herdr";
import { parseStatus, splitPath, diffRows, stageFile, unstageFile, discardFile, discardKind } from "./lib.js";

const EVERY = 5000; // re-list the files this often while the tab is shown
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// Reads write nothing under .git (same flags as repo-changes).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

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
        this.files = [];
        this.total = 0;
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
            this.want = open.file;
            if (this.files.some((f) => f.path === open.file)) this.pick(open.file, cx);
            else this.last = 0; // maybe a new file: re-list now
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
                Object.assign(this, {
                    branch: s.branch,
                    ahead: s.ahead,
                    behind: s.behind,
                    unborn: s.unborn,
                    files: s.files,
                    total: s.total,
                });
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
            const r = await exec(
                "git",
                [...READ, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path],
                { cwd: this.repo, on: this.on },
            );
            if (r.code !== 0) throw new Error(r.stderr);
            const all = r.stdout.replace(/\n$/, "").split("\n"),
                first = all.findIndex((l) => l.startsWith("@@"));
            return first < 0 ? ["No text diff available"] : all.slice(first);
        }
        if (file.path.endsWith("/")) return ["Untracked folder · open a terminal there to see its files"];
        const text = await readTextFile(`${this.repo}/${file.path}`, { on: this.on }).catch(() => null);
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
                this.note = { ok: false, message: String(e?.message ?? e).split("\n")[0] };
            }
            this.acting = false;
            this.last = 0;
            this.refresh(cx);
        });
        cx.notify();
    }

    /** Stage / Unstage and Discard for the shown file, or the discard confirm in their place. */
    fileActions(t, file) {
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

    textButton(t, id, label, danger, onClick) {
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
            .child(this.acting ? "…" : label);
    }

    pick(path, cx) {
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

    key(e, cx) {
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

    // Left column: repo name + Refresh, branch + file count, then the changed files.
    sidebar(t) {
        const more = this.total - this.files.length;
        return v_flex()
            .w(280)
            .flex_none()
            .h_full()
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
    diffRow(t, { kind, number, text }) {
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
        return h_flex()
            .w_full()
            .h(20)
            .flex_none()
            .items_center()
            .when(changed, (e) => e.bg(tint))
            .child(
                div()
                    .w(3)
                    .h_full()
                    .flex_none()
                    .when(changed, (e) => e.bg(strong)),
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
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(text));
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
                .flex_1()
                .min_w(0)
                .h_full()
                .items_center()
                .justify_center()
                .text_color(t.dim)
                .child(this.loaded ? "No changes" : "Loading…");
        const add = this.rows.filter((r) => r.kind === "+").length,
            del = this.rows.filter((r) => r.kind === "-").length;
        const { dir, name } = splitPath(file.path),
            i = this.files.indexOf(file),
            list = `review-diff-${this.listId}`;
        return v_flex()
            .flex_1()
            .min_w(0)
            .h_full()
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
                                                    .map((row) => this.diffRow(t, row)),
                                        ).size_full(),
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
            .on_mouse_down("left", () => this.handle.focus())
            .child(this.sidebar(t))
            .child(this.diffPanel(t));
    }
}
