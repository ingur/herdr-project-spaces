import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { projectSpaces } from "../mods/herdr-project-spaces/projection.js";

// The tree runs inside Herdr: what it imports from Herdr and GPUI becomes stubs that log each call.
const mod = new URL("../mods/herdr-project-spaces/", import.meta.url), host = ["herdr", "gpui-kit", "gpui-base"];
const names = new Set();
for (const file of ["main.js", "session-overlays.js", "tree.js", "stock-spaces.js"]) {
  for (const [, list] of (await readFile(new URL(file, mod), "utf8")).matchAll(/^import \{([^}]+)\} from "(?:herdr|gpui-kit|gpui-base)";$/gm)) {
    for (const name of list.split(",")) names.add(name.trim());
  }
}
// As Herdr's, a View's constructor calls its init.
const stub = `data:text/javascript,${encodeURIComponent([...names].map(name => name === "View" ? "export class View { constructor(props) { this.init?.(props); } }"
  : `export const ${name} = (...args) => globalThis.herdrCalls.push([${JSON.stringify(name)}, ...args]);`).join("\n"))}`;
registerHooks({ resolve: (specifier, context, next) => host.includes(specifier) ? { url: stub, shortCircuit: true } : next(specifier, context) });
const { default: ProjectTree } = await import("../mods/herdr-project-spaces/tree.js");
const { default: ProjectSpaces } = await import("../mods/herdr-project-spaces/main.js");

test("a live row's open focuses its pane and calls no control command", () => {
  const endpoint = { version: 2, command: ["/control"], stateDir: "/state", machine: null };
  const session = { id: "p", coordinator: "p", role: "coordinator", title: "P", cwd: "/p", rank: 0, state: "running", resolved: false, terminal: "t1",
    endpoint, available: true, native: { space: "one", tab: "tab", terminal: "t1" } };
  const rows = projectSpaces({ spaces: [{ id: "one", name: "one", tabs: [{ id: "tab" }] }], panes: [{ pane: "p1", tab: "tab", terminal: "t1" }], agents: [], sessions: [session] });
  globalThis.herdrCalls = [];
  Object.assign(Object.create(ProjectTree.prototype), { drawn: rows }).open(rows[0].groups[0].coordinator, null);
  assert.deepEqual(globalThis.herdrCalls, [["run", "tab.select", { id: "tab" }], ["run", "pane.focus", { pane: "p1" }]]);
});

test("the mod's view starts its tree once", () => {
  const init = ProjectTree.prototype.init, calls = [];
  globalThis.herdrCalls = [];
  ProjectTree.prototype.init = function (...args) { calls.push(args); };
  try { new ProjectSpaces(); } finally { ProjectTree.prototype.init = init; }
  assert.equal(calls.length, 1);
});
