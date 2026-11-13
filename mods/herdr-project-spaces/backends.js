export const errorText = error => error?.message || String(error);
const printable = value => typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const absolute = value => printable(value) && value.startsWith("/");
export const endpointKey = endpoint => JSON.stringify([endpoint.machine ?? null, endpoint.stateDir]);
export const qualify = (machine, id) => id ? (machine ? `${machine}/${id}` : id) : undefined;
// The reverse: an id as its own machine knows it, which is how control takes one.
export const unqualify = (machine, id) => machine ? id.slice(machine.length + 1) : id;
const sameCommand = (a, b) => JSON.stringify(a.command) === JSON.stringify(b.command);
const conflictText = endpoint => `Two running terminals advertise different projects.control commands on ${endpoint.machine ?? "this computer"} for ${endpoint.stateDir}; nothing runs there until one of them is closed.`;
const cached = storage => JSON.parse(storage.getItem("projects.backends") || "[]");

// This mod's whole link to the projects extension: the descriptor a session's terminal carries as
// its `projects.control` label (version 2: argv and state directory), and control's actions.
export function endpointDescriptor(value, machine = null) {
  if (!value || value.version !== 2 || !absolute(value.stateDir) || !Array.isArray(value.command) || !absolute(value.command[0]) || value.command.some(arg => typeof arg !== "string" || /[\x00-\x1f\x7f]/.test(arg))) throw new Error("Invalid projects.control descriptor: version 2, an absolute executable/state directory, and printable argv required.");
  if (machine !== null && (!printable(machine) || machine.includes("/"))) throw new Error("Invalid observed machine identity.");
  return { version: 2, command: [...value.command], stateDir: value.stateDir, machine };
}

// What the live terminals advertise, each machine/stateDir's command once per different one. A
// finished terminal's label is history: the saved snapshot covers sessions whose terminals are gone.
export function discoverEndpoints(terminals) {
  const endpoints = [], errors = new Set();
  for (const terminal of terminals) {
    const label = terminal.labels?.["projects.control"];
    if (label === undefined || terminal.state !== "live") continue;
    try {
      const match = typeof terminal.address === "string" && /^(?:([^/\x00-\x1f\x7f]+)\/)?t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.exec(terminal.address);
      if (!match) throw new Error("Descriptor has no unambiguous observed terminal address.");
      const value = JSON.parse(label);
      // Said once however many terminals carry it, so without the address; nothing is done with it.
      if (value?.version !== undefined && value.version !== 2) { errors.add(`A session advertises projects.control version ${JSON.stringify(value.version)}; this sidebar knows version 2. Update herdr-project-spaces to see its project.`); continue; }
      // Only hc's address establishes the machine; descriptor payload cannot redirect execution.
      const endpoint = endpointDescriptor(value, match[1] ?? null);
      if (!endpoints.some(known => endpointKey(known) === endpointKey(endpoint) && sameCommand(known, endpoint))) endpoints.push(endpoint);
    } catch (error) { errors.add(`${terminal.address}: ${errorText(error)}`); }
  }
  return { endpoints, errors: [...errors] };
}

export function sessionRecord(value) {
  if (!value || !printable(value.id) || !printable(value.coordinator) || !printable(value.title) || !absolute(value.cwd) || !["coordinator", "thread"].includes(value.role) || (value.role === "coordinator") !== (value.id === value.coordinator)) throw new Error("Invalid session identity returned by control.");
  for (const key of ["space", "tab", "terminal"]) {
    if (value[key] !== undefined && value[key] !== null && (!printable(value[key]) || value[key].includes("/"))) throw new Error(`Control returned a non-local ${key}.`);
  }
  if (!Number.isFinite(value.rank)) throw new Error("Control returned a session without a numeric rank.");
  if (!["running", "starting", "stopped"].includes(value.state) || (value.status !== undefined && value.status !== null && !printable(value.status))) throw new Error("Control returned a session without a known state.");
  if (value.waiting !== undefined && !(Number.isInteger(value.waiting) && value.waiting >= 0)) throw new Error("Control returned a session with an invalid waiting count.");
  return value;
}

// The saved snapshot's records of `endpoint`: what an overlay, its own copy of the mod, knows of sessions.
export const savedSessions = (endpoint, storage) =>
  cached(storage).find(row => endpointKey(row.endpoint) === endpointKey(endpoint))?.sessions ?? [];

// `session` with the saved snapshot's record over it: what an overlay shows of a session whose row was
// clicked a while ago. A session the snapshot does not know stays as given.
export function currentSession(session, storage) {
  const record = savedSessions(session.endpoint, storage).find(record => record.id === session.id);
  return record ? { ...session, ...record } : session;
}

// Asked before every command: `endpoint` must still be its machine/stateDir's route. That is the
// one command the live terminals advertise there, and the saved one when none is live.
export function authorizeEndpoint(endpoint, storage, terminals) {
  const key = endpointKey(endpoint);
  const live = discoverEndpoints(terminals).endpoints.filter(candidate => endpointKey(candidate) === key);
  if (live.length > 1) throw new Error(conflictText(endpoint));
  const current = live[0] ?? cached(storage).find(row => endpointKey(row.endpoint) === key)?.endpoint;
  if (!current) throw new Error("Session route is no longer registered; refresh before trying again.");
  if (!sameCommand(current, endpoint)) throw new Error("This session's control command changed; nothing was run. Try again.");
}

export async function invoke(endpoint, action, options, execute) {
  endpoint = endpointDescriptor(endpoint, endpoint.machine ?? null);
  const [command, ...args] = endpoint.command;
  const result = await execute(command, [...args, action, JSON.stringify({ ...options, stateDir: endpoint.stateDir })], endpoint.machine ? { on: endpoint.machine } : {});
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${action} exited ${result.code}`);
  const value = JSON.parse(result.stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session control returned an invalid response.");
  return value;
}

// Endpoints come from the live terminals' labels and from the saved snapshot, which is per mod.
// Failed hosts keep their own last snapshot, never a local substitute.
export class SessionBackends {
  constructor({ storage, exec, hc, terminals }) {
    this.storage = storage;
    this.exec = exec;
    this.hc = hc;
    this.terminals = terminals;
    this.excludedMachines = new Set();
    this.backends = new Map();
    this.errors = [];
    try {
      const saved = cached(storage);
      if (!Array.isArray(saved)) throw new Error("Invalid saved endpoint inventory.");
      for (const row of saved) {
        const endpoint = endpointDescriptor(row.endpoint, row.endpoint.machine ?? null);
        this.backends.set(endpointKey(endpoint), { endpoint, sessions: row.sessions.map(sessionRecord), available: false, error: "Not checked yet; showing last snapshot." });
      }
    } catch (error) { this.errors.push(`Cannot restore session snapshots: ${errorText(error)}`); }
  }

  // `machines` false keeps the last machine inventory instead of starting hc for it.
  async refresh(machines = true) {
    this.errors = [];
    let live = null;
    try {
      const observed = this.terminals();
      if (!Array.isArray(observed)) throw new Error("Herdr returned no terminal inventory.");
      const discovered = discoverEndpoints(observed);
      this.errors.push(...discovered.errors);
      live = discovered.endpoints;
    } catch (error) { this.errors.push(`Endpoint discovery: ${errorText(error)}`); }
    // No endpoint advertised or remembered: stock Spaces, and no process is started for it.
    if (!live?.length && !this.backends.size) return;
    if (machines) {
      try {
        const result = await this.hc(["machine", "ls", "--json"]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "hc machine inventory failed.");
        this.excludedMachines = new Set((JSON.parse(result.stdout).machines ?? []).filter(machine => machine.temporary).map(machine => machine.name));
      } catch (error) { this.errors.push(`Endpoint discovery: ${errorText(error)}`); }
    }
    // What is live decides, anew each time and never saved: one advertised command is the route
    // (an upgrade that moved it is adopted), two different ones are a conflict while both live.
    const conflicts = new Set();
    if (live) {
      const advertised = new Map();
      for (const endpoint of live) {
        if (this.excludedMachines.has(endpoint.machine)) continue;
        const key = endpointKey(endpoint);
        if (advertised.has(key)) conflicts.add(key);
        else advertised.set(key, endpoint);
      }
      // Nothing to show and no one advertising it: an endpoint that is gone is not asked forever.
      for (const [key, backend] of this.backends) if (!backend.sessions.length && !advertised.has(key)) this.backends.delete(key);
      for (const [key, endpoint] of advertised) {
        const backend = this.backends.get(key);
        if (!backend) this.backends.set(key, { endpoint, sessions: [], available: false, error: "Not checked yet." });
        else if (!conflicts.has(key)) backend.endpoint = endpoint;
      }
    }
    await Promise.all([...this.backends].map(async ([key, backend]) => {
      if (this.excludedMachines.has(backend.endpoint.machine)) return;
      if (conflicts.has(key)) {
        backend.available = false;
        backend.error = conflictText(backend.endpoint);
        this.errors.push(backend.error);
        return;
      }
      try {
        const result = await invoke(backend.endpoint, "list", {}, this.exec);
        if (!Array.isArray(result.sessions)) throw new Error("Control returned no sessions array.");
        backend.sessions = result.sessions.map(sessionRecord);
        backend.available = true;
        backend.error = null;
        for (const error of result.errors ?? []) this.errors.push(`${backend.endpoint.machine ?? "This computer"}: ${error.error || JSON.stringify(error)}`);
      } catch (error) {
        backend.available = false;
        backend.error = `${backend.endpoint.machine ?? "This computer"} unavailable; showing last snapshot. ${errorText(error)}`;
        this.errors.push(backend.error);
      }
    }));
    this.storage.setItem("projects.backends", JSON.stringify([...this.backends.values()].map(({ endpoint, sessions }) => ({ endpoint, sessions }))));
  }

  sessions() {
    return [...this.backends.values()].filter(backend => !this.excludedMachines.has(backend.endpoint.machine)).flatMap(backend => backend.sessions.map(record => ({
      ...record, endpoint: backend.endpoint, available: backend.available, availabilityError: backend.error,
      native: { space: qualify(backend.endpoint.machine, record.space), tab: qualify(backend.endpoint.machine, record.tab), terminal: qualify(backend.endpoint.machine, record.terminal) },
    })));
  }
}
