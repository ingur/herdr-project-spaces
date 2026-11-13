import test from "node:test";
import assert from "node:assert/strict";
import { SessionBackends, authorizeEndpoint, discoverEndpoints, endpointDescriptor, endpointKey, invoke, sessionRecord } from "../mods/herdr-project-spaces/backends.js";

const descriptor = { version: 1, command: ["/usr/bin/runtime", "/control", "--fixed-arg"], stateDir: "/state" };
const local = endpointDescriptor(descriptor);
const remote = endpointDescriptor(descriptor, "buildbox");
const record = { id: "session", coordinator: "session", role: "coordinator", title: "Project", projectRoot: "/project", cwd: "/project", space: "s1", tab: "tab1", terminal: "t1", terminalOwned: true, terminalState: "live", rank: 1 };
const ok = value => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const terminal = (address, value = descriptor, state = "live") => ({ address, state, labels: { "projects.control": JSON.stringify(value) } });
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };
const hc = async () => ok({ machines: [] });

test("live terminals advertise endpoints: none chooses its machine, a finished one is history, an unknown version is said once", () => {
  const found = discoverEndpoints([terminal("buildbox/t1b", { ...descriptor, machine: "attacker" }), terminal("t9z"), terminal("t9y"),
    terminal("t8", { ...descriptor, stateDir: "/old-state" }, "finished"), terminal("other/t4", { ...descriptor, version: 2 }), terminal("other/t5", { version: 2 }), terminal("invalid/address/t5")]);
  assert.deepEqual(found.endpoints.map(endpoint => [endpoint.machine, endpoint.stateDir]), [["buildbox", "/state"], [null, "/state"]]);
  assert.notEqual(endpointKey(found.endpoints[0]), endpointKey(found.endpoints[1]));
  assert.equal(found.errors.length, 2);
  assert.match(found.errors[0], /version 2; this sidebar knows version 1/);
  assert.match(found.errors[1], /^invalid\/address\/t5: /);
});

test("the descriptor trust boundary rejects unsafe paths and argv, and takes any absolute argv", () => {
  for (const value of [null, { ...descriptor, command: [] }, { ...descriptor, command: ["runtime"] }, { ...descriptor, command: ["/runtime", "bad\narg"] }, { ...descriptor, stateDir: "relative" }, { ...descriptor, stateDir: "/bad\0state" }]) assert.throws(() => endpointDescriptor(value));
  assert.throws(() => endpointDescriptor(descriptor, "one/two"));
  assert.deepEqual(endpointDescriptor({ ...descriptor, command: ["/state/bin/control"] }).command, ["/state/bin/control"]);
  assert.deepEqual(endpointDescriptor({ ...descriptor, command: ["/runtime with spaces", "", "quoted ' literal"] }).command, ["/runtime with spaces", "", "quoted ' literal"]);
});

test("invocation uses argv and originating native machine, never a shell or local fallback", async () => {
  const calls = [];
  const execute = async (...args) => { calls.push(args); return ok({ sessions: [] }); };
  await invoke(remote, "rename", { id: "session", title: "literal; $(nothing)", stateDir: "/wrong" }, execute);
  assert.deepEqual(calls[0], ["/usr/bin/runtime", ["/control", "--fixed-arg", "rename", JSON.stringify({ id: "session", title: "literal; $(nothing)", stateDir: "/state" })], { on: "buildbox" }]);
  await assert.rejects(invoke(remote, "list", {}, async () => { throw new Error("offline"); }), /offline/);
  await invoke(local, "list", {}, execute);
  assert.deepEqual(calls[1][2], {});
});

test("with no endpoint advertised or remembered nothing is started, reported or saved; an unknown descriptor version adds one notice and nothing else", async () => {
  const saved = storage();
  let started = 0, observed = [{ address: "t1", state: "live", labels: {} }, terminal("t2", descriptor, "finished")];
  const count = async () => { started++; return ok({ machines: [], sessions: [] }); };
  const backends = new SessionBackends({ storage: saved, hc: count, exec: count, terminals: () => observed });
  await backends.refresh();
  assert.deepEqual([backends.errors, backends.sessions(), started, saved.getItem("projects.backends")], [[], [], 0, null]);
  observed = [terminal("t3", { ...descriptor, version: 2 }), terminal("t4", { ...descriptor, version: 2 })];
  await backends.refresh();
  assert.equal(backends.errors.length, 1);
  assert.match(backends.errors[0], /version 2; this sidebar knows version 1/);
  assert.deepEqual([backends.sessions(), started, saved.getItem("projects.backends")], [[], 0, null]);
});

test("saved endpoints stay listable after terminals disappear; failures keep honest snapshots; one with nothing left to show is forgotten", async () => {
  const saved = storage(), calls = [];
  let offline = false, observed = true, sessions = [record];
  const exec = async (_program, _args, options) => {
    calls.push(options.on ?? null);
    if (offline) throw new Error("host disconnected");
    return ok({ sessions });
  };
  const options = { storage: saved, exec, hc, terminals: () => observed ? [terminal("buildbox/t1")] : [] };
  const backends = new SessionBackends(options);
  await backends.refresh();
  assert.equal(backends.sessions()[0].native.terminal, "buildbox/t1");
  assert.equal(backends.sessions()[0].terminal, "t1");
  assert.equal(backends.sessions()[0].available, true);
  observed = false;
  await backends.refresh();
  assert.equal(backends.sessions()[0].available, true);
  offline = true;
  await backends.refresh();
  const stale = backends.sessions()[0];
  assert.equal(stale.available, false);
  assert.match(stale.availabilityError, /last snapshot.*host disconnected/);
  assert.equal(stale.id, record.id);
  assert.deepEqual(calls, ["buildbox", "buildbox", "buildbox"]);
  const restarted = new SessionBackends(options);
  assert.equal(restarted.sessions()[0].available, false);
  assert.equal(restarted.sessions()[0].endpoint.machine, "buildbox");
  offline = false;
  sessions = [];
  await restarted.refresh();
  await restarted.refresh();
  assert.equal(calls.length, 4, "an endpoint with no session and no live terminal is not asked again");
  assert.equal(saved.getItem("projects.backends"), "[]");
});

test("an upgraded command is adopted from the one live terminal; two live commands block; the conflict ends with one of them and is never saved", async () => {
  const saved = storage(), calls = [];
  const old = { ...descriptor, command: ["/nix/store/old-node/bin/node", "/old/control.mjs"] }, next = { ...descriptor, command: ["/state/bin/control"] };
  // What the previous sidebar left behind after the same upgrade: the old command, and a conflict that stuck.
  saved.setItem("projects.backends", JSON.stringify([{ endpoint: endpointDescriptor(old), sessions: [record], conflict: "Conflicting projects.control commands" }]));
  let observed = [terminal("t1", next)];
  const options = { storage: saved, hc, terminals: () => observed, exec: async command => { calls.push(command); return ok({ sessions: [record] }); } };
  const backends = new SessionBackends(options);
  await backends.refresh();
  assert.deepEqual([calls, backends.errors], [["/state/bin/control"], []]);
  assert.equal(backends.sessions()[0].available, true);
  authorizeEndpoint(backends.sessions()[0].endpoint, saved, observed);
  assert.throws(() => authorizeEndpoint(endpointDescriptor(old), saved, observed), /command changed/);

  observed = [terminal("t1", next), terminal("t2", old)];
  await backends.refresh();
  assert.equal(calls.length, 1, "neither command runs while both are advertised");
  assert.match(backends.errors.join("\n"), /different projects\.control commands/);
  const blocked = backends.sessions()[0];
  assert.deepEqual([blocked.available, blocked.id], [false, record.id]);
  for (const command of [old.command, next.command]) assert.throws(() => authorizeEndpoint({ ...blocked.endpoint, command }, saved, observed), /different projects\.control commands/);
  assert.doesNotMatch(saved.getItem("projects.backends"), /conflict/i);

  observed = [terminal("t1", next, "finished"), terminal("t2", old)];
  await backends.refresh();
  assert.deepEqual([calls.at(-1), backends.errors, backends.sessions()[0].available], [old.command[0], [], true]);
  observed = [];
  const restarted = new SessionBackends(options);
  await restarted.refresh();
  assert.deepEqual([calls.at(-1), restarted.errors], [old.command[0], []]);
  authorizeEndpoint(restarted.sessions()[0].endpoint, saved, observed);
  assert.throws(() => authorizeEndpoint(endpointDescriptor(next), saved, observed), /command changed/);
  assert.throws(() => authorizeEndpoint(remote, saved, observed), /no longer registered/);
});

test("control cannot smuggle qualified placement into another host", () => {
  for (const key of ["space", "tab", "terminal"]) assert.throws(() => sessionRecord({ ...record, [key]: "another/identity" }), /non-local/);
  assert.throws(() => sessionRecord({ ...record, coordinator: "someone-else" }), /identity/);
  for (const rank of [undefined, null, "1", NaN, Infinity]) assert.throws(() => sessionRecord({ ...record, rank }), /numeric rank/);
  assert.equal(sessionRecord(record), record);
});
