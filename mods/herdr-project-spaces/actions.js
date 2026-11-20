import { errorText, invoke, qualify, sessionRecord } from "./backends.js";
import { sessionKey } from "./projection.js";

export const sessionWord = session => ({ plain: "session", coordinator: "project", thread: "thread" })[session.kind];
const threadsOf = (session, records) => records.filter(record => record.kind === "thread" && record.project === session.id);

// No Reopen: the user's next prompt in a resolved session reopens it. Move folder shows
// while the session is stopped, the only time control takes it.
// What ends something comes last, as stock's Close: the menu draws its one line above the first of Close, Resolve and Delete.
export const sessionMenu = session => [
  { title: `Rename ${sessionWord(session)}`, action: "rename", icon: "square-pen" },
  { title: "Open terminal", action: "open", icon: "terminal" },
  ...(session.state === "stopped" ? [{ title: "Move folder…", action: "move", icon: "folder" }] : []),
  ...(session.available !== false && session.state !== "stopped" ? [{ title: `Close ${sessionWord(session)}`, action: "close", icon: "x" }] : []),
  ...(!session.resolved ? [{ title: `Resolve ${sessionWord(session)}`, action: "resolve", icon: "check" }] : []),
  { title: `Delete ${sessionWord(session)}`, action: "delete", icon: "trash" },
];

// What the delete dialog says goes with `session`. `records` are its backend's sessions: every
// thread of a project goes with it, the resolved ones too.
export function deletion(session, records) {
  const threads = threadsOf(session, records).length;
  return {
    title: `Delete ${sessionWord(session)}?`,
    // As stock's "Close space?": the name, then what goes with it.
    detail: `${session.title} — ${threads ? `${threads} thread${threads > 1 ? "s" : ""} and all conversations` : "its conversation and messages"}`,
    kept: "Files in your repository stay.",
  };
}

function checkedResult(result, previous, allowNew = false) {
  sessionRecord(result);
  if ((!allowNew && result.id !== previous.id) || (allowNew && (result.kind !== "thread" || result.project !== previous.id))) throw new Error("Control returned a different session identity; no native UI action performed.");
  return result;
}

// Only a terminal control reports as the session's, running or starting, is focused or renamed.
const hasTerminal = session => session.state !== "stopped" && !!session.terminal;

// `extra` goes to control as given; control alone places sessions. Every action here is the user's.
export async function performSessionAction(endpoint, action, record, extra, io) {
  if (!["open", "create-thread", "rename", "order", "place", "move", "close", "resolve", "delete"].includes(action)) throw new Error("Unknown session action.");
  const execute = (...args) => {
    io.authorize(endpoint);
    return io.exec(...args);
  };
  const options = action === "create-thread" ? { ...extra, coordinator: record.id } : { ...extra, id: record.id };
  if (action === "delete") {
    const result = await invoke(endpoint, action, options, execute);
    if (!Array.isArray(result.deleted) || !result.deleted.includes(record.id)) throw new Error("Control did not confirm the deletion.");
    return result;
  }
  let result = checkedResult(await invoke(endpoint, action, options, execute), record, action === "create-thread");
  if (action === "rename") {
    // Never rename an old tab now occupied by an unrelated shell.
    if (hasTerminal(result)) {
      const terminal = qualify(endpoint.machine, result.terminal);
      const pane = io.panes().find(pane => pane.terminal === terminal);
      if (pane) {
        io.run("tab.rename", { id: pane.tab, name: result.title });
        io.tabRenamed?.(endpoint, result, pane.tab);
      }
    }
    return result;
  }
  if (!["open", "create-thread"].includes(action)) return result;
  const created = action === "create-thread" ? result : null;
  try {
    if (created && !hasTerminal(result)) result = checkedResult(await invoke(endpoint, "open", { id: result.id }, execute), result);
    if (!hasTerminal(result)) throw new Error(result.error || "Session is not ready to focus; no terminal was guessed or replaced.");
    const terminal = qualify(endpoint.machine, result.terminal);
    // Native reconciliation adopts hc's placement labels; do not create a second tab or shell.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (io.closed?.()) throw new Error("Session opened, but this view closed before it could focus.");
      const pane = io.panes().find(pane => pane.terminal === terminal);
      if (pane) {
        // A placeholder is no title to show: the tab keeps its own name until the session has one.
        if (result.titleSource !== "placeholder" && (created || io.tabs().some(tab => tab.id === pane.tab && !tab.named))) {
          io.run("tab.rename", { id: pane.tab, name: result.title });
          io.tabRenamed?.(endpoint, result, pane.tab);
        }
        io.run("tab.select", { id: pane.tab });
        io.run("pane.focus", { pane: pane.pane });
        return result;
      }
      await io.pause(100);
    }
    throw new Error(`Session is running on ${endpoint.machine ?? "this computer"}, but its native pane is not available yet. Open terminal again after the machine layout reconnects.`);
  } catch (error) {
    if (!created) throw error;
    return { ...created, focusError: errorText(error) };
  }
}

// What each action shows on its rows at once, until the list says the same or the action fails.
const PENDING = { rename: extra => ({ title: extra.title }), resolve: () => ({ resolved: true }), close: () => ({ state: "stopped" }), delete: () => ({ deleted: true }),
  open: () => ({ state: "starting" }), order: extra => ({ rank: extra.rank }), place: extra => ({ space: extra.space }), move: extra => ({ folder: extra.folder }) };

// A user's action on `session`, from the tree or an overlay alike. `io.shown(pending)` as it starts: the rows'
// keys (a project's close and delete take its threads) and the fields it changes; `io.shown(pending, saved)` as it ends.
export async function act(action, session, extra, io) {
  const fields = PENDING[action]?.(extra), threads = ["close", "delete"].includes(action) ? threadsOf(session, io.sessions(session.endpoint)) : [];
  const pending = fields ? { keys: [session, ...threads].map(record => sessionKey({ ...record, endpoint: session.endpoint })), fields } : null;
  if (pending) io.shown(pending);
  let saved = null;
  try {
    const result = await performSessionAction(session.endpoint, action, session, extra, io);
    // A start saves nothing (the session moves on by itself, and the list says how far); a delete answers ids, not the session.
    if (fields && action !== "open") saved = action === "delete" ? fields : Object.fromEntries(Object.keys(fields).map(field => [field, result[field] ?? fields[field]]));
    return result;
  } finally { io.shown(pending, saved); }
}
