// Follows the Jig palette Pi uses. Reads the theme name from Pi's settings.json (on the machine
// where Pi runs), turns that palette's 17 named colours into a Herdr theme in themes/, and
// switches the window to it. It shows nothing: the jig layout gives it a block of 0 px.
//
// Where Pi runs, and where its palettes are, comes from config.json next to this file (see
// ../../README.md). A palette is looked for in <agent dir>/themes/ (your own, written by
// jig-theme), then in themeFolders, then among the themes this plugin installed (the six
// built-in ones). Pi's own themes (dark, light) have no palette and are left alone.

import { View, div } from "gpui-kit";
import { appHome, exec, home, notify, readTextFile, run, writeTextFile } from "herdr";
import { themeText, toHerdr } from "./convert.js";
import { agentFolder, inHome, parseConfig, themeName } from "./lib.js";

const EVERY_MS = 5000;

export default class JigThemeSync extends View {
    init(_props, cx) {
        this.name = null; // the palette in use now
        this.written = {}; // palette name -> the theme text last written
        this.where = {}; // config text -> { home, agentDir } on its machine
        this.warned = new Set();
        this.sync(cx);
        cx.timer.every(EVERY_MS, (cx) => this.sync(cx));
    }

    warn(message) {
        if (this.warned.has(message)) return;
        this.warned.add(message);
        notify({ title: "jig-theme-sync", body: message, level: "warning" });
    }

    // The machine's home and Pi's agent folder there: asked once per config.
    async locate(config, text) {
        if (this.where[text]) return this.where[text];
        const on = config.machine;
        let homeDir,
            env = "";
        try {
            const r = await exec("sh", ["-c", 'printf "%s\\n%s" "$HOME" "$PI_CODING_AGENT_DIR"'], { on });
            [homeDir, env = ""] = r.stdout.split("\n");
        } catch (e) {
            if (on) throw e; // a machine that cannot run sh is a wrong name or an offline machine
            homeDir = home(); // this computer has no sh (Windows): its home, and Pi's default folder
        }
        if (!homeDir) throw new Error("cannot find the home folder");
        this.where[text] = { home: homeDir, agentDir: agentFolder(config, homeDir, env.trim() || null) };
        return this.where[text];
    }

    sync(cx) {
        if (this.busy) return;
        this.busy = true;
        cx.spawn(async () => {
            try {
                const configText = await readTextFile(`${appHome()}/mods/jig-theme-sync/config.json`);
                const config = parseConfig(configText);
                for (const p of config.problems) this.warn(p);
                const on = config.machine;
                const where = await this.locate(config, configText ?? "");
                const name = themeName(await readTextFile(`${where.agentDir}/settings.json`, { on }));
                if (!name) return;
                const folders = [`${where.agentDir}/themes`, ...config.themeFolders.map((f) => inHome(f, where.home))];
                let file = null;
                for (const folder of folders) {
                    file = await readTextFile(`${folder}/${name}.json`, { on });
                    if (file) break;
                }
                const path = `${appHome()}/themes/${name}.json`;
                if (file) {
                    const palette = JSON.parse(file);
                    const herdrTheme = toHerdr(palette.vars, palette.appearance);
                    if (!herdrTheme) return;
                    const text = themeText(herdrTheme);
                    if (this.written[name] !== text) {
                        const before = await readTextFile(path);
                        if (before !== text) await writeTextFile(path, text, before);
                        this.written[name] = text;
                        if (name === this.name) run("app.theme", { name }); // the same palette, new colours
                    }
                } else if ((await readTextFile(path)) === null) {
                    return; // no palette to convert and no installed theme of that name: left alone
                }
                if (name !== this.name) {
                    run("app.theme", { name });
                    this.name = name;
                }
            } catch (e) {
                this.warn(String(e?.message ?? e));
            } finally {
                this.busy = false; // nothing is drawn, so nothing to redraw
            }
        });
    }

    // Nothing to see: the layout gives this block no height, and the window's colours are what it changes. Its timer runs
    // all the same, so the sync goes on. Problems still come as notifications.
    render(_cx) {
        return div();
    }
}
