import test from "node:test";
import assert from "node:assert/strict";
import { deletion, performSessionAction, sessionMenu } from "../mods/herdr-project-spaces/actions.js";

const endpoint = { version: 2, command: ["/runtime", "/control"], stateDir: "/state", machine: "buildbox" };
const record = { id: "project", coordinator: "project", role: "coordinator", title: "Project", cwd: "/project", space: "s1", tab: "tab1", terminal: "t1", state: "running", status: "idle", waiting: 0, resolved: false, rank: 1 };
const child = { ...record, id: "thread", coordinator: "project", role: "thread", title: "New thread", terminal: "t2", tab: "tab2" };
const pane = { pane: "buildbox/p2", terminal: "buildbox/t2", tab: "buildbox/tab2" };
function harness(respond, visible = [pane]) {
  const calls = [], commands = [];
  return { calls, commands, io: {
    authorize: () => {},
    exec: async (command, args, options) => {
      const action = args[1], input = JSON.parse(args[2]);
      calls.push({ command, action, input, options });
      return { code: 0, stdout: JSON.stringify(await respond(action, input)), stderr: "" };
    },
    panes: () => visible,
    tabs: () => [{ id: pane.tab, named: true, name: "The user's tab name" }],
    run: (name, args) => commands.push([name, args]),
    pause: async () => {},
  } };
}

test("project plus creates an unnamed child, which comes with its terminal, then verifies and focuses its exact native pane", async () => {
  const { io, calls, commands } = harness(() => child);
  await performSessionAction(endpoint, "create-thread", record, {}, io);
  assert.deepEqual(calls.map(call => call.action), ["create-thread"]);
  assert.deepEqual(calls[0].input, { coordinator: "project", by: "user", stateDir: "/state" });
  assert.ok(calls.every(call => call.options.on === "buildbox"));
  assert.deepEqual(commands, [["tab.rename", { id: "buildbox/tab2", name: "New thread" }], ["tab.select", { id: "buildbox/tab2" }], ["pane.focus", { pane: "buildbox/p2" }]]);
});

test("opening a resolved thread preserves archive state and manually chosen tab names", async () => {
  const { io, calls, commands } = harness(() => ({ ...child, resolved: true }));
  const result = await performSessionAction(endpoint, "open", { ...child, resolved: true }, {}, io);
  assert.equal(result.resolved, true);
  assert.deepEqual(calls.map(call => call.action), ["open"]);
  assert.deepEqual(commands.map(command => command[0]), ["tab.select", "pane.focus"]);
});

test("resolve and close do not focus, reopen or kill unrelated native panes", async () => {
  for (const action of ["resolve", "close"]) {
    const { io, calls, commands } = harness(() => ({ ...child, resolved: true }));
    await performSessionAction(endpoint, action, child, {}, io);
    assert.deepEqual(calls.map(call => call.action), [action]);
    assert.equal(calls[0].input.id, "thread");
    assert.deepEqual(commands, []);
  }
});

test("rename updates only a verified current terminal's tab", async () => {
  const { io, calls, commands } = harness(() => ({ ...child, title: "New name" }));
  const titles = [];
  io.tabRenamed = (...args) => titles.push(args);
  await performSessionAction(endpoint, "rename", child, { title: "New name" }, io);
  assert.equal(calls[0].input.title, "New name");
  assert.deepEqual(commands, [["tab.rename", { id: "buildbox/tab2", name: "New name" }]]);
  assert.deepEqual(titles, [[endpoint, { ...child, title: "New name" }, pane.tab]]);
  const stopped = harness(() => ({ ...child, title: "Saved", state: "stopped" }));
  await performSessionAction(endpoint, "rename", child, { title: "Saved" }, stopped.io);
  assert.deepEqual(stopped.commands, []);
});

test("a rename goes through control as the user's; failure leaves the user's tab untouched", async () => {
  const saved = harness(() => ({ ...child, title: "User name" }));
  await performSessionAction(endpoint, "rename", child, { title: "User name" }, saved.io);
  assert.deepEqual(saved.calls[0].input, { title: "User name", id: "thread", by: "user", stateDir: "/state" });
  const failed = harness(() => { throw new Error("Rename refused"); });
  await assert.rejects(performSessionAction(endpoint, "rename", child, { title: "User name" }, failed.io), /Rename refused/);
  assert.deepEqual(failed.commands, []);
});

test("uncertain or mismatched identity never drives native focus", async () => {
  for (const response of [{ ...child, state: "stopped" }, { ...child, state: "starting", terminal: null }, { ...child, state: undefined }, { ...child, id: "unrelated" }]) {
    const { io, commands } = harness(() => response);
    await assert.rejects(performSessionAction(endpoint, "open", child, {}, io));
    assert.deepEqual(commands, []);
  }
  const absent = harness(() => child, []);
  await assert.rejects(performSessionAction(endpoint, "open", child, {}, absent.io), /native pane is not available/);
  assert.deepEqual(absent.commands, []);
});

test("every command is authorized first; a refused route runs nothing", async () => {
  const { io, calls } = harness(() => child);
  const asked = [];
  io.authorize = route => asked.push(route);
  await performSessionAction(endpoint, "create-thread", record, {}, io);
  assert.deepEqual([asked, calls.map(call => call.action)], [[endpoint], ["create-thread"]]);
  calls.length = 0;
  io.authorize = () => { throw new Error("This session's control command changed"); };
  await assert.rejects(performSessionAction(endpoint, "rename", child, { title: "Late rename" }, io), /command changed/);
  assert.deepEqual(calls, []);
});

test("a created thread without a terminal is opened, and remains a success when its first focus is not ready", async () => {
  const { io, calls, commands } = harness(action => {
    if (action === "open") throw new Error("Still starting");
    return { ...child, state: "stopped", terminal: undefined };
  });
  const result = await performSessionAction(endpoint, "create-thread", record, {}, io);
  assert.equal(result.id, child.id);
  assert.match(result.focusError, /Still starting/);
  assert.deepEqual(calls.map(call => call.action), ["create-thread", "open"]);
  assert.deepEqual(commands, []);
});

test("delete goes through control alone; a deletion control did not confirm is an error, and so is control's own", async () => {
  const { io, calls, commands } = harness(() => ({ deleted: ["thread", "project"] }));
  assert.deepEqual(await performSessionAction(endpoint, "delete", record, {}, io), { deleted: ["thread", "project"] });
  assert.deepEqual(calls.map(call => [call.action, call.input]), [["delete", { id: "project", stateDir: "/state" }]]);
  assert.deepEqual(commands, []);
  for (const response of [{ deleted: [] }, { deleted: ["thread"] }, record]) {
    const unconfirmed = harness(() => response);
    await assert.rejects(performSessionAction(endpoint, "delete", record, {}, unconfirmed.io), /did not confirm/);
  }
  const failed = harness(() => record);
  failed.io.exec = async () => ({ code: 1, stdout: "", stderr: "projects: a conversation was not removed; already deleted: thread\n" });
  await assert.rejects(performSessionAction(endpoint, "delete", record, {}, failed.io), /already deleted: thread/);
});

test("the menu closes only a running terminal of the session's own and resolves only what is open; a project's deletion counts its threads", () => {
  const actions = extra => sessionMenu({ ...record, ...extra }).map(item => item.action);
  assert.deepEqual(actions({}), ["rename", "open", "close", "resolve", "delete"]);
  assert.deepEqual(actions({ state: "starting" }), ["rename", "open", "close", "resolve", "delete"]);
  assert.deepEqual(actions({ state: "stopped", resolved: true }), ["rename", "open", "delete"]);
  assert.match(deletion(record, [record, child, { ...child, id: "other" }, { ...child, coordinator: "elsewhere" }]).detail, /\b2\b/);
});

test("open and place hand their space to control, which alone places", async () => {
  const shown = harness(() => ({ ...child, state: "starting" }));
  await performSessionAction(endpoint, "open", { ...child, state: "stopped" }, { space: "s2" }, shown.io);
  assert.deepEqual(shown.calls.map(call => [call.action, call.input]), [["open", { space: "s2", id: "thread", stateDir: "/state" }]]);
  assert.deepEqual(shown.commands.map(command => command[0]), ["tab.select", "pane.focus"], "no space is made and no tab closed");
  const placed = harness(() => ({ ...record, space: "s2" }));
  await performSessionAction(endpoint, "place", record, { space: "s2" }, placed.io);
  assert.deepEqual(placed.calls.map(call => [call.action, call.input]), [["place", { space: "s2", id: "project", stateDir: "/state" }]]);
  assert.deepEqual(placed.commands, []);
});
