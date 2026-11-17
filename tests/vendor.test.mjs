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
  // 4 header lines, 8 where a hook is called, 1 that names the list: anything more is an edit that a re-vendor would lose.
  const original = new Set(stock.split("\n"));
  assert.equal(patched.split("\n").filter(line => !original.has(line)).length, 13);
});

test("the tree uses no name Herdr's Spaces code already uses, for state or a method, beyond what it overrides on purpose", async () => {
  // Every `this.x = ` and every method: stock's state would overwrite a method of ours, and a method of ours would replace stock's.
  const names = async file => {
    const text = await readFile(new URL(`mods/herdr-project-spaces/${file}`, root), "utf8");
    return new Set([...text.matchAll(/this\.([A-Za-z_]+) = /g), ...text.matchAll(/^  (?:async )?([A-Za-z_]+)\(/gm)].map(match => match[1]));
  };
  const [ours, stock] = [await names("tree.js"), await names("stock-spaces.js")];
  // Drag state is shared so the tree's rows use stock's drop feedback; init and the methods RECIPE.md lists are overridden on purpose.
  const shared = ["pressed", "over", "init", "ordered", "row", "compact", "render"];
  assert.deepEqual([...ours].filter(name => stock.has(name) && !shared.includes(name)), []);
});
