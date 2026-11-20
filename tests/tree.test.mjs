import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { projectSpaces, sessionKey } from "../mods/herdr-project-spaces/projection.js";
import { sessionMenu } from "../mods/herdr-project-spaces/actions.js";

// The tree runs inside Herdr: what it imports from Herdr and GPUI becomes stubs that log each call and return nothing.
const mod = new URL("../mods/herdr-project-spaces/", import.meta.url), host = ["herdr", "gpui-kit", "gpui-base"];
const names = new Set();
for (const file of ["main.js", "session-overlays.js", "tree.js", "stock-spaces.js"]) {
  for (const [, list] of (await readFile(new URL(file, mod), "utf8")).matchAll(/^import \{([^}]+)\} from "(?:herdr|gpui-kit|gpui-base)";$/gm)) {
    for (const name of list.split(",")) names.add(name.trim());
  }
}
// As Herdr's, a View's constructor calls its init.
const stub = `data:text/javascript,${encodeURIComponent([...names].map(name => name === "View" ? "export class View { constructor(props) { this.init?.(props); } }"
  : `export const ${name} = (...args) => { globalThis.herdrCalls.push([${JSON.stringify(name)}, ...args]); };`).join("\n"))}`;
registerHooks({ resolve: (specifier, context, next) => host.includes(specifier) ? { url: stub, shortCircuit: true } : next(specifier, context) });
const { default: ProjectTree } = await import("../mods/herdr-project-spaces/tree.js");
const { default: ProjectSpaces } = await import("../mods/herdr-project-spaces/main.js");
const { SessionMenu } = await import("../mods/herdr-project-spaces/session-overlays.js");

test("a live row's open focuses its pane and calls no control command", () => {
  const endpoint = { version: 3, command: ["/control"], stateDir: "/state", machine: null };
  const session = { id: "p", project: "p", kind: "coordinator", title: "P", folder: "/p", rank: 0, state: "running", resolved: false, terminal: "t1",
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

// Any action on this session fails before anything runs: control's descriptor is missing.
const failing = { id: "p", project: "p", kind: "coordinator", title: "P", folder: "/p", rank: 0, state: "stopped", resolved: false, endpoint: {}, available: true };
const key = sessionKey(failing);
// A tree that only shows its rows, and a cx that runs a task as Herdr does: at once, up to its first await.
function harness() {
  const tasks = [], cx = { spawn: body => tasks.push(body(cx)), notify() {}, focus_handle: () => ({ focus() {} }) };
  const tree = Object.assign(Object.create(ProjectTree.prototype), { actions: new Set(), changing: new Map(), tabTitles: new Map(), refreshSessions() {} });
  return { tree, cx, done: () => Promise.all(tasks) };
}

test("a failed action clears only its own pending fields", async () => {
  globalThis.herdrCalls = [];
  const { tree, cx, done } = harness();
  tree.pend({ keys: [key], fields: { resolved: true } });
  tree.action("rename", { key: "row", session: failing }, cx, { title: "New" });
  assert.deepEqual(tree.changing.get(key), { resolved: true, title: "New" });
  await done();
  assert.deepEqual(tree.changing.get(key), { resolved: true });
});

test("an action from the menu shows on the tree's rows as the same action from the tree does", async () => {
  globalThis.herdrCalls = [];
  const [own, told] = [harness(), harness()], menu = new SessionMenu();
  for (const { tree } of [own, told]) tree.pend({ keys: [key], fields: { title: "Renaming" } });
  own.tree.action("open", { key: "row", session: failing }, own.cx, {});
  menu.init({ session: failing, overlay: "menu", open: {} }, told.cx);
  menu.choose(sessionMenu(failing).findIndex(item => item.action === "open"), told.cx);
  // The menu is its own copy of the mod: the tree reads what it said through shared state.
  const messages = () => globalThis.herdrCalls.filter(([name]) => name === "setShared").map(([, , message]) => JSON.parse(JSON.stringify(message)));
  const [started] = messages();
  told.tree.pend(started.pending, started.saved);
  assert.deepEqual(told.tree.changing, own.tree.changing);
  assert.deepEqual(own.tree.changing.get(key), { title: "Renaming", state: "starting" });
  await Promise.all([own.done(), told.done()]);
  const [, ended] = messages();
  told.tree.pend(ended.pending, ended.saved);
  assert.deepEqual(told.tree.changing, own.tree.changing);
});
