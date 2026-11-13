#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAME = "herdr-project-spaces";
// The settings picker prints the layout file's name as is, in a narrow card.
const LAYOUT = "Projects";
const HELP = `Usage: node install.mjs [--home <Herdr home>]

Adds the Projects sidebar to a Herdr home, by files alone:
  mods/${NAME}/   the mod; only files that differ are replaced
  layouts/${LAYOUT}.json        made once from your main layout, with its sizes and theme,
                               its Spaces block showing the mod; your later edits are kept
  keys.json                    section "layout:${LAYOUT}": only keys you have not bound or moved

Home: --home, else $HERDR_APP_HOME, else $XDG_CONFIG_HOME/herdr-app, else ~/.config/herdr-app
(as Herdr itself chooses). Needs Herdr to have started once on that home, which writes
layouts/main.json and keys.json. Herdr may be running or not: it applies changed files as they
land. Nothing is started, stopped or switched. Run again after updating this folder.`;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Herdr's own choice of home (herdr-app src/mods.rs `app_dir`), on every OS.
export const herdrHome = (env = process.env) =>
  env.HERDR_APP_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr-app");

// `layout` with its one Spaces block showing this mod: nothing else of it changes. Refused unless
// exactly one block shows Herdr's own Spaces (or this mod already): another panel is not replaced.
export function replaceSpaces(layout) {
  const next = structuredClone(layout), matches = [];
  (function visit(node) {
    if (node.type === "block" && ["spaces", NAME].includes(node.content?.mod)) matches.push(node);
    for (const child of node.children ?? []) visit(child);
  })(next);
  if (matches.length !== 1) throw new Error(`expected exactly one block showing Herdr's own "spaces" mod, found ${matches.length}; left unchanged.`);
  matches[0].content.mod = NAME;
  return next;
}

// The user's keys.json `text` with `wanted`'s sections merged in: `{ text, added }`, or null when
// nothing is missing. A key is added only where neither it nor its action is bound in that section
// yet, so what the user bound there or moved to another key stays theirs.
export function mergeKeys(text, wanted) {
  const keys = JSON.parse(text), added = [];
  if (!isObject(keys)) throw new Error("expected an object of key sections; left unchanged.");
  for (const [section, bindings] of Object.entries(wanted)) {
    const mine = keys[section] ?? {};
    if (!isObject(mine)) throw new Error(`section "${section}" is not an object; left unchanged.`);
    const missing = Object.entries(bindings).filter(([key, action]) => !Object.hasOwn(mine, key) && !Object.values(mine).includes(action));
    if (missing.length) keys[section] = { ...mine, ...Object.fromEntries(missing) };
    added.push(...missing.map(([key]) => key));
  }
  return added.length ? { text: `${JSON.stringify(keys, null, 2)}\n`, added } : null;
}

async function optionalText(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Whether `path` had to change to hold `contents`. Written beside it under a hidden name (Herdr
// watches these folders and skips hidden files), then renamed over it: never half a file.
async function updateFile(path, contents) {
  const bytes = Buffer.from(contents);
  let mode = 0o644;
  try {
    if ((await readFile(path)).equals(bytes)) return false;
    mode = (await stat(path)).mode & 0o777;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(dirname(path), `.${basename(path)}.install-${process.pid}`);
  await writeFile(temporary, bytes, { flag: "wx", mode });
  await rename(temporary, path);
  return true;
}

function parsed(path, text, read) {
  try { return read(text); }
  catch (error) { throw new Error(`${path}: ${error.message}`); }
}

// Installs or updates into `home`; every refusal happens before the first write. Returns what changed.
export async function install(home, platform = process.platform) {
  const source = dirname(fileURLToPath(import.meta.url));
  const layouts = join(home, "layouts"), layoutPath = join(layouts, `${LAYOUT}.json`), keysPath = join(home, "keys.json");
  const [existing, main, keysText] = await Promise.all([layoutPath, join(layouts, "main.json"), keysPath].map(optionalText));
  // Never created here: Herdr installs its default keys and layouts only while they are absent.
  if (keysText === null || (existing ?? main) === null) throw new Error(`${home} has no layouts/main.json and keys.json yet. Herdr writes them at its first start: open Herdr on this home once, then run this again.`);

  const layout = existing === null
    ? parsed(join(layouts, "main.json"), main, text => replaceSpaces({ ...JSON.parse(text), preview: `layouts/${LAYOUT}.svg` }))
    : parsed(layoutPath, existing, text => { const current = JSON.parse(text), next = replaceSpaces(current); return JSON.stringify(next) === JSON.stringify(current) ? null : next; });
  const wanted = JSON.parse(await readFile(join(source, platform === "darwin" ? "keys.macos.json" : "keys.json"), "utf8"));
  const keys = parsed(keysPath, keysText, text => mergeKeys(text, wanted));

  const mod = [];
  await mkdir(join(home, "mods", NAME), { recursive: true });
  for (const name of await readdir(join(source, "mods", NAME))) {
    if (await updateFile(join(home, "mods", NAME, name), await readFile(join(source, "mods", NAME, name)))) mod.push(name);
  }
  await updateFile(join(layouts, `${LAYOUT}.svg`), await readFile(join(source, "layout-preview.svg")));
  if (existing === null) {
    // As Herdr's own layout.clone: the clicks on main (sizes, what is hidden, the theme pick) come along.
    const clicks = await optionalText(join(layouts, ".state", "main.json"));
    if (clicks !== null) await updateFile(join(layouts, ".state", `${LAYOUT}.json`), clicks);
  }
  if (layout) await updateFile(layoutPath, `${JSON.stringify(layout, null, 2)}\n`);
  if (keys) await updateFile(keysPath, keys.text);
  return { mod, layout: existing === null ? "created" : layout ? "updated" : "unchanged", keys: keys?.added ?? [] };
}

const quote = text => `'${text.replaceAll("'", `'\\''`)}'`;

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(HELP); return; }
  if (args.length && (args.length !== 2 || args[0] !== "--home" || !args[1])) throw new Error(HELP);
  const home = resolve(args[1] ?? herdrHome());
  const result = await install(home);
  // Commands for a home Herdr would not pick with a clean environment name it.
  const env = home === resolve(herdrHome({ XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME })) ? "" : `HERDR_APP_HOME=${quote(home)} `;
  const layouts = join(home, "layouts");
  console.log(`${NAME} in ${home}
  mod     mods/${NAME}: ${result.mod.length ? `updated ${result.mod.join(", ")}` : "unchanged"}
  layout  layouts/${LAYOUT}.json: ${{ created: "made from main, its Spaces block showing the mod", updated: "its Spaces block now shows the mod", unchanged: "unchanged" }[result.layout]}
  keys    keys.json "layout:${LAYOUT}": ${result.keys.length ? `added ${result.keys.join(", ")}
          (Herdr updates the default shortcuts only of a keys.json nobody edited: from now on, new ones are yours to add.)` : "unchanged"}
Herdr applies these files as they land, or at its next start. Nothing was started, stopped or switched.
Show it:   ${process.platform === "darwin" ? "cmd" : "ctrl"}-shift-l cycles layouts, or: ${env}herdr-app do layout.switch '{"name":"${LAYOUT}"}'
Check:     ${env}herdr-app check ${quote(join(home, "mods", NAME))}
Update:    run this again from the updated folder.
Uninstall: switch to another layout, then
           rm -r ${quote(join(home, "mods", NAME))}
           rm -f ${[`${LAYOUT}.json`, `${LAYOUT}.svg`, join(".state", `${LAYOUT}.json`)].map(name => quote(join(layouts, name))).join(" ")}
           and delete the "layout:${LAYOUT}" section from ${quote(join(home, "keys.json"))} (without the layout it does nothing).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`${NAME}: ${error.message}`); process.exitCode = 1; });
}
