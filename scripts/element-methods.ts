// Regenerates test/support/element-methods.json from a Herdr gpui-kit.d.ts, so the strict stubs know every real method.
// Usage: node scripts/element-methods.ts <gpui-kit.d.ts> [output]
import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2];
const output = process.argv[3] ?? "test/support/element-methods.json";
if (!input) throw new Error("usage: node scripts/element-methods.ts <gpui-kit.d.ts> [output]");
const text = readFileSync(input, "utf8");
const wanted = ["NativeElement", "InputState", "TextareaState", "EditorState"];
const found: Record<string, string[]> = {};
for (const name of wanted) {
    const start = text.search(new RegExp(`export\\s+interface\\s+${name}\\s*\\{`));
    if (start < 0) throw new Error(`interface ${name} not found in ${input}`);
    let depth = 0;
    let block = false;
    let line = false;
    const methods: string[] = [];
    for (let i = text.indexOf("{", start); i < text.length; i++) {
        const c = text[i],
            next = text[i + 1];
        if (block) {
            if (c === "*" && next === "/") {
                block = false;
                i++;
            }
            continue;
        }
        if (line) {
            if (c === "\n") line = false;
            continue;
        }
        if (c === "/" && next === "*") {
            block = true;
            i++;
            continue;
        }
        if (c === "/" && next === "/") {
            line = true;
            i++;
            continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) break;
        } else if (depth === 1 && /[A-Za-z_$]/.test(c) && (i === 0 || !/[\w$]/.test(text[i - 1]))) {
            let j = i;
            while (j < text.length && /[\w$]/.test(text[j])) j++;
            let k = j;
            while (k < text.length && /[ \t]/.test(text[k])) k++;
            if (text[k] === "(" || text[k] === "<") methods.push(text.slice(i, j));
            i = j - 1;
        }
    }
    found[name] = [...new Set(methods)].sort();
}
const body = Object.entries(found)
    .map(([name, list]) => `    ${JSON.stringify(name)}: ${JSON.stringify(list)}`)
    .join(",\n");
writeFileSync(output, `{\n${body}\n}\n`);
console.log(`${output}: ${Object.values(found).reduce((n, list) => n + list.length, 0)} methods`);
