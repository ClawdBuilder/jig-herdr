// Pure helpers of jig-theme-sync: reading config.json and Pi's settings.json.

export const DEFAULTS = { machine: null, agentDir: null, themeFolders: [] };

// config.json as { machine, agentDir, themeFolders }. Anything missing or of the wrong kind
// takes its default, so a typo never stops the sync; `problems` says what was ignored.
export function parseConfig(text) {
    const config = { ...DEFAULTS, themeFolders: [], problems: [] };
    if (text == null || text.trim() === "") return config;
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        config.problems.push(`config.json is not valid JSON: ${e.message}`);
        return config;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        config.problems.push("config.json must hold an object");
        return config;
    }
    const text1 = (key) => {
        if (raw[key] == null) return null;
        if (typeof raw[key] === "string" && raw[key].trim() !== "") return raw[key].trim();
        config.problems.push(`"${key}" must be a non-empty string or null`);
        return null;
    };
    config.machine = text1("machine");
    config.agentDir = text1("agentDir");
    if (raw.themeFolders != null) {
        if (
            Array.isArray(raw.themeFolders) &&
            raw.themeFolders.every((f) => typeof f === "string" && f.trim() !== "")
        ) {
            config.themeFolders = raw.themeFolders.map((f) => f.trim());
        } else config.problems.push('"themeFolders" must be a list of folders');
    }
    return config;
}

// A folder from the config as an absolute path on the machine: "~/x" and "x" are under its home.
export function inHome(folder, home) {
    if (/^([/\\]|[A-Za-z]:)/.test(folder)) return folder;
    return `${home.replace(/[/\\]+$/, "")}/${folder.replace(/^~[/\\]?/, "")}`;
}

// The Pi agent folder: the config, else $PI_CODING_AGENT_DIR (as Pi reads it), else ~/.pi/agent.
export function agentFolder(config, home, env) {
    if (config.agentDir) return inHome(config.agentDir, home);
    return env ? inHome(env, home) : inHome(".pi/agent", home);
}

// The theme name from Pi's settings.json, or null if there is none or it could not be a file name.
export function themeName(settingsText) {
    let name;
    try {
        name = JSON.parse(settingsText ?? "{}").theme;
    } catch {
        return null;
    }
    return typeof name === "string" && /^[\w.-]+$/.test(name) ? name : null;
}
