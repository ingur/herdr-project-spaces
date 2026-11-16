import { discoverEndpoints, endpointKey, qualify, unqualify } from "./backends.js";

export const sessionKey = session => JSON.stringify([endpointKey(session.endpoint), session.id]);
export const ownsTerminal = session => session.available === true && session.state !== "stopped" && !!session.terminal;
// Fold and selection keys for the rows above sessions; session and independent rows use their own keys.
export const spaceKey = id => `space:${id}`;
export const projectKey = key => `project:${key}`;

// Higher rank first, everywhere. The sort is stable: equal ranks keep the order they arrived in.
const byRank = (a, b) => b.rank - a.rank;
// An independent row's rank: where someone dragged it (the hc label projects.rank), else when its terminal was made.
function terminalRank(terminal) {
  const rank = Number(terminal?.labels?.["projects.rank"] ?? NaN);
  return Number.isFinite(rank) ? rank : Number.isFinite(terminal?.created_ms) ? terminal.created_ms : 0;
}

// Registry identity owns the tree; current native pane placement owns navigation.
// `showResolved`: the resolved views that are on, a project's key for its threads and a space's for its projects.
// `ready`: this computer's spaces are all read, so one of its own that is not among them is gone, not loading.
export function projectSpaces({ spaces, panes, agents, sessions, terminals = [], showResolved = new Set(), ready = true }) {
  const spaceRow = (space, missing) => ({ key: space.id, space, groups: [], entries: [], missing, resolvedCount: 0 });
  const result = spaces.map(space => spaceRow(space, false));
  const bySpace = new Map(result.map(row => [row.key, row]));
  const byTab = new Map();
  for (const row of result) for (const tab of row.space.tabs ?? []) byTab.set(tab.id, { row, tab });
  const byTerminal = new Map(panes.filter(pane => pane.terminal).map(pane => [pane.terminal, pane]));
  const byAgent = new Map(agents.map(agent => [agent.address, agent]));
  const byAddress = new Map(terminals.map(terminal => [terminal.address, terminal]));
  const registered = new Map(sessions.map(session => [sessionKey(session), session]));
  const owned = new Set(sessions.filter(session => session.available === true).map(session => session.native.terminal).filter(Boolean));
  // Backends that have not answered since this copy started, or not now.
  const unanswered = new Set(sessions.filter(session => session.available !== true).map(session => endpointKey(session.endpoint)));

  function placement(session) {
    const live = ownsTerminal(session);
    const pane = live && byTerminal.get(session.native.terminal);
    const agent = live && byAgent.get(session.native.terminal);
    const current = live && (byTab.get(pane?.tab ?? agent?.tab) ?? byTab.get(session.native.tab));
    if (current) return { ...current.row.space, tab: current.tab.id };
    const machine = session.endpoint.machine;
    // Only a fully read local layout can prove a space is gone.
    if (!machine && ready && !bySpace.has(session.native.space)) return null;
    const id = session.native.space || qualify(machine, `unplaced:${endpointKey(session.endpoint)}`);
    if (!bySpace.has(id)) {
      const row = spaceRow({ id, name: session.space ? "Unavailable space" : "Unplaced sessions", machine, tabs: [] }, true);
      bySpace.set(id, row);
      result.push(row);
    }
    return bySpace.get(id).space;
  }

  function sessionRow(session, home = placement(session)) {
    if (!home) return null;
    const live = ownsTerminal(session), terminal = session.native.terminal;
    const agent = live && byAgent.get(terminal), pane = live && byTerminal.get(terminal);
    return { key: sessionKey(session), rank: session.rank, session, placement: home, live, program: agent?.program ?? pane?.program ?? null,
      status: agent?.status ?? pane?.status ?? null, focused: !!(agent?.focused || pane?.focused), terminal, agent: !!agent, pane: pane?.pane, tab: pane?.tab ?? agent?.tab };
  }

  const groups = new Map();
  for (const session of sessions) {
    const key = sessionKey({ ...session, id: session.coordinator }), coordinator = registered.get(key);
    if (session.deleted || (!coordinator && !ownsTerminal(session))) continue;
    if (!groups.has(key)) {
      const home = placement(coordinator ?? session);
      if (!home) continue;
      const row = bySpace.get(home.id);
      const group = { key, rank: coordinator?.rank ?? 0, coordinator: coordinator ? sessionRow(coordinator, home) : null,
        title: coordinator?.title || `Unavailable project (${String(session.coordinator).slice(0, 8)})`, children: [], resolvedCount: 0 };
      // A resolved project is listed, and its threads with it, only while its space shows them.
      const listed = !coordinator?.resolved || showResolved.has(spaceKey(row.key));
      if (coordinator?.resolved) row.resolvedCount++;
      if (listed) row.groups.push(group);
      groups.set(key, { group, row, listed });
    }
    const { group, row, listed } = groups.get(key);
    const thread = session.role === "thread" ? sessionRow(session, ownsTerminal(session) ? placement(session) : row.space) : null;
    if (thread && session.resolved) group.resolvedCount++;
    const shown = listed && (!thread || !session.resolved || showResolved.has(key));
    if (thread && shown) group.children.push(thread);
    // The focused session is not listed: `reveal` is the resolved view that would list it.
    if (!shown && (thread ?? group.coordinator)?.focused) row.reveal = listed ? key : spaceKey(row.key);
  }
  // Open threads, then resolved ones.
  for (const { group } of groups.values()) group.children.sort((a, b) => !!a.session.resolved - !!b.session.resolved || byRank(a, b));

  // An unreachable machine's stale record never hides a shell that inherited its address. Hidden archives and closing sessions still own theirs.
  const seen = new Set(owned);
  function independent(pane, agent) {
    const terminal = agent?.address ?? pane?.terminal;
    if (terminal && seen.has(terminal)) return;
    // A terminal control started is its session's, never a row of its own: the label arrives with the
    // terminal, before control's list says whose it is. A shell the user started is theirs.
    const labels = byAddress.get(terminal)?.labels;
    if (labels?.["projects.launched"]) return;
    // Until the backend its label names answers, any session's terminal is that session's: its row stands for it, dim.
    const advertised = labels?.["projects.session"] && discoverEndpoints([byAddress.get(terminal)]).endpoints[0];
    if (advertised && unanswered.has(endpointKey(advertised))) return;
    const location = byTab.get(pane?.tab ?? agent?.tab);
    const target = location?.row ?? bySpace.get(agent?.space);
    if (!target) return;
    if (terminal) seen.add(terminal);
    const program = agent?.program ?? pane?.program;
    // A tab's name is its only pane's name; a split beside a session is its own terminal. A shell that
    // sets no title is named by what runs in it, like a terminal's own tab, never by its
    // address (Herdr reports the address as the title when the program set none).
    const record = byAddress.get(terminal), named = title => (title && title !== terminal ? title : undefined);
    const running = (record?.foreground?.argv ?? record?.argv)?.[0]?.split("/").pop();
    target.entries.push({ key: terminal || `pane:${pane.pane}`, rank: terminalRank(record), terminal, pane: pane?.pane, tab: location?.tab.id ?? agent?.tab,
      title: (location?.tab.named && location.tab.panes === 1 && location.tab.name) || named(agent?.title) || named(pane?.title) || program?.name || running || location?.tab.name || terminal,
      agent: !!agent || !!program?.agent, program, cwd: pane?.cwd, status: agent?.status ?? pane?.status, focused: !!(agent?.focused || pane?.focused) });
  }
  for (const pane of panes) independent(pane, byAgent.get(pane.terminal));
  for (const agent of agents) independent(byTerminal.get(agent.address), agent);
  // A stand-in shows for what is listed under it. A thread whose own space is gone needs none: it is under its project.
  return result.filter(row => !row.missing || row.groups.length || row.entries.length || row.resolvedCount);
}

const URGENT = ["blocked", "done", "working"];
// Herdr's own ranking; idle rows and absent heads (null) say nothing.
export const urgentStatus = rows => URGENT.find(status => rows.some(row => row?.status === status)) ?? null;

// What shows right under a space, in display order: its projects (they have `children`) mixed with its independent rows.
export const spaceItems = row => [...row.groups, ...row.entries].sort(byRank);

// What a folded space hides, in display order; null is an unavailable project's head.
export const spaceRows = row => spaceItems(row).flatMap(item => item.children ? [item.coordinator, ...item.children] : [item]);

// Every openable row in display order. `shown` is its own key, or the nearest visible ancestor a fold leaves in its place.
export function displayRows(rows, folded) {
  return rows.flatMap(row => {
    const space = folded.has(spaceKey(row.key)) ? spaceKey(row.key) : null;
    return spaceItems(row).flatMap(item => {
      if (!item.children) return [{ row: item, shown: space ?? item.key }];
      const fold = space ?? (folded.has(projectKey(item.key)) ? item.key : null);
      return [
        ...(item.coordinator ? [{ row: item.coordinator, shown: space ?? item.key }] : []),
        ...item.children.map(child => ({ row: child, shown: fold ?? child.key })),
      ];
    });
  });
}

// The one filled row: the focused row or what stands in for it, else the active space as in stock.
export function selectedKey(rows, folded) {
  const active = rows.find(row => row.space.active);
  return displayRows(rows, folded).find(item => item.row.focused)?.shown ?? (active ? spaceKey(active.key) : null);
}

// The visible row one step (1 or -1) from the row keyed `cursor`, wrapping. A hidden cursor steps
// from where it would be, an unknown one from the list's edge. Stopped sessions are passed over: a
// key never relaunches a conversation. Null: no other row to step to.
export function stepRow(list, cursor, direction) {
  const at = list.findIndex(item => item.row.key === cursor);
  const from = at >= 0 ? at : direction > 0 ? -1 : 0;
  for (let n = 1; n <= list.length; n++) {
    const { row, shown } = list.at((from + direction * n) % list.length);
    if (shown === row.key && row.key !== cursor && (!row.session || row.live)) return row;
  }
  return null;
}

// What the fold key (`fold`) folds: the selected row while it is open, else the project or space
// around it, which the selection then moves to. The unfold key opens the selected row when it is
// folded. Null: nothing to do.
export function foldTarget(rows, folded, selected, fold) {
  for (const row of rows) {
    const space = spaceKey(row.key);
    let own = selected === space ? space : null, parent = null;
    for (const group of row.groups) {
      if (selected === group.key) [own, parent] = [projectKey(group.key), space];
      else if (group.children.some(child => child.key === selected)) parent = projectKey(group.key);
    }
    if (row.entries.some(entry => entry.key === selected)) parent = space;
    if (!own && !parent) continue;
    if (fold) return own && !folded.has(own) ? own : parent;
    return own && folded.has(own) ? own : null;
  }
  return null;
}

// The project the row keyed `key` heads or is a thread of, by its key. Null for any other row.
const projectOf = (rows, key) =>
  rows.flatMap(row => row.groups).find(group => group.key === key || group.children.some(child => child.key === key))?.key ?? null;

// The resolved view (its key in `showResolved`) the resolved key turns on or off: the level the
// selected row is on. In a project that is the project's resolved threads; on a space or an
// independent row, the space's resolved projects. A focused session a resolved view hides goes
// first: no row stands in for it, so the selection is not where the user is. Null: nothing to toggle.
export function resolvedToggle(rows, selected) {
  const hidden = rows.find(row => row.reveal);
  if (hidden) return hidden.reveal;
  const row = rows.find(row => selected === spaceKey(row.key) || row.entries.some(entry => entry.key === selected));
  return row ? spaceKey(row.key) : projectOf(rows, selected);
}

// The rows a drag of the row keyed `key` may land among, in display order: a thread's fellow threads
// of the same resolved state, or a project's or independent row's own space. Never another project,
// space or machine. Null: a row with nowhere to keep a rank (no session, no terminal), or none.
function siblings(rows, key) {
  for (const row of rows) {
    const items = spaceItems(row), item = items.find(item => item.key === key);
    if (item) return item.coordinator || item.terminal ? items : null;
    for (const group of row.groups) {
      const thread = group.children.find(child => child.key === key);
      if (thread) return group.children.filter(child => child.session.resolved === thread.session.resolved);
    }
  }
  return null;
}

// Dropping row `from` on row `over` puts it where `over` is, as stock's space drag does: after it
// when dragged down, before it when dragged up. The rank that does so, or null where it may not go.
// shortcut: a midpoint between equal ranks moves nothing, and a 1 ms gap has ~12 halvings; renumber the siblings if that is ever hit.
export function dropRank(rows, from, over) {
  const list = siblings(rows, from) ?? [], at = list.findIndex(row => row.key === from), to = list.findIndex(row => row.key === over);
  if (to < 0 || to === at) return null;
  const after = at < to, above = list[after ? to : to - 1], below = list[after ? to + 1 : to];
  return { after, rank: above && below ? (above.rank + below.rank) / 2 : above ? above.rank - 1000 : below.rank + 1000 };
}

// The rank that moves the row keyed `key` one place up (-1) or down (1) among the rows a drag may
// land it among. Null: it is at that end already, or it is no row that moves.
export function moveRank(rows, key, direction) {
  const list = siblings(rows, key) ?? [], over = list[list.findIndex(row => row.key === key) + direction];
  return over ? dropRank(rows, key, over.key).rank : null;
}

// The project a drag of the row keyed `from` onto the space `to` would set down there, by its head
// row: the caller refuses one that runs, which is where its terminal is. Null for any other drag:
// only a project moves, by its head, and only to another space of its own machine. Its threads
// follow as they are opened (`openSpace`); an independent row is where its terminal is.
export function spaceDrop(rows, from, to) {
  const target = rows.find(row => row.key === to && !row.missing);
  const head = rows.filter(row => row !== target).flatMap(row => row.groups).find(group => group.coordinator?.key === from)?.coordinator;
  return target && head && (head.session.endpoint.machine ?? null) === (target.space.machine ?? null) ? head : null;
}

// What `open` is told of where to open the session keyed `key`: control's `space`, an id as the
// session's own machine knows it. A stopped session opens in the space its project is listed under,
// as a thread goes with its project. Nothing for a running session, which is where its terminal is,
// or while the project's space is only unavailable: control keeps what it recorded.
export function openSpace(rows, key) {
  for (const group of rows.flatMap(row => row.groups)) {
    const found = [group.coordinator, ...group.children].find(row => row?.key === key);
    if (!found) continue;
    if (found.live) return {};
    const home = (group.coordinator ?? found).placement;
    return rows.some(row => row.key === home.id && !row.missing) ? { space: unqualify(home.machine, home.id) } : {};
  }
  return {};
}

// A session row's hover line: its folder, then only what the row cannot show. Dim says neither which
// of resolved, stopped or out of reach it is, nor which other space a running terminal is in (a
// stopped thread opens with its project, wherever it last ran), nor that messages wait for it.
const waiting = session => session.state === "stopped" && session.waiting > 0 && `${session.waiting} message${session.waiting > 1 ? "s" : ""} waiting`;
export const sessionDetail = (row, space) => [row.session.cwd, row.session.resolved && "resolved",
  row.session.available === false ? "unavailable" : !row.live && "stopped", waiting(row.session),
  row.live && row.placement.id !== space.id && `in ${row.placement.name}`].filter(Boolean).join(" · ");

// Single-pane tabs and their sessions follow whichever title changed. Keep the last observed session
// title separate from the tab's so a pending or failed control rename never restores the old name.
// `applied` holds that state per session and the title given per tab (for a split left behind).
export function tabRenames(sessions, panes, tabs, applied) {
  // Until every backend answers and sees hc, a tab's session may only look gone: name nothing, forget nothing.
  if (sessions.some(session => session.available !== true || session.error)) return [];
  const renames = [], held = new Set();
  for (const session of sessions.filter(ownsTerminal)) {
    const pane = panes.find(pane => pane.terminal === session.native.terminal);
    const tab = pane && tabs.find(tab => tab.id === pane.tab);
    if (!tab) continue;
    held.add(tab.id);
    if (tab.panes !== 1) continue;
    const key = sessionKey(session), previous = applied.get(key);
    const synced = previous?.tab === tab.id ? previous : null;
    if (synced && session.title === synced.title && tab.named && tab.name !== synced.name) {
      if (synced.confirmed) {
        renames.push({ session, title: tab.name });
        applied.set(key, { ...synced, name: tab.name });
        applied.set(`tab:${tab.id}`, tab.name);
      }
      continue;
    }
    // A tab someone named differently before any sync stays theirs; one already showing the title
    // (after the mod reloaded) counts as synced.
    if (!synced && tab.named && tab.name !== session.title) continue;
    if (tab.name !== session.title || !tab.named) {
      // An unchanged session must not undo a requested rename while control catches up or fails.
      if (synced && session.title === synced.title && tab.named && tab.name === synced.name) continue;
      renames.push({ id: tab.id, name: session.title });
    }
    applied.set(key, { tab: tab.id, title: session.title, name: session.title, confirmed: tab.named && tab.name === session.title });
    applied.set(`tab:${tab.id}`, session.title);
  }
  for (const tab of tabs) {
    const given = applied.get(`tab:${tab.id}`);
    if (given === undefined || held.has(tab.id)) continue;
    applied.delete(`tab:${tab.id}`);
    if (tab.named && tab.name === given) renames.push({ id: tab.id, name: "" });
  }
  return renames;
}
