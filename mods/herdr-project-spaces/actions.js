import { errorText, invoke, qualify, sessionRecord } from "./backends.js";

const kind = session => session.role === "thread" ? "thread" : "project";

// No Reopen: the user's next prompt in a resolved project or thread reopens it. What ends something
// comes last, as stock's Close: the menu draws its one line above Resolve, or above Delete alone.
export const sessionMenu = session => [
  { title: `Rename ${kind(session)}`, action: "rename", icon: "square-pen" },
  { title: "Open terminal", action: "open", icon: "terminal" },
  ...(session.available !== false && session.state !== "stopped" ? [{ title: `Close ${kind(session)}`, action: "close", icon: "x" }] : []),
  ...(!session.resolved ? [{ title: `Resolve ${kind(session)}`, action: "resolve", icon: "check" }] : []),
  { title: `Delete ${kind(session)}`, action: "delete", icon: "trash" },
];

// What the delete dialog says goes with `session`. `records` are its backend's sessions: every
// thread of a project goes with it, the resolved ones too.
export function deletion(session, records) {
  const threads = records.filter(record => record.role === "thread" && record.coordinator === session.id).length;
  return {
    title: `Delete ${kind(session)}?`,
    // As stock's "Close space?": the name, then what goes with it.
    detail: `${session.title} — ${threads ? `${threads} thread${threads > 1 ? "s" : ""} and all conversations` : "its conversation and messages"}`,
    kept: "Files in your repository stay.",
  };
}

function checkedResult(result, previous, allowNew = false) {
  sessionRecord(result);
  if ((!allowNew && result.id !== previous.id) || (allowNew && (result.role !== "thread" || result.coordinator !== previous.id))) throw new Error("Control returned a different session identity; no native UI action performed.");
  return result;
}

// Only a terminal control reports as the session's, running or starting, is focused or renamed.
const hasTerminal = session => session.state !== "stopped" && !!session.terminal;

// `extra` goes to control as given; control alone places sessions. Every action here is the user's.
export async function performSessionAction(endpoint, action, record, extra, io) {
  if (!["open", "create-thread", "rename", "order", "place", "close", "resolve", "delete"].includes(action)) throw new Error("Unknown session action.");
  const execute = (...args) => {
    io.authorize(endpoint);
    return io.exec(...args);
  };
  const options = action === "create-thread" ? { ...extra, coordinator: record.id } : { ...extra, id: record.id };
  if (["create-thread", "rename", "resolve"].includes(action)) options.by = "user";
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
    if (created) result = checkedResult(await invoke(endpoint, "open", { id: result.id }, execute), result);
    if (!hasTerminal(result)) throw new Error(result.error || "Session is not ready to focus; no terminal was guessed or replaced.");
    const terminal = qualify(endpoint.machine, result.terminal);
    // Native reconciliation adopts hc's placement labels; do not create a second tab or shell.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (io.closed?.()) throw new Error("Session opened, but this view closed before it could focus.");
      const pane = io.panes().find(pane => pane.terminal === terminal);
      if (pane) {
        if (created || io.tabs().some(tab => tab.id === pane.tab && !tab.named)) {
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
