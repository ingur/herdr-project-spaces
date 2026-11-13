import test from "node:test";
import assert from "node:assert/strict";
import { tabRenames, displayRows, dropRank, moveRank, openSpace, projectSpaces, resolvedToggle, selectedKey, sessionDetail, sessionKey, spaceDrop, spaceItems, spaceRows, stepRow } from "../mods/herdr-project-spaces/projection.js";
import { qualify } from "../mods/herdr-project-spaces/backends.js";

const endpoint = (machine = null, stateDir = "/state") => ({ version: 1, command: ["/bin/node", "/control.mjs"], stateDir, machine });
const space = (id, tabs, extra = {}) => ({ id, name: id, machine: null, folder: "/workspace", tabs: tabs.map(id => ({ id, name: "same title", named: true })), ...extra });
const session = (id, coordinator = id, extra = {}) => {
  const record = { id, coordinator, role: id === coordinator ? "coordinator" : "thread", title: "same title", projectRoot: "/project", cwd: "/project", space: "one", rank: 0, writer: "dead", terminalOwned: false, terminalState: "not-observed", resolved: false, endpoint: endpoint(), available: true, ...extra };
  return { ...record, native: { space: qualify(record.endpoint.machine, record.space), tab: qualify(record.endpoint.machine, record.tab), terminal: qualify(record.endpoint.machine, record.terminal) } };
};
const world = { spaces: [space("one", ["tab-one"]), space("two", ["tab-two"])], panes: [], agents: [] };
const live = { terminalOwned: true, terminalState: "live", writer: "live" };

test("coordinators sharing title/cwd remain distinct by machine, backend, project and UUID", () => {
  const sessions = [session("c1"), session("c2"), session("t1", "c1"), session("t2", "c2"),
    session("c1", "c1", { projectRoot: "/another" }), session("c1", "c1", { endpoint: endpoint(null, "/other-state") }),
    session("c1", "c1", { endpoint: endpoint("remote") }), session("t1", "c1", { endpoint: endpoint("remote") })];
  const rows = projectSpaces({ ...world, sessions });
  const groups = rows.flatMap(row => row.groups);
  assert.equal(groups.length, 5);
  assert.equal(new Set(groups.map(group => group.key)).size, 5);
  assert.deepEqual(groups[0].children.map(row => row.key), [sessionKey(sessions[2])]);
  assert.deepEqual(groups[4].children.map(row => row.key), [sessionKey(sessions[7])]);
  assert.equal(groups[4].children[0].placement.id, "remote/one");
});

test("moved thread stays under owner; unrelated terminals and independent agents stay visible", () => {
  const sessions = [session("c", "c", { terminal: "t1", ...live }), session("child", "c", { terminal: "t2", tab: "tab-one", ...live })];
  const panes = [{ pane: "p1", tab: "tab-one", terminal: "t1" }, { pane: "p2", tab: "tab-two", terminal: "t2" }, { pane: "p3", tab: "tab-two", terminal: "t3", title: "same title" }];
  const agents = [{ address: "t2", tab: "tab-two", space: "two", status: "working" }, { address: "t3", tab: "tab-two", space: "two", status: "idle" }, { address: "t4", tab: "tab-two", space: "two", title: "independent", status: "idle" }];
  const before = structuredClone(agents);
  const rows = projectSpaces({ ...world, sessions, panes, agents });
  assert.equal(rows[0].groups[0].children[0].placement.id, "two");
  assert.equal(rows[0].groups[0].children[0].status, "working");
  assert.equal(rows[1].groups.length, 0);
  assert.deepEqual(rows[1].entries.map(entry => entry.terminal), ["t3", "t4"]);
  assert.deepEqual(agents, before, "native Agents input remains untouched");
});

test("resolved visibility is per project, without reopening or leaking an owned shell", () => {
  const sessions = [session("c1"), session("c2"), session("t1", "c1", { resolved: true, terminal: "t1", ...live }), session("t2", "c2", { resolved: true })];
  const panes = [{ pane: "p1", tab: "tab-one", terminal: "t1" }];
  const before = structuredClone(sessions);
  const hidden = projectSpaces({ ...world, sessions, panes })[0];
  assert.deepEqual(hidden.groups.map(group => group.children.length), [0, 0]);
  assert.deepEqual(hidden.groups.map(group => group.resolvedCount), [1, 1]);
  assert.equal(hidden.entries.length, 0);
  const visible = projectSpaces({ ...world, sessions, panes, showResolved: new Set([sessionKey(sessions[0])]) })[0];
  assert.deepEqual(visible.groups.map(group => group.children.length), [1, 0]);
  assert.equal(visible.groups[0].children[0].session.resolved, true);
  assert.deepEqual(sessions, before);
});

test("only freshly verified ownership hides or follows a terminal", () => {
  const panes = [{ pane: "shell", terminal: "t2", tab: "tab-two", title: "normal shell" }];
  for (const extra of [{}, { writer: "live" }, { ...live, available: false }, { ...live, terminalState: "finished" }]) {
    const sessions = [session("c", "c", { terminal: "t2", tab: "tab-one", ...extra })];
    const rows = projectSpaces({ ...world, sessions, panes });
    assert.equal(rows[0].groups[0].coordinator.placement.id, "one");
    assert.equal(rows[0].groups[0].coordinator.live, false);
    assert.equal(rows[1].entries[0].terminal, "t2");
  }
});

// Space one: a project with a live and a stopped thread, then a shell. Space two: a shell.
function tree({ focused = null, active = "one", threadTab = "tab-one", status = {} } = {}) {
  const sessions = [session("c", "c", { terminal: "t1", ...live }), session("a", "c", { terminal: "t2", ...live }), session("b", "c")];
  const panes = [["t1", "tab-one"], ["t2", threadTab], ["t3", "tab-one"], ["t4", "tab-two"]].map(([terminal, tab]) =>
    ({ pane: `p-${terminal}`, terminal, tab, program: { key: terminal }, status: status[terminal] ?? null, focused: terminal === focused }));
  const spaces = [space("one", ["tab-one"]), space("two", ["tab-two"])].map(row => ({ ...row, active: row.id === active }));
  return projectSpaces({ spaces, panes, agents: [], sessions });
}
const [c, a, b] = ["c", "a", "b"].map(id => sessionKey(session(id, "c")));

test("one row is selected: the focused row, its nearest visible ancestor, else the active space", () => {
  const project = `project:${c}`;
  assert.equal(selectedKey(tree({ focused: "t2" }), new Set()), a);
  assert.equal(selectedKey(tree({ focused: "t2" }), new Set([project])), c);
  assert.equal(selectedKey(tree({ focused: "t2" }), new Set([project, "space:one"])), "space:one");
  assert.equal(selectedKey(tree({ focused: "t1" }), new Set([project])), c);
  assert.equal(selectedKey(tree({ focused: "t3" }), new Set([project])), "t3");
  assert.equal(selectedKey(tree({ focused: "t3" }), new Set(["space:one"])), "space:one");
  assert.equal(selectedKey(tree(), new Set()), "space:one");
  // A thread moved to another space is still drawn, and selected, under its project.
  const moved = { focused: "t2", active: "two", threadTab: "tab-two" };
  assert.equal(selectedKey(tree(moved), new Set()), a);
  assert.equal(selectedKey(tree(moved), new Set(["space:one"])), "space:one");
});

test("keys step through the visible rows in display order, skipping folds and stopped sessions, wrapping", () => {
  const rows = tree(), visible = list => list.filter(item => item.shown === item.row.key).map(item => item.row.key);
  const open = displayRows(rows, new Set());
  assert.deepEqual(visible(open), [c, a, b, "t3", "t4"]);
  assert.equal(stepRow(open, a, 1).key, "t3", "a stopped session is passed over: a key never relaunches it");
  assert.equal(stepRow(open, "t3", -1).key, a);
  assert.equal(stepRow(open, b, 1).key, "t3");
  assert.equal(stepRow(open, "t4", 1).key, c);
  assert.equal(stepRow(open, c, -1).key, "t4");
  assert.equal(stepRow(open, null, 1).key, c);
  assert.equal(stepRow(open, null, -1).key, "t4");
  const folded = displayRows(rows, new Set([`project:${c}`, "space:two"]));
  assert.deepEqual(visible(folded), [c, "t3"]);
  assert.equal(stepRow(folded, a, 1).key, "t3", "a folded-away row steps from where it would be");
  assert.equal(stepRow(folded, a, -1).key, c);
  assert.equal(stepRow(folded, "t4", 1).key, c);
  assert.equal(stepRow(displayRows(rows, new Set(["space:one", "space:two"])), a, 1), null);
  assert.equal(stepRow(displayRows(rows.slice(1), new Set()), "t4", 1), null, "the only visible row has no other to step to");
});

// Space one: project p1 (rank 10) with open threads old (1) and new (5) and resolved threads done (9)
// and older (2); project p2 (30); a thread whose project is gone; shells t7 (made at 20), t8 (made at 1,
// dragged to 40) and t9 (unknown to hc); a mod pane. Space two: shell t6.
const key = id => sessionKey(session(id));
function ranked() {
  const sessions = [session("p1", "p1", { rank: 10 }), session("old", "p1", { rank: 1 }), session("done", "p1", { rank: 9, resolved: true }),
    session("new", "p1", { rank: 5 }), session("older", "p1", { rank: 2, resolved: true }), session("p2", "p2", { rank: 30 }), session("other", "p2", { rank: 3 }),
    session("orphan", "gone", { rank: 4 })];
  const panes = [["t7", "tab-one"], ["t8", "tab-one"], ["t9", "tab-one"], [null, "tab-one"], ["t6", "tab-two"]].map(([terminal, tab], n) => ({ pane: `p${n}`, terminal, tab }));
  const terminals = [{ address: "t7", created_ms: 20 }, { address: "t8", created_ms: 1, labels: { "projects.rank": "40" } }, { address: "t6", created_ms: 50, labels: { "projects.rank": "soon" } }];
  return projectSpaces({ ...world, panes, sessions, terminals, showResolved: new Set([key("p1")]) });
}

test("rows show highest rank first: open threads above resolved ones, projects and independent rows mixed", () => {
  const [one, two] = ranked(), name = row => row && (row.session?.id ?? row.key);
  assert.deepEqual(spaceItems(one).map(item => item.key), ["t8", key("p2"), "t7", key("p1"), "t9", "pane:p3"]);
  assert.deepEqual(one.groups[0].children.map(name), ["new", "old", "done", "older"]);
  assert.equal(two.entries[0].rank, 50, "a label that is no number leaves the terminal's creation time");
  assert.deepEqual(spaceRows(one).map(name), ["t8", "p2", "other", "t7", "p1", "new", "old", "done", "older", "t9", "pane:p3"]);
  assert.deepEqual(displayRows([one, two], new Set()).map(item => name(item.row)),
    ["t8", "p2", "other", "t7", "p1", "new", "old", "done", "older", "t9", "pane:p3", "t6"]);
});

test("a drop takes a rank between its new neighbours, only among the rows it may trade places with", () => {
  const rows = ranked();
  // Dragged up, a row lands before the row it is dropped on; dragged down, after it.
  assert.deepEqual(dropRank(rows, key("old"), key("new")), { after: false, rank: 1005 });
  assert.deepEqual(dropRank(rows, key("new"), key("old")), { after: true, rank: -999 });
  assert.deepEqual(dropRank(rows, key("older"), key("done")), { after: false, rank: 1009 });
  assert.deepEqual(dropRank(rows, key("p1"), key("p2")), { after: false, rank: 35 });
  assert.deepEqual(dropRank(rows, "t8", "t7"), { after: true, rank: 15 });
  assert.deepEqual(dropRank(rows, "t7", "pane:p3"), { after: true, rank: -1000 });
  assert.deepEqual(dropRank(rows, "t9", "t8"), { after: false, rank: 1040 });
  const refused = [
    [key("new"), key("done")], // an open thread among resolved ones
    [key("new"), key("other")], // another project's thread
    [key("new"), key("p1")], [key("new"), "t7"], [key("p1"), key("new")], // a thread among its space's rows, and back
    ["t7", "t6"], [key("p1"), "t6"], // another space
    ["t7", "t7"], ["t7", "nowhere"], ["nowhere", "t7"],
    ["pane:p3", "t7"], [key("gone"), key("p1")], // no terminal or session to keep a rank
  ];
  for (const [from, over] of refused) assert.equal(dropRank(rows, from, over), null, `${from} on ${over}`);
});

test("the move keys trade places with the neighbour a drag could reach; nothing moves past either end", () => {
  const rows = ranked();
  assert.equal(moveRank(rows, key("old"), -1), 1005);
  assert.equal(moveRank(rows, key("new"), 1), -999);
  assert.equal(moveRank(rows, key("older"), -1), 1009);
  assert.equal(moveRank(rows, key("p1"), -1), 25);
  assert.equal(moveRank(rows, "t8", 1), 25);
  assert.equal(moveRank(rows, "t7", -1), 35);
  const still = [
    [key("new"), -1], [key("old"), 1], [key("done"), -1], [key("older"), 1], // the ends of the open and of the resolved threads
    ["t8", -1], ["t6", 1], ["t6", -1], // the ends of a space
    ["pane:p3", -1], [key("gone"), 1], ["space:one", 1], ["nowhere", 1], [null, -1], // no row that moves
  ];
  for (const [selected, direction] of still) assert.equal(moveRank(rows, selected, direction), null, `${selected} ${direction}`);
});

test("a resolved project hides with all its threads until its space shows them, and still owns its terminal", () => {
  const sessions = [session("open"), session("done", "done", { resolved: true, terminal: "t1", ...live }), session("child", "done")];
  const panes = [{ pane: "p1", tab: "tab-one", terminal: "t1" }];
  const [one] = projectSpaces({ ...world, sessions, panes });
  assert.deepEqual([one.groups.map(group => group.key), one.resolvedCount, one.entries], [[key("open")], 1, []]);
  const [shown] = projectSpaces({ ...world, sessions, panes, showResolved: new Set(["space:one"]) });
  assert.deepEqual(shown.groups.map(group => [group.key, group.children.length]), [[key("open"), 0], [key("done"), 1]]);
});

test("the resolved key toggles the level the selection is on, or the view that hides the focused session", () => {
  const sessions = [session("p"), session("a", "p"), session("old", "p", { resolved: true, terminal: "t1", ...live }),
    session("done", "done", { resolved: true }), session("b", "done", { terminal: "t2", ...live })];
  const rows = focused => projectSpaces({ ...world, sessions, panes: [["t1", "tab-one"], ["t2", "tab-one"], ["t3", "tab-two"]].map(([terminal, tab]) =>
    ({ pane: `p-${terminal}`, terminal, tab, focused: terminal === focused })) });
  assert.equal(resolvedToggle(rows(), key("a")), key("p"));
  assert.equal(resolvedToggle(rows(), key("p")), key("p"));
  assert.equal(resolvedToggle(rows(), "space:one"), "space:one");
  assert.equal(resolvedToggle(rows(), "t3"), "space:two", "an independent row is on its space's level");
  assert.equal(resolvedToggle(rows(), "nowhere"), null);
  // No row stands in for a hidden session, so the selection is the active space: not where the person is.
  assert.equal(resolvedToggle(rows("t1"), "space:two"), key("p"), "a resolved thread is brought back by its project's view");
  assert.equal(resolvedToggle(rows("t2"), "space:two"), "space:one", "a thread of a resolved project by its space's view");
});

test("gone local projects disappear; unreachable and loading spaces keep their existing rows", () => {
  const sessions = [session("home"), session("stray", "home", { space: "gone" }), session("lost", "lost", { space: "gone", tab: "tab-one" }),
    session("child", "lost"), session("other", "other", { space: "gone-too", resolved: true }), session("orphan", "absent"),
    session("far", "far", { space: "gone", endpoint: endpoint("remote"), available: false })];
  const project = options => projectSpaces({ ...world, sessions, ...options });
  const rows = options => project(options).map(row => [row.key, row.missing, row.groups.length, row.resolvedCount]);
  assert.deepEqual(rows({}), [["one", false, 1, 0], ["two", false, 0, 0], ["remote/gone", true, 1, 0]]);
  assert.deepEqual(rows({ ready: false }), [["one", false, 1, 0], ["two", false, 0, 0], ["gone", true, 1, 0], ["gone-too", true, 0, 1], ["remote/gone", true, 1, 0]]);
  assert.equal(project({})[2].space.name, "Unavailable space");
  assert.equal(project({ ready: false })[2].space.name, "Unavailable space");
  assert.deepEqual(displayRows(project({}), new Set()).map(item => item.row.session.id), ["home", "stray", "far"]);
  assert.equal(resolvedToggle(project({}), key("lost")), null);
  assert.equal(selectedKey(project({}), new Set()), null);
  assert.equal(stepRow(displayRows(project({}), new Set()), null, 1), null);
});

test("stopped threads follow their project's current space, never their stale space or tab", () => {
  const spaces = [space("one", ["tab-one"]), space("two", ["tab-two"], { active: true }), space("remote/one", ["remote/tab"], { machine: "remote" })];
  const remote = { endpoint: endpoint("remote") };
  const sessions = [session("home", "home", { space: "two", tab: "tab-one" }), session("strayed", "home", { space: "gone", tab: "tab-one" }),
    session("running", "home", { terminal: "t1", ...live }), session("moved", "moved", { terminal: "t2", ...live }), session("follows", "moved"),
    session("far", "far", remote), session("near", "far", { ...remote, space: "gone" }), session("away", "away", { ...remote, space: "gone" })];
  const panes = [{ pane: "p1", tab: "tab-one", terminal: "t1" }, { pane: "p2", tab: "tab-two", terminal: "t2" }];
  const rows = projectSpaces({ spaces, panes, agents: [], sessions });
  const opens = (id, extra) => openSpace(rows, sessionKey(session(id, id, extra)));
  const home = rows[1].groups[0];
  assert.equal(home.children[0].placement.id, "two");
  assert.equal(home.children[1].placement.id, "one", "a running thread keeps its terminal's placement under its project");
  for (const id of ["home", "strayed", "follows"]) assert.deepEqual(opens(id), { space: "two" }, id);
  for (const id of ["far", "near"]) assert.deepEqual(opens(id, remote), { space: "one" }, `${id}: an id as its own machine knows it`);
  for (const id of ["running", "moved", "nowhere"]) assert.deepEqual(opens(id), {}, id);
  assert.deepEqual(opens("away", remote), {}, "another machine's space may only be out of reach");
});

test("only a project is dropped on a space: by its head, on another space of its own machine", () => {
  const spaces = [...world.spaces, space("remote/one", [], { machine: "remote" })];
  const sessions = [session("home"), session("thread", "home"), session("lost", "lost", { space: "gone" }), session("running", "running", { terminal: "t1", ...live }),
    session("far", "far", { space: "gone", endpoint: endpoint("remote") })];
  const rows = projectSpaces({ spaces, panes: [{ pane: "p1", tab: "tab-one", terminal: "t1" }, { pane: "p2", tab: "tab-one", terminal: "t2" }], agents: [], sessions });
  const far = sessionKey(sessions[4]);
  for (const [from, to] of [[key("home"), "two"], [far, "remote/one"]]) assert.equal(spaceDrop(rows, from, to)?.key, from, `${from} on ${to}`);
  assert.equal(spaceDrop(rows, key("running"), "two").live, true, "one that runs is the caller's to refuse");
  const refused = [
    [key("home"), "one"], // where it is
    [key("thread"), "two"], ["t2", "two"], // a thread goes with its project, a terminal is where it is
    [key("home"), "remote/one"], [far, "one"], // another machine
    [key("lost"), "one"], [key("home"), "remote/gone"], [key("home"), "nowhere"], [null, "two"],
  ];
  for (const [from, to] of refused) assert.equal(spaceDrop(rows, from, to), null, `${from} on ${to}`);
});

test("a session's hover line is its folder, then only what its row does not show", () => {
  const line = (session, live = true, placement = "one") => sessionDetail({ session: { cwd: "/project", available: true, ...session }, live, placement: { id: placement, name: placement } }, { id: "one" }).split(" · ");
  assert.deepEqual(line({}), ["/project"], "running, open and in its project's space: nothing to add");
  assert.equal(line({ resolved: true }, false).length, 3, "resolved and stopped both dim the row");
  assert.equal(line({ available: false }, false).length, 2, "out of reach is not called stopped");
  assert.match(line({}, true, "two")[1], /two$/, "a terminal running in another space names it");
});

test("a synced tab rename requests one human session rename, even while control is pending or failed", () => {
  for (const id of ["project", "thread"]) {
    const record = session(id, "project", { title: "Before", terminal: "t1", ...live });
    const panes = [{ terminal: "t1", tab: "a" }], applied = new Map();
    const tab = { id: "a", name: "1", named: false, panes: 1 };
    const sync = (current = record) => tabRenames([current], panes, [tab], applied);
    assert.deepEqual(sync(), [{ id: "a", name: "Before" }]);
    Object.assign(tab, { name: "Changed before sync was seen", named: true });
    assert.deepEqual(sync(), [], "requesting a tab title alone is not evidence that the tab showed it");
    Object.assign(tab, { name: "Before", named: true });
    assert.deepEqual(sync(), []);
    tab.name = "Human name";
    assert.deepEqual(sync(), [{ session: record, title: "Human name" }]);
    assert.deepEqual(sync(), [], "a stale session snapshot neither repeats the request nor restores the old tab name");
    assert.deepEqual(sync({ ...record, title: "Human name" }), [], "control's acknowledgement does not bounce back");
  }
});

test("a session renamed elsewhere renames its synced tab", () => {
  const record = session("x", "x", { title: "Before", terminal: "t1", ...live });
  const panes = [{ terminal: "t1", tab: "a" }], applied = new Map();
  const tab = { id: "a", name: "1", named: false, panes: 1 };
  tabRenames([record], panes, [tab], applied);
  Object.assign(tab, { name: "Before", named: true });
  tabRenames([record], panes, [tab], applied);
  assert.deepEqual(tabRenames([{ ...record, title: "Elsewhere" }], panes, [tab], applied), [{ id: "a", name: "Elsewhere" }]);
});

test("an unsynced named tab stays untouched, including a session moved to another named tab", () => {
  const record = session("x", "x", { title: "Session", terminal: "t1", ...live });
  const applied = new Map(), panes = [{ terminal: "t1", tab: "a" }];
  const tab = { id: "a", name: "Mine", named: true, panes: 1 };
  assert.deepEqual(tabRenames([record], panes, [tab], applied), []);
  tab.name = "Still mine";
  assert.deepEqual(tabRenames([record], panes, [tab], applied), []);
  tab.name = record.title;
  assert.deepEqual(tabRenames([record], panes, [tab], applied), []);
  tabRenames([record], [{ terminal: "t1", tab: "b" }], [{ id: "b", name: "1", named: false, panes: 1 }], applied);
  assert.deepEqual(tabRenames([record], panes, [tab], applied), []);
});

test("multi-pane tabs and terminals the session does not own never rename sessions", () => {
  const record = session("x", "x", { title: "Session", terminal: "t1", ...live });
  const applied = new Map(), panes = [{ terminal: "t1", tab: "a" }];
  const tab = { id: "a", name: "1", named: false, panes: 1 };
  tabRenames([record], panes, [tab], applied);
  Object.assign(tab, { name: "Session", named: true });
  tabRenames([record], panes, [tab], applied);
  Object.assign(tab, { name: "Split name", panes: 2 });
  assert.deepEqual(tabRenames([record], [...panes, { terminal: "t2", tab: "a" }], [tab], applied), []);
  tab.panes = 1;
  for (const extra of [{ available: false }, { terminalOwned: false }, { terminalState: "finished" }]) {
    assert.deepEqual(tabRenames([{ ...record, ...extra }], panes, [tab], applied), []);
  }
});

test("a tab's name names its only pane; a split beside it is named by what runs there", () => {
  const named = (panes) => [{ id: "one", name: "one", machine: null, folder: "/w", tabs: [{ id: "tab", name: "My thread", named: true, panes }] }];
  const panes = [{ pane: "p1", terminal: "t1", tab: "tab", title: "t1" }, { pane: "p2", terminal: "t2", tab: "tab", title: "t2" }];
  const terminals = [{ address: "t1", argv: ["/bin/zsh"] }, { address: "t2", argv: ["/usr/bin/nvim"] }];
  const titles = (spaces, shown) => projectSpaces({ spaces, panes: shown, agents: [], sessions: [], terminals })[0].entries.map(entry => entry.title);
  assert.deepEqual(titles(named(1), panes.slice(0, 1)), ["My thread"]);
  assert.deepEqual(titles(named(2), panes).sort(), ["nvim", "zsh"]);
});

test("a tab gets its number back when its session leaves and a split stays behind", () => {
  const live = { id: "x", title: "Thread", projectRoot: "/p", endpoint: { machine: null, stateDir: "/s" }, available: true, terminalOwned: true, terminalState: "live", native: { terminal: "t1" } };
  const applied = new Map();
  assert.deepEqual(tabRenames([live], [{ terminal: "t1", tab: "a" }], [{ id: "a", named: false, name: "1", panes: 1 }], applied), [{ id: "a", name: "Thread" }]);
  const split = [{ id: "a", named: true, name: "Thread", panes: 2 }];
  assert.deepEqual(tabRenames([live], [{ terminal: "t1", tab: "a" }, { terminal: "t2", tab: "a" }], split, applied), []);
  const left = [{ id: "a", named: true, name: "Thread", panes: 1 }];
  assert.deepEqual(tabRenames([], [{ terminal: "t2", tab: "a" }], left, applied), [{ id: "a", name: "" }]);
  assert.deepEqual(tabRenames([], [{ terminal: "t2", tab: "a" }], left, applied), [], "only once, and never a name someone gave");
});

test("a tab already showing the title after a reload is synced, so renaming it renames the session", () => {
  const live = { id: "x", title: "Docs", projectRoot: "/p", endpoint: { machine: null, stateDir: "/s" }, available: true, terminalOwned: true, terminalState: "live", native: { terminal: "t1" } };
  const panes = [{ terminal: "t1", tab: "a" }], applied = new Map();
  assert.deepEqual(tabRenames([live], panes, [{ id: "a", named: true, name: "Docs", panes: 1 }], applied), []);
  const renames = tabRenames([live], panes, [{ id: "a", named: true, name: "API docs", panes: 1 }], applied);
  assert.deepEqual(renames.map(rename => [rename.session?.id, rename.title]), [["x", "API docs"]]);
});
