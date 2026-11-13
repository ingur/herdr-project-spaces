import { errorText, invoke, qualify, sessionRecord } from "./backends.js";

const kind = session => session.role === "thread" ? "thread" : "project";

// No Reopen: a person's next prompt in a resolved project or thread reopens it. What ends something
// comes last, as stock's Close: the menu draws its one line above Resolve, or above Delete alone.
export const sessionMenu = session => [
  { title: `Rename ${kind(session)}`, action: "rename", icon: "square-pen" },
  { title: "Open terminal", action: "show", icon: "terminal" },
  ...(session.available !== false && session.terminalOwned && session.terminalState === "live" ? [{ title: "Close terminal", action: "close", icon: "x" }] : []),
  ...(!session.resolved ? [{ title: `Resolve ${kind(session)}`, action: "resolve", icon: "check" }] : []),
  // Herdr ships no bin: `x` is its glyph for what ends something and is Close's here, so the plain minus.
  { title: `Delete ${kind(session)}…`, action: "delete", icon: "minus" },
];

// What the delete dialog says goes with `session`. `records` are its backend's sessions: every
// thread of a project goes with it, the resolved ones too.
export function deletion(session, records) {
  const threads = records.filter(record => record.role === "thread" && record.projectRoot === session.projectRoot && record.coordinator === session.id).length;
  return {
    title: `Delete ${kind(session)}?`,
    detail: `Deletes “${session.title}”${threads ? `, its ${threads} thread${threads > 1 ? "s" : ""} and their conversations` : " and its conversation"}.`,
    kept: "Repository files are not touched.",
  };
}

function checkedResult(result, previous, allowNew = false) {
  sessionRecord(result);
  if (result.projectRoot !== previous.projectRoot || (!allowNew && result.id !== previous.id) || (allowNew && (result.role !== "thread" || result.coordinator !== previous.id))) throw new Error("Control returned a different session identity; no native UI action performed.");
  return result;
}

// `extra` goes to control as given. A show whose `space` is null has nowhere to open (projection's
// `openSpace`): control is not asked, and no space is ever made for a session.
export async function performSessionAction(endpoint, action, record, extra, io) {
  if (!["show", "create-thread", "rename", "order", "place", "close", "resolve", "delete"].includes(action)) throw new Error("Unknown session action.");
  if (action === "show" && extra.space === null) throw new Error("Its space is gone, so it opens in the space you are in. Select a space on this computer first.");
  const execute = (...args) => {
    io.authorize(endpoint);
    return io.exec(...args);
  };
  const options = { ...extra, projectRoot: record.projectRoot, id: record.id };
  if (action === "delete") {
    const result = await invoke(endpoint, action, options, execute);
    if (!Array.isArray(result.deleted) || !result.deleted.includes(record.id)) throw new Error("Control did not confirm the deletion.");
    return result;
  }
  let result = checkedResult(await invoke(endpoint, action, options, execute), record, action === "create-thread");
  if (action === "rename") {
    // Never rename an old tab now occupied by an unrelated shell.
    if (result.terminalOwned && result.terminalState === "live") {
      const terminal = qualify(endpoint.machine, result.terminal);
      const pane = io.panes().find(pane => pane.terminal === terminal);
      if (pane) io.run("tab.rename", { id: pane.tab, name: result.title });
    }
    return result;
  }
  if (!["show", "create-thread"].includes(action)) return result;
  const created = action === "create-thread" ? result : null;
  try {
    if (created) result = checkedResult(await invoke(endpoint, "show", { projectRoot: result.projectRoot, id: result.id }, execute), result);
    if (result.readyToFocus !== true || !result.terminal || result.terminalOwned !== true || result.terminalState !== "live") throw new Error(result.error || "Session is not ready to focus; no terminal was guessed or replaced.");
    const terminal = qualify(endpoint.machine, result.terminal);
    // Native reconciliation adopts hc's placement labels; do not create a second tab or shell.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (io.closed?.()) throw new Error("Session opened, but this view closed before it could focus.");
      const pane = io.panes().find(pane => pane.terminal === terminal);
      if (pane) {
        if (created || io.tabs().some(tab => tab.id === pane.tab && !tab.named)) io.run("tab.rename", { id: pane.tab, name: result.title });
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
