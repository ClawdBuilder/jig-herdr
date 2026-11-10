import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./support.ts";

type Lib = Record<string, any>;

test("Review uses the prop repository on a tab and the followed one in the side panel", async () => {
    const { repositoryFor } = await load<Lib>("mods/jig-review/lib.js");
    assert.equal(repositoryFor({ repo: "/work/app" }, "/focused/other"), "/work/app");
    assert.equal(repositoryFor({}, "/focused/app"), "/focused/app");
    assert.equal(repositoryFor(null, "/focused/app"), "/focused/app");
    assert.equal(repositoryFor({}, null), "");
});

test("Review keeps the current repository, else the remembered one, else a dirty one, else the first", async () => {
    const { chooseRepo, parseRepoList } = await load<Lib>("mods/jig-review/lib.js");
    const parsed = parseRepoList("@single\n/work/a\tm\tmain\t0\n/work/b\tw\tfeature\t1\n");
    assert.equal(parsed.single, true);
    assert.deepEqual(
        parsed.repos.map((r: any) => r.path),
        ["/work/a", "/work/b"],
    );
    assert.equal(chooseRepo(parsed.repos, "/work/a", "/work/b"), "/work/a");
    assert.equal(chooseRepo(parsed.repos, "/work/gone", "/work/b"), "/work/b");
    assert.equal(chooseRepo(parsed.repos, "/work/gone", "/work/also-gone"), "/work/b");
    assert.equal(chooseRepo([], "/work/a", "/work/b"), null);
});
