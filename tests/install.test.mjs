import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrHome, install, mergeKeys, replaceSpaces } from "../install.mjs";

const MOD = "herdr-project-spaces", root = new URL("../", import.meta.url);
const layout = {
  id: "root", type: "row", colors: { accent: "#123456" },
  children: [
    { id: "sidebar", type: "column", size: { px: 268 }, children: [
      { id: "spaces", type: "block", min: 90, content: { mod: "spaces", props: { retained: true } } },
      { id: "agents", type: "block", min: 90, content: { mod: "agents" } },
    ] },
    { id: "work", type: "block", content: { tab: "active", pane: { header: { content: { mod: "pane" } } } } },
  ],
};
const wanted = JSON.parse(await readFile(new URL("keys.json", root), "utf8"));
const mac = JSON.parse(await readFile(new URL("keys.macos.json", root), "utf8"));
const SECTION = "layout:Projects";

test("only the Spaces block's mod changes; a layout without exactly one Spaces block of Herdr's is refused", () => {
  const before = structuredClone(layout), result = replaceSpaces(layout);
  assert.deepEqual(result.children[0].children[0].content, { mod: MOD, props: { retained: true } });
  assert.deepEqual(replaceSpaces(result), result, "one that shows the mod already stays as it is");
  result.children[0].children[0].content.mod = "spaces";
  assert.deepEqual([result, layout], [before, before]);
  assert.throws(() => replaceSpaces({ id: "root", type: "row" }), /exactly one block/);
  const duplicate = structuredClone(layout);
  duplicate.children.push(structuredClone(duplicate.children[0].children[0]));
  assert.throws(() => replaceSpaces(duplicate), /found 2/);
  const personal = structuredClone(layout);
  personal.children[0].children[0].content.mod = "personal-spaces";
  assert.throws(() => replaceSpaces(personal), /left unchanged/);
});

test("keys are added once; the user's own bindings, moved actions and other sections are kept", () => {
  const stock = { global: { "alt-down": "agent.next", "alt-1": "space.select:1" }, terminal: { "ctrl-left": "send:\u001bb" } };
  const { text, added } = mergeKeys(`${JSON.stringify(stock, null, 2)}\n`, wanted);
  assert.ok(text.startsWith(`${JSON.stringify(stock, null, 2).slice(0, -2)},\n  "${SECTION}": {`), "existing text is only appended to");
  assert.deepEqual([JSON.parse(text), added], [{ ...stock, ...wanted }, Object.keys(wanted[SECTION])]);
  assert.equal(mergeKeys(text, wanted), null, "nothing missing: the file is not rewritten");
  // alt-down given back to stock's agent.next, and "next" moved to a key of their own.
  const personal = { ...stock, [SECTION]: { "alt-down": "agent.next", "alt-n": `${MOD}.next` } };
  assert.deepEqual(Object.entries(JSON.parse(mergeKeys(JSON.stringify(personal), wanted).text)[SECTION]),
    [["alt-down", "agent.next"], ["alt-n", `${MOD}.next`], ...Object.entries(wanted[SECTION]).slice(1)]);
  for (const invalid of ["{", "null", "[]", JSON.stringify({ [SECTION]: "space.next" })]) assert.throws(() => mergeKeys(invalid, wanted));
});

test("both key sets bind every command the tree handles, the Mac one with cmd", async () => {
  const tree = await readFile(new URL(`mods/${MOD}/tree.js`, root), "utf8");
  const commands = [...new Set([...tree.matchAll(/command === "([a-z-]+)"/g)].map(match => `${MOD}.${match[1]}`))].sort();
  assert.equal(commands.length, 7);
  for (const keys of [wanted, mac]) assert.deepEqual([Object.keys(keys), Object.values(keys[SECTION]).sort()], [[SECTION], commands]);
  assert.ok(Object.keys(mac[SECTION]).every(key => key.startsWith("cmd-")));
});

test("the home is the one Herdr itself would use", () => {
  assert.equal(herdrHome({ HERDR_APP_HOME: "/elsewhere", XDG_CONFIG_HOME: "/xdg" }), "/elsewhere");
  assert.equal(herdrHome({ HERDR_APP_HOME: "", XDG_CONFIG_HOME: "/xdg" }), "/xdg/herdr-app");
  assert.match(herdrHome({}), /\/\.config\/herdr-app$/);
});

test("install: a home Herdr never started is refused untouched; the layout is made from main with its clicks; a second run and the user's edits change nothing", async t => {
  const home = await mkdtemp(join(tmpdir(), "herdr-project-spaces-"));
  t.after(() => rm(home, { recursive: true }));
  const text = path => readFile(join(home, path), "utf8");
  await assert.rejects(install(home), /open Herdr on this home once/);
  assert.deepEqual(await readdir(home), []);

  const stock = { global: { "alt-down": "agent.next" } }, clicks = { nodes: { sidebar: { size: { px: 340 } } } };
  await mkdir(join(home, "layouts", ".state"), { recursive: true });
  await writeFile(join(home, "layouts", "main.json"), JSON.stringify(layout));
  await writeFile(join(home, "layouts", ".state", "main.json"), JSON.stringify(clicks));
  await writeFile(join(home, "keys.json"), JSON.stringify(stock), { mode: 0o600 });
  const first = await install(home, "darwin");
  assert.deepEqual([first.mod.sort(), first.layout, first.keys], [(await readdir(new URL(`mods/${MOD}`, root))).sort(), "created", Object.keys(mac[SECTION])]);
  assert.deepEqual(JSON.parse(await text("layouts/Projects.json")), { ...replaceSpaces(layout), preview: "layouts/Projects.svg" });
  assert.deepEqual(JSON.parse(await text("layouts/.state/Projects.json")), clicks);
  assert.equal(await text("layouts/Projects.svg"), await readFile(new URL("layout-preview.svg", root), "utf8"));
  assert.equal(await text(`mods/${MOD}/main.js`), await readFile(new URL(`mods/${MOD}/main.js`, root), "utf8"));
  assert.deepEqual(JSON.parse(await text("keys.json")), { ...stock, ...mac });
  assert.deepEqual(JSON.parse(await text("layouts/main.json")), layout, "Herdr's own layout is only read");
  assert.deepEqual((await readdir(join(home, "layouts"))).sort(), [".state", "Projects.json", "Projects.svg", "main.json"], "no temporary file is left");

  // Theirs from here on: a resized sidebar in the layout, its clicks, and a key given back.
  const edited = JSON.parse(await text("layouts/Projects.json")), keys = JSON.parse(await text("keys.json"));
  edited.children[0].size.px = 400;
  keys[SECTION]["cmd-down"] = "agent.next";
  await writeFile(join(home, "layouts", "Projects.json"), JSON.stringify(edited));
  await writeFile(join(home, "layouts", ".state", "Projects.json"), "{}");
  await writeFile(join(home, "keys.json"), JSON.stringify(keys));
  await writeFile(join(home, "mods", MOD, "main.js"), "stale");
  assert.deepEqual(await install(home, "darwin"), { mod: ["main.js"], layout: "unchanged", keys: [] });
  assert.deepEqual([await text("layouts/Projects.json"), await text("layouts/.state/Projects.json"), await text("keys.json")], [JSON.stringify(edited), "{}", JSON.stringify(keys)]);

  edited.children[0].children[0].content.mod = "personal-spaces";
  await writeFile(join(home, "layouts", "Projects.json"), JSON.stringify(edited));
  await writeFile(join(home, "mods", MOD, "main.js"), "stale");
  await assert.rejects(install(home, "darwin"), /Projects\.json: expected exactly one block/);
  assert.equal(await text(`mods/${MOD}/main.js`), "stale", "a refusal comes before the first write");
});
