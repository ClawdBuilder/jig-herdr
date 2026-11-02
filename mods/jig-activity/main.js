// A vertical icon bar that switches the child shown by a stack, like an editor's activity bar.
//
// props: { stack: "<id of the stack to switch>" }, default "panel-body".
// The buttons come from the layout: each child of the stack gives its tooltip in "title" and, in its
// content.props.activity, { "icon": "<path of an svg under the Herdr folder>", "end": true, "divider": true }. The
// icon is drawn in the text colour; "end" puts the button at the bottom; "divider" draws a line after it, so the panels
// above it read as a group. A child whose mod is not installed has no button.
// A mod puts a count on its button with setShared("badge.<mod>", { count, tone }), tone a theme colour.

import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { appHome, layout, props, readTextFile, run, shared, theme } from "herdr";
import { buttons, find, initial } from "./lib.js";

const RECHECK_MS = 30000; // how often to look again for mods that were installed or removed

export default class JigActivity extends View {
    init(_props, cx) {
        this.present = new Map(); // mod name -> installed?
        this.checking = false;
        this.check(cx);
        cx.timer.every(RECHECK_MS, (cx) => this.check(cx));
    }

    // Which of the layout's mods have a folder in mods/. A button for a missing mod would open an empty panel.
    check(cx) {
        if (this.checking) return;
        this.checking = true;
        const stack = find(layout(), props()?.stack ?? "panel-body");
        const mods = [...new Set((stack?.children ?? []).map((c) => c.content?.mod).filter(Boolean))];
        cx.spawn(async (cx) => {
            let changed = false;
            for (const mod of mods) {
                const there = (await readTextFile(`${appHome()}/mods/${mod}/mod.json`)) !== null;
                if (this.present.get(mod) !== there) changed = true;
                this.present.set(mod, there);
            }
            this.checking = false;
            if (changed) cx.notify();
        });
    }

    button(t, stackId, b) {
        const badge = shared(`badge.${b.mod}`);
        return div()
            .id(`act-${b.id}`)
            .relative()
            .w(40)
            .h(40)
            .flex()
            .items_center()
            .justify_center()
            .border_l(2)
            .border_color(b.active ? t.accent : t.chrome)
            .text_color(b.active ? t.foreground : t.dim)
            .cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .tooltip(b.title)
            .on_click(() => run("layout.select", { stack: stackId, child: b.id }))
            .child(b.icon ? svg(b.icon).size(18) : div().text_size(13).font_semibold().child(initial(b.title)))
            .when(badge?.count > 0, (el) =>
                el.child(
                    div()
                        .absolute()
                        .top(5)
                        .right(4)
                        .min_w(15)
                        .h(15)
                        .px(4)
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(t[badge.tone] ?? t.accent)
                        .text_color(t.background)
                        .text_size(9.5)
                        .font_semibold()
                        .child(badge.count > 99 ? "99+" : String(badge.count)),
                ),
            );
    }

    // A button, and the line after it when it asks for one.
    item(t, stackId, b) {
        if (!b.divider) return [this.button(t, stackId, b)];
        return [this.button(t, stackId, b), div().mx(10).my(4).h(1).bg(t.border)];
    }

    render(_cx) {
        const t = theme();
        const id = props()?.stack ?? "panel-body";
        const all = buttons(find(layout(), id), this.present);
        return v_flex()
            .size_full()
            .bg(t.chrome)
            .border_l(1)
            .border_color(t.border)
            .py(4)
            .children(all.filter((b) => !b.end).flatMap((b) => this.item(t, id, b)))
            .child(div().flex_1())
            .children(all.filter((b) => b.end).flatMap((b) => this.item(t, id, b)));
    }
}
