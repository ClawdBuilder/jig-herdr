// The push confirm: a dialog the panel opens before it sends anything to the remote (openOverlay of this same mod, with
// `props().push`). It names the branch and the destination git will really use (pushRemote and push.default included), lists
// the commits that will go (at most ten, then "and N more") and does nothing until its button is pressed. A branch whose
// push target is another branch is published as itself instead, and says so. The git work is in lib.js; a refusal or git's
// own error shows here and the dialog stays open. The panel and this dialog share one lock per checkout, so their actions
// cannot overlap.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, panes, setShared, shared, spaces, theme } from "herdr";
import {
    RUNNING_KEY,
    busyAgents,
    lockOf,
    panesOn,
    holdsLock,
    publishBranch,
    pushBranch,
    withLock,
    withoutLock,
    wrapperScript,
} from "./lib.js";
import { DONE } from "./picker.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const OWN = (name) => `mods/repo-changes/${name}.svg`;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export class PushConfirm {
    constructor(props) {
        const p = props.push ?? {};
        this.overlay = props.overlay;
        this.on = p.on ?? null;
        this.path = p.path ?? "";
        this.name = p.name ?? this.path.split("/").pop();
        this.branch = p.branch ?? "";
        this.remote = p.remote ?? "origin";
        this.target = p.target ?? p.upstream ?? `${this.remote}/${this.branch}`;
        this.targetBranch = p.targetBranch ?? this.branch;
        this.mode = p.mode ?? (p.upstream ? "push" : "publish");
        this.reason = p.reason ?? null;
        this.commits = p.commits ?? [];
        this.count = p.count ?? 0;
        this.more = p.more ?? 0;
        this.others = p.others ?? [];
        this.timeout = p.timeout ?? 60000;
        this.what = p.what ?? "push";
        // What git must still say when the button is pressed: the branch and destination this dialog showed.
        this.expect = p.expect ?? { branch: this.branch, remote: this.remote, target: this.target, mode: this.mode };
        this.running = false;
        this.message = null;
        this.title = this.mode === "publish" ? "Publish branch" : "Push branch";
        this.warning = this.refusal();
    }

    /** Herdr's exec on the checkout's machine: a network command needs the environment that never asks and a timeout. */
    exec() {
        const on = this.on;
        return (cmd, args, options = {}) => {
            if (!options.env && !options.timeout) return exec(cmd, args, { cwd: options.cwd, on });
            return exec("sh", ["-c", wrapperScript(options.env, options.timeout), "sh", cmd, ...args], {
                cwd: options.cwd,
                on,
            });
        };
    }

    /** Agents working or blocked in this checkout now: the dialog refuses while one is. */
    busy() {
        const panesHere = panesOn(panes(), spaces(), this.on);
        return busyAgents(this.path, panesHere, this.others);
    }

    /** What another copy of this mod runs in this checkout now, or null. */
    lock() {
        return lockOf(shared(RUNNING_KEY) ?? {}, this.on, this.path);
    }

    /** Takes this checkout's lock for this dialog: a token, checked again after a short wait, so the panel and a second
     * dialog cannot both act. Resolves with the token, or null when another action holds it. */
    async hold() {
        const locks = shared(RUNNING_KEY) ?? {};
        if (lockOf(locks, this.on, this.path)) return null;
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setShared(RUNNING_KEY, withLock(locks, this.on, this.path, this.actionName(), Date.now(), token));
        await exec("sh", ["-c", "sleep 0.15"], { on: this.on }).catch(() => null);
        return holdsLock(shared(RUNNING_KEY) ?? {}, this.on, this.path, token) ? token : null;
    }

    release(token) {
        setShared(RUNNING_KEY, withoutLock(shared(RUNNING_KEY) ?? {}, this.on, this.path, Date.now(), token));
    }

    actionName() {
        return this.mode === "publish" ? "Publishing" : "Pushing";
    }

    /** The refusal the dialog shows before anything runs, or null. */
    refusal() {
        const busy = this.busy();
        if (busy.length) {
            const who = busy[0];
            return `${who.name || "An agent"} is ${who.status} in ${who.cwd}: wait until it stops.`;
        }
        const lock = this.lock();
        if (lock) return `${lock.what} is already running in this checkout: wait until it finishes.`;
        return null;
    }

    /** Runs the command the dialog is about: the push or the publish. */
    run(cx) {
        if (this.running) return;
        const refusal = this.refusal();
        if (refusal) {
            this.message = refusal;
            cx.notify();
            return;
        }
        this.running = true;
        this.message = null;
        const git = this.exec(),
            options = {
                checkout: this.path,
                busy: this.busy(),
                remote: this.remote,
                timeout: this.timeout,
                expect: this.expect,
            };
        cx.spawn(async (cx) => {
            const token = await this.hold();
            this.holding = token;
            if (!token) {
                this.running = false;
                this.message = "Another action is running in this checkout.";
                cx.notify();
                return;
            }
            let r;
            try {
                r = this.mode === "publish" ? await publishBranch(git, options) : await pushBranch(git, options);
            } catch (e) {
                const said = String(e?.message ?? e).split("\n")[0];
                r = {
                    ok: false,
                    message: /timed? ?out|timeout|took too long|abort|cancel/i.test(said)
                        ? "The command took too long and was stopped. Check the connection, or use a terminal."
                        : said,
                };
            }
            this.running = false;
            this.release(token);
            this.holding = null;
            if (r.ok) {
                setShared(DONE, { path: this.path, message: r.message, at: Date.now() });
                closeOverlay(this.overlay);
                return;
            }
            this.message = r.message;
            cx.notify();
        });
        cx.notify();
    }

    branchLine(t) {
        const chip = (text, colour) =>
            div()
                .flex_none()
                .max_w(190)
                .min_w(0)
                .truncate()
                .px(6)
                .h(20)
                .flex()
                .items_center()
                .rounded(5)
                .bg(t.raised)
                .text_size(11)
                .text_color(colour)
                .child(text);
        return h_flex()
            .flex_none()
            .gap(6)
            .items_center()
            .child(svg(ICON("branch")).size(12).flex_none().text_color(t.muted))
            .child(chip(this.branch, t.foreground))
            .child(div().flex_none().text_size(12).text_color(t.dim).child("→"))
            .child(chip(this.target, t.muted));
    }

    commitsBlock(t) {
        const verb = this.mode === "publish" ? "publish" : "push";
        if (!this.count)
            return div()
                .flex_none()
                .text_size(11.5)
                .text_color(t.dim)
                .child(
                    this.mode === "publish"
                        ? "This branch has no commit to publish yet."
                        : `Nothing to send: ${this.target} has it all.`,
                );
        return v_flex()
            .flex_none()
            .gap(4)
            .child(
                div()
                    .flex_none()
                    .text_size(10.5)
                    .font_semibold()
                    .text_color(t.dim)
                    .child(`${plural(this.count, "commit")} to ${verb}`),
            )
            .children(
                this.commits.map((c) =>
                    h_flex()
                        .flex_none()
                        .gap(8)
                        .items_center()
                        .text_size(11.5)
                        .child(div().flex_none().text_color(t.dim).child(c.hash))
                        .child(div().min_w(0).truncate().tooltip(c.subject).child(c.subject)),
                ),
            )
            .when(this.more > 0, (el) =>
                el.child(div().flex_none().text_size(11).text_color(t.dim).child(`and ${this.more} more`)),
            );
    }

    /** The overlay closed (Escape): while the command runs the lock stays, so nothing else can start in this checkout;
     * the task releases it when git ends. Closed before the run (or after it), there is nothing to hold. */
    async close() {
        if (this.holding && !this.running) {
            this.release(this.holding);
            this.holding = null;
        }
    }

    render(_cx) {
        const t = theme();
        const solid = t.solid ?? t.accent,
            solidOn = t.solid_foreground ?? t.accent_foreground;
        const verb = this.mode === "publish" ? "Publish" : "Push";
        const label = this.running ? (this.mode === "publish" ? "Publishing…" : "Pushing…") : verb;
        return v_flex()
            .id("push-confirm")
            .w_full()
            .min_h(0)
            .p(14)
            .gap(10)
            .text_color(t.foreground)
            .text_size(13)
            .child(
                h_flex()
                    .flex_none()
                    .gap(7)
                    .items_center()
                    .child(svg(OWN("push")).size(14).flex_none().text_color(t.muted))
                    .child(div().flex_none().font_semibold().child(this.title))
                    .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.name)),
            )
            .child(this.branchLine(t))
            .when(Boolean(this.reason), (el) =>
                el.child(
                    div()
                        .flex_none()
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(
                            `${this.reason} This ${this.mode === "publish" ? "publishes" : "pushes"} ${this.target}.`,
                        ),
                ),
            )
            .child(this.commitsBlock(t))
            .when(Boolean(this.warning), (el) =>
                el.child(
                    div().flex_none().text_size(11.5).text_color(t.blocked).child(`Refused for now: ${this.warning}`),
                ),
            )
            .when(Boolean(this.message), (el) =>
                el.child(div().flex_none().text_size(11.5).text_color(t.blocked).child(this.message)),
            )
            .child(
                h_flex()
                    .flex_none()
                    .gap(6)
                    .justify_end()
                    .items_center()
                    .when(Boolean(this.running), (el) =>
                        el
                            .child(div().flex_none().text_size(11).text_color(t.dim).child(label))
                            .child(div().flex_none().text_size(11).text_color(t.accent).frames(SPINNER, 90)),
                    )
                    .child(
                        div()
                            .id("push-cancel")
                            .flex_none()
                            .h(26)
                            .px(10)
                            .flex()
                            .items_center()
                            .rounded(6)
                            .bg(t.raised)
                            .text_size(12)
                            .cursor_pointer()
                            .when(this.running, (el) => el.opacity(0.5))
                            .when(!this.running, (el) =>
                                el
                                    .hover((s) => s.opacity(0.85))
                                    .on_click((_e, cx) => {
                                        cx.stop_propagation();
                                        closeOverlay(this.overlay);
                                    }),
                            )
                            .child("Cancel"),
                    )
                    .child(
                        div()
                            .id("push-go")
                            .flex_none()
                            .h(26)
                            .px(12)
                            .flex()
                            .items_center()
                            .rounded(6)
                            .when(this.running, (el) => el.opacity(0.6))
                            .when(!this.running, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)))
                            .bg(solid)
                            .text_color(solidOn)
                            .text_size(12)
                            .font_semibold()
                            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                            .on_click((_e, cx) => {
                                cx.stop_propagation();
                                this.run(cx);
                            })
                            .child(this.running ? "Working…" : verb),
                    ),
            );
    }
}
