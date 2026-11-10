// A full-size review tab for one repo: its changed files on the left, the selected file's diff
// on the right. Comment cards and the send-to-agent flow adapt vytasgavelis/herdr-reviewer (MIT) and
// jakub-tucek/herdr-annotator (MIT); see NOTICE. We wait for an idle agent and never pass --force. jig-git opens it (tab.new, or setShared("jig-review.open") on a tab that
// already shows the repo). The diff's header can stage or unstage the shown file, and discard it after
// an inline confirm (lib.js); nothing else is written, and nothing is committed or fetched here.
// The file list's width is a draggable divider, remembered in the mod's localStorage; below 640 px the list and the diff
// stack. Code is copied by clicking a line (shift-click extends, Escape clears) and pressing Ctrl+C or "Copy N lines";
// "Copy file" and "Copy path" are in the diff's own row.
// A switch in the diff header, Diff | File | Patch, picks what the right side shows: the tinted rows (click to select lines),
// the file's text, or the diff's text, the last two in a read-only code editor where the mouse drags a selection and Ctrl+C
// copies it. The choice is remembered in localStorage like the width.
// Two modes: "working" (uncommitted changes, `git diff HEAD`) and "branch" (the branch against its base branch,
// `git diff <merge base>`: committed work plus uncommitted). Branch mode is read-only. A switch in the sidebar
// changes between them when both have something to show.
//
// props: { on, repo: "<absolute repo path>", name: "<repo name>", file?: "<path to select first>",
//          mode?: "working" | "branch" (default working) }

import {
    Editor,
    EditorState,
    h_flex,
    h_resizable,
    resizable_panel,
    Scrollbar,
    Textarea,
    TextareaState,
    v_flex,
    v_virtual_list,
} from "gpui-base";
import { div, svg, View } from "gpui-kit";
import {
    agents,
    exec,
    focused,
    hc,
    props as modProps,
    panes,
    readTextFile,
    run,
    settings,
    shared,
    spaces,
    terminals,
    theme,
} from "herdr";
import { location, readFollow, writeFollow } from "./follow.js";
import {
    addComment,
    branchFiles,
    buildReviewMessage,
    canWrite,
    capText,
    chooseRepo,
    commentsInFile,
    commentsKey,
    contextKeyOf,
    diffRows,
    discardFile,
    discardKind,
    effectiveMode,
    findBase,
    inSelection,
    langFor,
    openMode,
    PANES,
    parseComments,
    parseNameStatus,
    parseRepoList,
    parseStatus,
    placeComment,
    placeComments,
    REPO_SCRIPT,
    removeComment,
    reviewLayout,
    reviewPane,
    selectionCopy,
    selectLine,
    splitPath,
    stageFile,
    unstageFile,
    viewForContext,
} from "./lib.js";
import { panelError, panelHeader } from "./panel-header.js";
import {
    chooserRow,
    contextCard,
    dangerButton,
    emptyLine,
    primaryButton,
    secondaryButton,
    sizes,
    skeleton,
    statusLine,
} from "./panel-kit.js";
import { friendlyError, GIT_READ, run as runCommand } from "./refresh.js";

const EVERY = 5000; // re-list the files this often while the tab is shown
const BASE_EVERY = 60000; // find the base branch again this often even when HEAD stays (origin may have been fetched)
const REPOS_EVERY = 5000; // how often the side panel looks for repositories under the folder
const SIDE_DEFAULT = 280; // the file list's width until the user drags it
const SIDE_MIN = 160;
const SIDE_MAX = 720;
const MAX = 400000; // most characters the File and Patch editors show; more is cut with a note
const PANE_LABEL = { diff: "Diff", file: "File", patch: "Patch" };
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// Reads write nothing under .git (same flags as jig-git).
const READ = [...GIT_READ, "-c", "diff.autoRefreshIndex=false"];

/** The folder to review and its machine: the shown space's folder, else its first terminal's. */
function whereToLook() {
    const space = spaces().find((s) => s.active);
    return location(readFollow(space?.id));
}

/** A repository path's name for the chooser. */
const repoName = (path) =>
    String(path ?? "")
        .split("/")
        .filter(Boolean)
        .pop() || "Repository";

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

// The chosen view (Diff, File or Patch), remembered like the width.
function readPane() {
    try {
        return reviewPane(localStorage.getItem("pane"));
    } catch {
        return "diff";
    }
}

function savePane(pane) {
    try {
        localStorage.setItem("pane", pane);
    } catch {
        // storage unavailable: the view resets next time
    }
}

export default class RepoReview extends View {
    init(_props, cx) {
        const props = modProps() ?? {}; // what tab.new gave this copy; none under herdr-app check
        this.fixed = Boolean(props.repo);
        this.where = this.fixed ? { root: props.repo, on: props.on ?? null } : whereToLook();
        this.repo = props.repo ?? "";
        this.name = props.name ?? (this.repo.split("/").pop() || "Review");
        this.on = this.fixed ? (props.on ?? null) : this.where.on;
        const spaceId = this.fixed ? null : spaces().find((s) => s.active)?.id;
        this.follow = this.fixed ? undefined : readFollow(spaceId);
        this.repos = null;
        this.reposAt = 0;
        this.loadingRepos = false;
        this.loadedContext = this.fixed ? JSON.stringify(["fixed", this.repo, this.on]) : null;
        this.contextKey = this.fixed ? this.loadedContext : contextKeyOf(this.where);
        this.contextAt = Date.now();
        this.repoError = null;
        this.picking = false;
        this.width = 0;
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
        this.handled = Number(shared("jig-review.open")?.at ?? 0); // older requests are not for us
        this.confirming = null; // the file whose Discard waits for its second click
        this.acting = false;
        this.note = null; // { ok, message } of the last action
        this.sideWidth = readSideWidth();
        this.range = null; // the selected diff lines: { anchor, end } (lib.js), or null
        this.comments = []; // { id, file, rowStart, rowEnd, startLine, endLine, quote, note, at }
        this.commentsAt = null;
        this.draft = null; // { rowStart, rowEnd, startLine, endLine, quote, note }
        this.commentInput = TextareaState.new({ placeholder: "Your note to the agent…", rows: 2 });
        this.commentInput.on("change", (_e, cx) => {
            if (this.draft) this.draft.note = this.commentInput.value();
            cx.notify();
        });
        this.sendTarget = null;
        this.waitingSend = false;
        this.sendError = null;
        this.shift = false; // is Shift held? (a row click does not report it, so the root and the list track it)
        this.pane = readPane(); // "diff" | "file" | "patch"
        this.editor = null; // { key, text, state } for File and Patch; state is released when replaced
        this.editorNote = null; // why there is no editor (binary, folder, unreadable)
        this.eseq = 0;
        this.patchText = "";
        this.handle = cx.focus_handle(); // so arrow keys reach this tab
        cx.timer.every(500, (cx) => this.tick(cx));
        this.syncComments();
        if (!this.fixed) this.loadRepos(cx, true);
        else this.refresh(cx);
    }

    // Cheap check twice a second: a new "open this file" request, and the 5 s re-list while shown.
    // Not from render: both notify, and render may not.
    tick(cx) {
        if (!this.fixed) {
            this.followTick(cx);
            if (this.contextKey !== this.loadedContext && Date.now() - (this.contextAt ?? 0) > 1000) {
                this.loadingRepos = false;
                this.loadRepos(cx, true);
            }
        }
        const open = shared("jig-review.open");
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
        if (this.waitingSend) {
            const agent = this.agentTarget();
            if (agent && agent.status !== "working" && agent.status !== "blocked") this.deliver(cx, agent);
            else if (!agent) {
                this.waitingSend = false;
                this.sendError = "The agent is gone; start one, then send.";
            }
        }
    }

    // Is a review tab the one on screen? (Several copies live at once, one per tab; a hidden one stays quiet.)
    shown() {
        const tab = spaces()
            .find((s) => s.active)
            ?.tabs.find((t) => t.active);
        return Boolean(tab) && panes().some((p) => p.tab === tab.id && p.mod === "jig-review");
    }

    /** The followed folder or machine changed, or its repositories need a fresh list. */
    followTick(cx) {
        const where = whereToLook();
        if (contextKeyOf(where) !== this.contextKey) {
            this.where = where;
            this.on = where.on;
            this.contextKey = contextKeyOf(where);
            this.contextAt = Date.now();
            this.loadedContext = null;
            this.refreshState?.cancel();
            this.readGeneration = (this.readGeneration ?? 0) + 1;
            this.loading = false;
            this.loadingRepos = false;
            this.loadedContext = null;
            this.repo = "";
            this.repos = null;
            this.reposAt = 0;
            try {
                localStorage.removeItem("jig-review.repo");
            } catch {
                // storage unavailable: the dirty/first repo is still a fine default
            }
            this.resetRepo();
            this.loadRepos(cx, true);
            return;
        }
        if (this.where?.root && Date.now() - this.reposAt >= REPOS_EVERY) this.loadRepos(cx);
    }

    /** The repository a fixed tab was opened for, or the first one under the followed folder. */
    loadRepos(cx, initial = false) {
        if (this.loadingRepos || !this.where?.root) return;
        this.loadingRepos = true;
        this.reposAt = Date.now();
        const context = this.contextKey;
        cx.spawn(async (cx) => {
            try {
                const found = await runCommand(exec, "sh", ["-c", REPO_SCRIPT, "sh", this.where.root], {
                    on: this.where.on,
                });
                if (context !== this.contextKey) return;
                if (found.code !== 0) throw new Error((found.stderr || `exit ${found.code}`).trim().split("\n")[0]);
                const { repos } = parseRepoList(found.stdout);
                this.repos = repos;
                this.loadedContext = context;
                this.reposAt = Date.now();
                this.repoError = null;
                let remembered = null;
                try {
                    remembered = localStorage.getItem("jig-review.repo");
                } catch {
                    // storage unavailable: the first repository is a fine default
                }
                const choice = initial ? chooseRepo(repos, "", null) : chooseRepo(repos, this.repo, remembered);
                if (choice !== this.repo) {
                    this.repo = choice ?? "";
                    this.name = repoName(this.repo);
                    this.resetRepo();
                    if (this.repo) this.refresh(cx);
                } else if (initial && this.repo) this.refresh(cx);
            } catch (e) {
                this.repoError = String(e?.message ?? e).split("\n")[0];
            } finally {
                this.loadingRepos = false;
                cx.notify();
            }
        });
    }

    /** A new repository: forget the old rows and diff, keep the view choice. */
    resetRepo() {
        this.readGeneration = (this.readGeneration ?? 0) + 1;
        this.loading = false;
        this.again = false;
        this.loaded = false;
        this.error = null;
        this.files = [];
        this.rows = [];
        this.sel = null;
        this.want = null;
        this.branch = "?";
        this.ahead = 0;
        this.behind = 0;
        this.unborn = false;
        this.total = 0;
        this.base = null;
        this.baseFor = null;
        this.patchText = "";
        this.editor = null;
        this.last = 0;
        this.comments = [];
        this.commentsAt = null;
        this.draft = null;
        this.name = this.fixed ? this.name : "Review";
        this.syncComments();
    }

    /** Follow the focused terminal, or use the space's folder; the same switch as History. */
    toggleFollow(cx) {
        const space = spaces().find((s) => s.active);
        this.follow = !this.follow;
        writeFollow(space?.id, this.follow);
        this.where = whereToLook();
        this.on = this.where.on;
        this.repo = "";
        this.repos = null;
        this.reposAt = 0;
        this.resetRepo();
        this.loadRepos(cx, true);
    }

    refresh(cx) {
        if (!this.repo) {
            this.loading = false;
            this.loaded = false;
            return;
        }
        if (this.loading) {
            this.again = true; // an action changed the files during this read: read again right after
            return;
        }
        this.loading = true;
        const run = ++this.readGeneration;
        const repo = this.repo;
        const context = this.contextKey;
        cx.spawn(async (cx) => {
            try {
                const r = await runCommand(
                    exec,
                    "git",
                    [...READ, "-c", "core.quotePath=false", "status", "--porcelain=v1", "-b", "--no-renames"],
                    { cwd: this.repo, on: this.on },
                );
                if (run !== this.readGeneration || repo !== this.repo || context !== this.contextKey) return;
                if (r.code !== 0) throw Object.assign(new Error(r.stderr || `exit ${r.code}`), r);
                const s = parseStatus(r.stdout);
                // The base costs a dozen git calls: find it again only when HEAD moves, or after a minute (a fetch).
                const head = s.unborn
                    ? null
                    : await runCommand(exec, "git", [...READ, "rev-parse", "HEAD"], { cwd: this.repo, on: this.on });
                const key = head?.code === 0 ? head.stdout.trim() : null;
                if (!key) this.baseFor = null;
                else if (key !== this.baseFor?.key || Date.now() - this.baseFor.at >= BASE_EVERY)
                    this.baseFor = { key, at: Date.now(), base: await findBase(this.git(), this.repo) };
                const base = this.baseFor?.base ?? null;
                let committed = [];
                if (base) {
                    const d = await runCommand(
                        exec,
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
                if (run !== this.readGeneration || repo !== this.repo || context !== this.contextKey) return;
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
                this.loadedContext = this.contextKey;
                this.syncComments();
                this.fixSelection();
                await this.loadDiff();
            } catch (e) {
                if (run === this.readGeneration && repo === this.repo && context === this.contextKey)
                    this.error = friendlyError(e, { what: "Reading" });
            } finally {
                if (run === this.readGeneration) {
                    this.loading = false;
                    this.last = this.again ? 0 : Date.now();
                    const again = this.again;
                    this.again = false;
                    if (again) this.refresh(cx);
                }
                cx.notify();
            }
        });
        cx.notify();
    }

    /** Herdr's exec on the tab's machine, as lib.js takes it. */
    git() {
        return (cmd, args, options) => runCommand(exec, cmd, args, { ...options, on: this.on });
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
        this.dropEditor();
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
            const r = await runCommand(
                exec,
                "git",
                [...READ, "diff", from, "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path],
                { cwd: this.repo, on: this.on },
            );
            if (r.code !== 0) throw Object.assign(new Error(r.stderr), r);
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
        await this.loadRows();
        await this.syncEditor();
    }

    async loadRows() {
        const seq = ++this.seq,
            file = this.files.find((f) => f.path === this.sel);
        if (!file) {
            this.rows = [];
            this.sig = "";
            this.patchText = "";
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
        this.patchText = cut.join("\n");
        this.diffWidth = Math.max(300, ...cut.map((l) => l.length * 7.5 + 60));
    }

    /** The file's current text: the one on disk, or for a deleted file its last version (the base in branch mode). */
    async fileText(file) {
        if (file.status === "D") {
            const from = this.view === "branch" && this.base ? this.base.mergeBase : "HEAD";
            const r = await runCommand(exec, "git", [...READ, "show", `${from}:${file.path}`], {
                cwd: this.repo,
                on: this.on,
            });
            if (r.code !== 0) throw Object.assign(new Error(r.stderr), r);
            return r.stdout;
        }
        return readTextFile(`${this.repo}/${file.path}`, { on: this.on });
    }

    /** Lets go of the editor (File and Patch) and cancels a read in flight. */
    dropEditor() {
        this.eseq += 1;
        this.editor?.state.release();
        this.editor = null;
        this.editorNote = null;
    }

    // Makes the File or Patch editor match the shown file: a state is made here (never in render) and replaced only when its
    // text changed, so the 5 s re-list keeps the scroll and the selection. Diff holds no editor.
    async syncEditor() {
        const file = this.files.find((f) => f.path === this.sel);
        if (this.pane === "diff" || !file) return this.dropEditor();
        const seq = ++this.eseq,
            pane = this.pane;
        let text,
            note = null;
        if (pane === "patch") text = this.patchText;
        else if (file.path.endsWith("/")) note = "That is a folder; there is no file to show.";
        else {
            try {
                text = await this.fileText(file);
            } catch {
                text = null;
            }
            if (text === null || text === undefined) note = "Cannot show this file (binary, too large, or unreadable)";
            else if (text.includes("\0")) note = "Binary file · no text to show";
        }
        if (seq !== this.eseq) return;
        if (note) {
            this.editor?.state.release();
            this.editor = null;
            this.editorNote = note;
            return;
        }
        const key = `${pane}|${file.path}`;
        if (this.editor?.key === key && this.editor.text === text) return;
        const t = theme();
        const state = EditorState.new({
            language: pane === "patch" ? "diff" : langFor(file.path),
            readonly: true,
            value: capText(text, MAX),
            font_family: settings().font_family,
            font_size: 13,
            syntax: {
                keyword: t.ansi5,
                string: t.ansi2,
                comment: t.dim,
                function: t.ansi4,
                type: t.ansi3,
                number: t.ansi1,
                constant: t.ansi6,
            },
        });
        this.editor?.state.release();
        this.editor = { key, text, state };
        this.editorNote = null;
    }

    /** The Diff | File | Patch switch. */
    setPane(pane, cx) {
        if (pane === this.pane) return;
        this.pane = pane;
        savePane(pane);
        this.dropEditor();
        if (pane !== "diff") this.handle.focus(); // arrow keys keep working until the editor is clicked
        cx.spawn(async (cx) => {
            await this.syncEditor();
            cx.notify();
        });
        cx.notify();
    }

    /** Stage, unstage or discard the shown file (lib.js), then list the files again at once. */
    act(cx, fn) {
        if (this.acting) return;
        this.acting = true;
        this.confirming = null;
        const on = this.on;
        const git = (cmd, args, options) => runCommand(exec, cmd, args, { ...options, on });
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

    textButton(t, id, label, danger, onClick, _plain = false) {
        return danger ? dangerButton(t, id, label, onClick) : secondaryButton(t, id, label, onClick);
    }

    pick(path, cx) {
        this.range = null;
        this.confirming = null;
        this.note = null;
        this.sel = path;
        this.want = null;
        this.dropEditor();
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
                const text = await this.fileText(file);
                cx.write_to_clipboard(text);
                this.flash(cx, true, `Copied ${file.path}`);
            } catch {
                this.flash(cx, false, "Cannot copy this file (binary, too large, or unreadable)");
            }
        });
    }

    key(e, cx) {
        this.shift = Boolean(e.modifiers?.shift);
        if (e.keystroke === "ctrl-c" || e.keystroke === "cmd-c") {
            if (this.pane !== "diff" || !selectionCopy(this.rows, this.range)) return;
            cx.stop_propagation();
            return this.copyLines(cx);
        }
        if (e.keystroke === "escape" && this.range && this.pane === "diff") {
            cx.stop_propagation();
            this.range = null;
            return cx.notify();
        }
        const down = e.keystroke === "down" || e.keystroke === "j",
            up = e.keystroke === "up" || e.keystroke === "k";
        if (!down && !up) return;
        if (this.editor && !this.handle.is_focused()) return; // the editor has the keyboard: its own keys
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

    header(t) {
        return panelHeader(t, {
            title: "Review",
            readAt: this.last,
            busy: this.loading,
            onRefresh: (cx) => this.refresh(cx),
            refreshIcon: "mods/jig-review/refresh.svg",
        });
    }

    /** The side panel's repository chooser when the followed folder holds several. */
    repoChooser(t) {
        if ((this.repos?.length ?? 0) < 2) return null;
        const current = this.repos.find((r) => r.path === this.repo);
        const branch = current?.branch || this.branch;
        return v_flex()
            .flex_none()
            .px(12)
            .py(4)
            .border_b(1)
            .border_color(t.border)
            .child(
                chooserRow(t, {
                    id: "review-repo-pick",
                    label: `${repoName(current?.path ?? this.repo)} · ${branch}`,
                    dirty: Boolean(current?.dirty),
                    color: t.ansi3,
                    open: this.picking,
                    onClick: (cx) => {
                        this.picking = !this.picking;
                        cx.notify();
                    },
                }),
            )
            .when(this.picking, (el) =>
                el.child(
                    v_flex()
                        .id("review-repos")
                        .flex_none()
                        .max_h(160)
                        .overflow_y_scrollbar()
                        .children(
                            this.repos.map((repo) =>
                                div()
                                    .id(`review-repo-${repo.path}`)
                                    .h(24)
                                    .px(12)
                                    .flex()
                                    .items_center()
                                    .gap(6)
                                    .truncate()
                                    .text_size(11.5)
                                    .text_color(repo.path === this.repo ? t.foreground : t.muted)
                                    .when(repo.path === this.repo, (row) => row.bg(t.hover))
                                    .hover((row) => row.bg(t.hover).text_color(t.foreground))
                                    .on_click((_e, cx) => {
                                        this.repo = repo.path;
                                        this.name = repoName(repo.path);
                                        this.picking = false;
                                        try {
                                            localStorage.setItem("jig-review.repo", repo.path);
                                        } catch {
                                            // storage unavailable: the chooser still works this session
                                        }
                                        this.resetRepo();
                                        this.refresh(cx);
                                        cx.notify();
                                    })
                                    .child(div().truncate().child(repoName(repo.path)))
                                    .when(repo.linked, (cell) =>
                                        cell.child(div().text_size(9.5).text_color(t.dim).child("worktree")),
                                    ),
                            ),
                        ),
                ),
            );
    }

    // Left column: repo name + Refresh, branch + file count, then the changed files.
    sidebar(t) {
        const more = this.total - this.files.length;
        return v_flex()
            .size_full()
            .border_r(1)
            .border_color(t.border)
            .child(this.header(t))
            .when(!this.fixed, (el) =>
                el.child(
                    contextCard(t, {
                        name: (this.where?.root ?? "").split("/").filter(Boolean).pop() || "Review",
                        follow: this.follow,
                        onFollow: (cx) => this.toggleFollow(cx),
                        machine: this.on ?? null,
                    }),
                ),
            )
            .when(Boolean(this.repoChooser(t)), (el) => el.child(this.repoChooser(t)))
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
            .when(Boolean(this.error), (el) => el.child(panelError(t, this.error)))
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
                    .when(!this.loaded && !this.error, (el) => el.child(div().p(8).text_color(t.dim).child("Reading…")))
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

    /** Move this file's comments onto the new rows, marking a lost quote outdated. */
    reanchor() {
        if (!this.sel) return;
        this.comments = this.comments.map((comment) =>
            comment.file === this.sel ? placeComment(comment, this.rows) : comment,
        );
        this.saveComments();
    }

    /** The current review scope, also the comment store's second key. */
    scopeKey() {
        return this.view === "branch" && this.base ? `branch:${this.base.name}` : "working";
    }

    scopeLabel() {
        return this.view === "branch" && this.base ? `branch vs ${this.base.name}` : "working changes";
    }

    syncComments() {
        const key = commentsKey(this.repo, this.scopeKey());
        if (key === this.commentsAt) return;
        this.commentsAt = key;
        try {
            this.comments = parseComments(localStorage.getItem(key));
        } catch {
            this.comments = [];
        }
    }

    saveComments() {
        if (!this.commentsAt) return;
        try {
            localStorage.setItem(this.commentsAt, JSON.stringify(this.comments));
        } catch {
            this.note = { ok: false, message: "Comments stay in this tab: storage is full." };
        }
    }

    /** The selected diff rows as a comment draft. */
    openComment(cx) {
        if (!this.range || !this.rows.length) return;
        const start = Math.min(this.range.anchor, this.range.end),
            end = Math.max(this.range.anchor, this.range.end),
            rows = this.rows.slice(start, end + 1).filter((row) => row.kind !== "@");
        if (!rows.length) return;
        const first = rows[0],
            last = rows[rows.length - 1];
        this.draft = {
            side: first.kind === "-" ? "old" : "new",
            startLine: first.number,
            endLine: last.number,
            quote: rows.map((row) => row.text),
            note: "",
        };
        this.commentInput.set_value("");
        this.commentInput.focus();
        cx.notify();
    }

    saveDraft(cx) {
        if (!this.draft) return;
        const note = this.draft.note.trim();
        if (!note) {
            this.note = { ok: false, message: "Write a note first." };
            cx.notify();
            return;
        }
        this.comments = addComment(this.comments, {
            ...this.draft,
            id: `${Date.now()}-${this.comments.length}`,
            file: this.sel,
            note,
            at: Date.now(),
        });
        this.draft = null;
        this.saveComments();
        cx.notify();
    }

    /** The focused agent of this space, else the one changed most recently. */
    agentTarget() {
        const space = focused()?.space ?? spaces().find((s) => s.active)?.id;
        const list = agents()
            .filter((agent) => agent.space === space)
            .sort((a, b) => b.seq - a.seq);
        const focusedAgent = focused()?.agent;
        return (
            list.find((agent) => agent.address === focusedAgent) ??
            list.find((agent) => agent.focused) ??
            list[0] ??
            null
        );
    }

    sendReview(cx) {
        if (!this.comments.length) return;
        const agent = this.agentTarget();
        this.sendTarget = agent;
        if (!agent) {
            this.sendError = "No agent in this space. Start one, then send.";
            cx.notify();
            return;
        }
        const busy = agent.status === "working" || agent.status === "blocked";
        if (busy) {
            this.waitingSend = true;
            cx.notify();
            return;
        }
        this.deliver(cx, agent);
    }

    deliver(cx, agent) {
        const text = buildReviewMessage({
            repo: this.repo,
            scope: this.scopeLabel(),
            comments: this.comments,
        });
        this.waitingSend = false;
        this.sendError = null;
        cx.spawn(async (cx) => {
            const result = await hc(["send", agent.address, text]).catch((e) => ({
                code: 1,
                stderr: String(e?.message ?? e),
            }));
            if (result.code !== 0) {
                this.sendError = (result.stderr || result.stdout || "hc send failed").trim().slice(0, 300);
                cx.notify();
                return;
            }
            const count = this.comments.length;
            this.comments = [];
            this.saveComments();
            this.waitingSend = false;
            this.note = { ok: true, message: `Sent review (${count}) to ${agent.tab_name || agent.address}.` };
            run("pane.focus", { terminal: agent.address });
            cx.notify();
        });
        cx.notify();
    }

    commentCard(t, comment) {
        return v_flex()
            .flex_none()
            .mx(8)
            .my(2)
            .p(8)
            .gap(4)
            .rounded(6)
            .border_1()
            .border_color(t.accent)
            .bg(t.raised)
            .text_size(12)
            .child(
                h_flex()
                    .gap(6)
                    .items_center()
                    .child(div().flex_1().truncate().text_color(t.accent).child(comment.file))
                    .child(
                        div()
                            .text_size(11)
                            .text_color(t.dim)
                            .child(
                                comment.startLine === comment.endLine
                                    ? `line ${comment.startLine}`
                                    : `lines ${comment.startLine}–${comment.endLine}`,
                            ),
                    )
                    .child(
                        div()
                            .id(`review-comment-remove-${comment.id}`)
                            .text_size(11)
                            .text_color(t.dim)
                            .cursor_pointer()
                            .hover((s) => s.text_color(t.blocked))
                            .on_click((_e, cx) => {
                                this.comments = removeComment(this.comments, comment.id);
                                this.saveComments();
                                cx.notify();
                            })
                            .child("Remove"),
                    ),
            )
            .child(div().text_color(t.foreground).child(comment.note));
    }

    /** Added / removed rows: a tint behind the row, a full-strength bar at the left edge, and the line
     * number and marker in the same full-strength color. Text stays foreground so it reads over the tint.
     * (Colors take #rrggbbaa; the fallbacks are the dark theme's ansi1 / ansi2 in case a theme lacks them.) */
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

    // Diff | File | Patch, the shown one filled.
    paneSwitch(t) {
        return h_flex()
            .flex_none()
            .gap(2)
            .p(2)
            .rounded(6)
            .bg(t.raised)
            .children(
                PANES.map((pane) =>
                    div()
                        .id(`review-pane-${pane}`)
                        .h(20)
                        .px(8)
                        .flex()
                        .items_center()
                        .rounded(5)
                        .text_size(11.5)
                        .cursor_pointer()
                        .when(this.pane === pane, (el) => el.bg(t.selected).text_color(t.foreground).font_semibold())
                        .when(this.pane !== pane, (el) =>
                            el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)),
                        )
                        .on_click((_e, cx) => this.setPane(pane, cx))
                        .child(PANE_LABEL[pane]),
                ),
            );
    }

    // File and Patch: a read-only editor (drag to select, Ctrl+C to copy), or the reason there is none.
    editorArea(t) {
        if (this.editor) return v_flex().flex_1().min_h(0).child(Editor.new(this.editor.state).flex_1().min_h(0));
        return div()
            .flex_1()
            .min_h(0)
            .p(12)
            .text_color(t.dim)
            .child(this.editorNote ?? "Reading…");
    }

    /** The diff toolbar: one row wide, two rows at side-panel width so nothing is clipped. */
    toolbar(t, file, i, add, del, copy) {
        const { dir, name } = splitPath(file.path);
        const narrow = reviewLayout(this.width).toolbarRows;
        const path = h_flex()
            .flex_1()
            .min_w(0)
            .truncate()
            .tooltip(file.path)
            .child(div().min_w(0).truncate().text_color(t.dim).child(dir))
            .child(div().flex_none().font_semibold().child(name));
        const counts = [
            div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`),
            div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`),
            ...(this.comments.length > 0
                ? [div().flex_none().text_size(11).text_color(t.accent).child(`Comments ${this.comments.length}`)]
                : []),
        ];
        const actions = [
            ...(copy && this.pane === "diff"
                ? [
                      this.textButton(t, "review-comment", "Comment", false, (_e, cx) => this.openComment(cx), true),
                      this.textButton(
                          t,
                          "review-copy-lines",
                          narrow ? `Copy ${copy.lines}` : `Copy ${copy.lines} line${copy.lines === 1 ? "" : "s"}`,
                          false,
                          (_e, cx) => this.copyLines(cx),
                          true,
                      ),
                  ]
                : []),
            this.textButton(
                t,
                "review-copy-file",
                narrow ? "File" : "Copy file",
                false,
                (_e, cx) => this.copyFile(cx, file),
                true,
            ),
            this.textButton(
                t,
                "review-copy-path",
                narrow ? "Path" : "Copy path",
                false,
                (_e, cx) => {
                    cx.write_to_clipboard(file.path);
                    this.flash(cx, true, `Copied ${file.path}`);
                },
                true,
            ),
            ...this.fileActions(t, file),
        ];
        const rows = [path, this.paneSwitch(t), ...counts];
        if (!narrow)
            return h_flex()
                .h(32)
                .flex_none()
                .px(12)
                .gap(10)
                .items_center()
                .border_b(1)
                .border_color(t.border)
                .text_size(12)
                .children(rows)
                .children(actions);
        return v_flex()
            .flex_none()
            .border_b(1)
            .border_color(t.border)
            .child(h_flex().h(32).px(12).gap(8).items_center().text_size(12).children(rows))
            .child(
                h_flex()
                    .h(30)
                    .px(12)
                    .gap(6)
                    .items_center()
                    .overflow_x_scrollbar()
                    .children(actions)
                    .child(this.headerButton(t, "review-prev", "‹", i > 0, (_e, cx) => this.step(-1, cx)))
                    .child(
                        this.headerButton(t, "review-next", "›", i < this.files.length - 1, (_e, cx) =>
                            this.step(1, cx),
                        ),
                    ),
            );
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
                .child(this.loaded ? "No changes" : "Reading…");
        const add = this.rows.filter((r) => r.kind === "+").length,
            del = this.rows.filter((r) => r.kind === "-").length;
        const { dir, name } = splitPath(file.path),
            i = this.files.indexOf(file),
            list = `review-diff-${this.listId}`;
        const copy = selectionCopy(this.rows, this.range);
        return v_flex()
            .size_full()
            .min_w(0)
            .child(this.toolbar(t, file, i, add, del, copy))
            .when(Boolean(this.note), (el) =>
                el.child(statusLine(t, { tone: this.note.ok ? "done" : "error", text: this.note.message })),
            )
            .when(Boolean(this.sendError), (el) => el.child(statusLine(t, { tone: "error", text: this.sendError })))
            .when(this.comments.length > 0 || Boolean(this.draft), (el) =>
                el.child(
                    v_flex()
                        .id("review-comments")
                        .flex_none()
                        .max_h(180)
                        .overflow_y_scrollbar()
                        .border_b(1)
                        .border_color(t.border)
                        .children(
                            (() => {
                                const placed = placeComments(commentsInFile(this.comments, this.sel), this.rows);
                                const out = placed.filter((comment) => comment.outdated);
                                return [
                                    ...(out.length
                                        ? [div().px(12).pt(4).text_size(11).text_color(t.dim).child("Outdated")]
                                        : []),
                                    ...out.map((comment) => this.commentCard(t, comment)),
                                    ...placed
                                        .filter((comment) => !comment.outdated)
                                        .map((comment) => this.commentCard(t, comment)),
                                ];
                            })(),
                        )
                        .when(Boolean(this.draft), (box) =>
                            box.child(
                                v_flex()
                                    .flex_none()
                                    .mx(8)
                                    .my(4)
                                    .p(8)
                                    .gap(6)
                                    .rounded(6)
                                    .border_1()
                                    .border_color(t.accent)
                                    .bg(t.raised)
                                    .child(div().text_size(11).text_color(t.dim).child("New comment"))
                                    .child(Textarea.new(this.commentInput).w_full().h(56).text_size(12))
                                    .child(
                                        h_flex()
                                            .gap(6)
                                            .justify_end()
                                            .child(
                                                this.textButton(t, "comment-cancel", "Cancel", false, (_e, cx) => {
                                                    this.draft = null;
                                                    cx.notify();
                                                }),
                                            )
                                            .child(
                                                this.textButton(t, "comment-save", "Add comment", true, (_e, cx) =>
                                                    this.saveDraft(cx),
                                                ),
                                            ),
                                    ),
                            ),
                        ),
                ),
            )
            .child(
                this.pane !== "diff"
                    ? this.editorArea(t)
                    : div()
                          .flex_1()
                          .min_h(0)
                          .relative()
                          .font_family(settings().font_family ?? "JetBrains Mono")
                          .text_size(12)
                          .child(
                              div()
                                  .id(`review-x-${this.listId}`)
                                  .size_full()
                                  .on_mouse_down("left", (e) => {
                                      this.shift = e.modifiers.shift;
                                  })
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
                                                              this.diffRow(
                                                                  t,
                                                                  row,
                                                                  inSelection(this.range, range.start + i),
                                                              ),
                                                          ),
                                              )
                                                  .on_item_click((key, cx) => {
                                                      this.handle.focus(); // so Shift changes reach on_modifiers_changed
                                                      this.range = selectLine(
                                                          this.rows,
                                                          this.range,
                                                          Number(key),
                                                          this.shift,
                                                      );
                                                      cx.notify();
                                                  })
                                                  .size_full(),
                                          ),
                                  ),
                          )
                          .child(Scrollbar.vertical(list).viewport_from_layout().absolute().inset_0()),
            )
            .when(this.comments.length > 0, (el) => el.child(this.commentFooter(t)));
    }

    /** The send bar: a primary button, or a waiting line while the target agent works. */
    commentFooter(t) {
        const target = this.agentTarget();
        const busy = target && (target.status === "working" || target.status === "blocked");
        const label = this.waitingSend || busy ? "Send when idle" : `Send review (${this.comments.length})`;
        const summary = target
            ? this.waitingSend
                ? `${target.tab_name || target.address} is ${target.status}; sending when idle.`
                : `To ${target.tab_name || target.address}`
            : "No agent in this space.";
        return h_flex()
            .id("review-comments-footer")
            .h(40)
            .flex_none()
            .px(12)
            .gap(8)
            .items_center()
            .border_t(1)
            .border_color(t.border)
            .child(div().flex_1().min_w(0).truncate().text_size(sizes().secondary).text_color(t.muted).child(summary))
            .when(Boolean(target), (el) =>
                el.child(primaryButton(t, "review-send", label, (cx) => this.sendReview(cx))),
            );
    }

    /** No repository under the followed folder, and no prop: say where a review starts. */
    noRepo(t) {
        const text = this.loadingRepos
            ? "Reading repositories…"
            : "Not in a git repository. Open a diff from Git, or cd into a repository.";
        return v_flex()
            .id("jig-review")
            .size_full()
            .min_h(0)
            .bg(t.background)
            .text_color(t.foreground)
            .child(this.header(t))
            .child(emptyLine(text, t));
    }

    render(_cx) {
        const t = theme();
        const context = viewForContext(this.contextKey, this.loadedContext, this.files, {
            error: this.error,
            noFolder: !this.repo || !this.where?.root,
        });
        if (!this.fixed && context.pending)
            return v_flex()
                .id("jig-review")
                .size_full()
                .bg(t.background)
                .child(this.header(t))
                .child(
                    contextCard(t, {
                        name: (this.where?.root ?? "").split("/").filter(Boolean).pop() || "Review",
                        follow: this.follow,
                        onFollow: (cx) => this.toggleFollow(cx),
                        machine: this.on ?? null,
                    }),
                )
                .child(skeleton(t));
        if (!this.fixed && !this.repo) return this.noRepo(t);
        return h_flex()
            .id("jig-review")
            .size_full()
            .min_h(0)
            .overflow_hidden()
            .bg(t.background)
            .text_color(t.foreground)
            .text_size(13)
            .track_focus(this.handle)
            .on_size_change((size, cx) => {
                if (Math.round(size.width) === Math.round(this.width)) return;
                this.width = size.width;
                cx.notify();
            })
            .on_key_down((e, cx) => this.key(e, cx))
            .on_modifiers_changed((e) => {
                this.shift = e.modifiers.shift;
            })
            .on_key_up((e) => {
                this.shift = Boolean(e.modifiers?.shift);
            })
            .on_mouse_down("left", (e) => {
                this.shift = e.modifiers.shift;
                // Diff keeps the keyboard on the tab; the editors take it themselves when clicked.
                if (this.pane === "diff") this.handle.focus();
            })
            .child(
                this.width > 0 && this.width < 640
                    ? v_flex()
                          .size_full()
                          .min_h(0)
                          .child(v_flex().flex_none().h(reviewLayout(this.width).listHeight).child(this.sidebar(t)))
                          .child(v_flex().flex_1().min_h(0).child(this.diffPanel(t)))
                    : h_resizable("review-split")
                          .size_full()
                          .on_resize((sizes) => {
                              this.sideWidth = sizes[0];
                              saveSideWidth(sizes[0]);
                          })
                          .child(
                              resizable_panel()
                                  .size(this.sideWidth)
                                  .size_range(SIDE_MIN, SIDE_MAX)
                                  .child(this.sidebar(t)),
                          )
                          .child(resizable_panel().child(this.diffPanel(t))),
            );
    }
}
