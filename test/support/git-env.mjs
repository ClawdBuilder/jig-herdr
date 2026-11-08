// Every test process gets its own git identity and global config, so a runner with no user git settings behaves as this
// laptop does. Spawned shells inherit these, including the mods' real-shell scripts and the scan script's tests.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jig-herdr-git-"));
const config = join(dir, "gitconfig");
writeFileSync(
    config,
    [
        "[user]",
        "\tname = Jig Tests",
        "\temail = tests@example.invalid",
        "[init]",
        "\tdefaultBranch = main",
        "[commit]",
        "\tgpgsign = false",
        "[tag]",
        "\tgpgsign = false",
        "",
    ].join("\n"),
);
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "Jig Tests";
process.env.GIT_AUTHOR_EMAIL = "tests@example.invalid";
process.env.GIT_COMMITTER_NAME = "Jig Tests";
process.env.GIT_COMMITTER_EMAIL = "tests@example.invalid";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
