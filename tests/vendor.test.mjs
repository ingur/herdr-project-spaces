import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("the vendored Spaces is the recorded stock file; the mod's copy differs from it by the header and the hooks the tree overrides", async () => {
  const patched = await readFile(new URL("mods/herdr-project-spaces/stock-spaces.js", root), "utf8");
  const tree = await readFile(new URL("mods/herdr-project-spaces/tree.js", root), "utf8");
  const version = /^export const STOCK_VERSION = "([^"]+)";$/m.exec(patched)[1];
  assert.deepEqual(await readdir(new URL("vendor/", root)), [`spaces-${version}.js`]);
  const stock = await readFile(new URL(`vendor/spaces-${version}.js`, root), "utf8");
  assert.equal(createHash("sha256").update(stock).digest("hex"), /^\/\/ Original SHA-256: ([0-9a-f]{64})$/m.exec(patched)[1]);
  for (const hook of ["rowLeading", "rowTrailing", "rowDrop", "unavailableRows"]) {
    assert.ok(patched.includes(`this.${hook}?.(`), `stock no longer calls ${hook}`);
    assert.match(tree, new RegExp(`^  ${hook}\\(`, "m"), `the tree no longer defines ${hook}`);
  }
  // 4 header lines, and 8 where a hook is called: anything more is an edit that a re-vendor would lose.
  const original = new Set(stock.split("\n"));
  assert.equal(patched.split("\n").filter(line => !original.has(line)).length, 12);
});

test("the tree keeps no state under a name Herdr's Spaces code already uses", async () => {
  const { readFile } = await import("node:fs/promises");
  const names = async (file) => new Set([...(await readFile(new URL(`../mods/herdr-project-spaces/${file}`, import.meta.url), "utf8")).matchAll(/this\.([A-Za-z_]+) = /g)].map(match => match[1]));
  const [ours, stock] = [await names("tree.js"), await names("stock-spaces.js")];
  // A method of ours would be overwritten by stock's state of the same name.
  for (const match of (await readFile(new URL("../mods/herdr-project-spaces/tree.js", import.meta.url), "utf8")).matchAll(/^  (?:async )?([A-Za-z_]+)\(/gm)) ours.add(match[1]);
  // Drag state is shared on purpose: the tree's rows use stock's drop feedback.
  assert.deepEqual([...ours].filter(name => stock.has(name) && !["pressed", "over"].includes(name)), []);
});
