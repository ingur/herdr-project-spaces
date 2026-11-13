import { div, svg, image } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { agents, exec, hc, machines, nextCommand, notify, openOverlay, panes, run, setShared, shared, spaces, terminals, theme, updates } from "herdr";
import StockSpaces, { STOCK_VERSION } from "./stock-spaces.js";
import { SessionBackends, authorizeEndpoint, errorText, unqualify } from "./backends.js";
import { UNPLACED, displayRows, dropRank, foldTarget, moveRank, openSpace, projectKey, projectSpaces, resolvedToggle, selectedKey, sessionDetail, spaceDrop, spaceItems, spaceKey, spaceRows, stepRow, tabRenames, urgentStatus } from "./projection.js";
import { performSessionAction } from "./actions.js";

export const MOD = "herdr-project-spaces";
// The mod's dialogs open as Herdr opens its own prompt and confirm: 380 wide and, with no height given, as high as their content.
export const openDialog = (role, session) => openOverlay({ mod: MOD, kind: "dialog", width: 380, props: { role, session } });
export const backendStorage = {
  getItem: key => shared(`${MOD}.${key}`),
  setItem: (key, value) => { if (shared(`${MOD}.${key}`) !== value) setShared(`${MOD}.${key}`, value); },
};
// An overlay (its own copy of the mod) sets this after acting on a session: the tree refreshes at once.
export const CHANGED = `${MOD}.changed`;
export const icon = (name, size = 13) => svg(`mods/workspace-chrome/${name}.svg`).size(size).flex_none();
// Herdr's own program icon, drawn as the Agents mod draws it; a terminal where the row has none.
const programIcon = program => program?.icon ? (program.tint ? svg(program.icon) : image(program.icon)).size(13).flex_none() : icon("terminal");
export const actionIO = (cx, owner) => ({
  exec, panes, run, tabs: () => spaces().flatMap(space => space.tabs ?? []),
  authorize: endpoint => authorizeEndpoint(endpoint, backendStorage, terminals()),
  closed: () => owner.closed, pause: ms => new Promise(resolve => cx.timer.after(ms, resolve)),
});
export const reportError = error => notify({ title: "Project sessions", body: errorText(error), level: "error" });

function readSet(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`Invalid saved ${key}.`);
    return new Set(value);
  } catch (error) { reportError(error); return new Set(); }
}

export function smallButton(id, glyph, title, action, selected = false) {
  const t = theme();
  return Button.new(id).size(20).flex_none().flex().items_center().justify_center().rounded(4)
    .text_color(selected ? t.foreground : t.dim).when(selected, el => el.bg(t.selected))
    .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(title).accessibility_label(title)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(icon(glyph, 11));
}
// The place of a hover control while it is hidden: nothing in the row moves when it shows.
const slot = () => div().size(20).flex_none();

// Stock's compact status for the most urgent of `rows` (a spinner while working, a dot when done
// or blocked, nothing when idle), then a small dim count of the rows a fold hides.
function marks(rows, hidden, t) {
  const status = urgentStatus(rows);
  return [
    ...(status === "working" ? [icon("spinner", 12).text_color(t.working).spin(900)] : status ? [div().size(6).flex_none().rounded(3).bg(t[status])] : []),
    ...(hidden ? [div().flex_none().text_size(11).text_color(t.dim).child(String(hidden))] : []),
  ];
}

export default class ProjectTree extends StockSpaces {
  init(options, cx) {
    super.init(options, cx);
    this.projectFolds = readSet("projects.folded");
    // The resolved views that are on: a project's key for its resolved threads, a space's for its resolved projects.
    this.showResolved = readSet("projects.resolved");
    this.actions = new Set();
    this.lastErrors = "";
    this.order = [];
    this.drawn = [];
    this.tabTitles = new Map();
    // The Spaces this extends is one Herdr release's copy: say so once for each other release it runs in.
    // Read leniently: this is the one line meant for a Herdr it was not written against.
    const app = updates()?.app?.version;
    if (app && app !== STOCK_VERSION && localStorage.getItem("projects.stock-notice") !== app) {
      localStorage.setItem("projects.stock-notice", app);
      notify({ title: "Project sessions", body: `This sidebar is built on the Spaces panel of Herdr ${STOCK_VERSION}; this is Herdr ${app}. It may misdraw or miss what is new there until herdr-project-spaces is updated.`, level: "warning" });
    }
    // No endpoint is configured: sessions' terminals advertise theirs. Until one has, this is stock Spaces.
    this.backends = new SessionBackends({ storage: backendStorage, exec, hc, terminals });
    if (this.backends.errors.length) reportError(this.backends.errors.join("\n"));
    // A refresh starts control per backend, every sixth timed one hc for the machines too: agent-side changes show up to ~10 s late. Actions and label changes refresh at once.
    this.ticks = 0;
    this.sessionTimer = cx.timer.every(10000, cx => this.refreshSessions(cx, ++this.ticks % 6 === 0));
    this.refreshSessions(cx);
    // keys.json's "herdr-project-spaces.<command>" (install.mjs merges them), delivered while this copy shows.
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "next" || command === "prev") this.step(command === "next" ? 1 : -1, cx);
        else if (command === "fold" || command === "unfold") this.fold(command === "fold", cx);
        else if (command === "move-up" || command === "move-down") this.move(command === "move-up" ? -1 : 1, cx);
        else if (command === "toggle-resolved") this.toggleResolved(cx);
      }
    });
  }

  close() {
    this.closed = true;
    this.sessionTimer.cancel();
    this.watching.clear();
  }

  refreshSessions(cx, machines = true) {
    if (this.closed) return;
    if (this.refreshingSessions) { this.refreshAgain = true; return; }
    const previous = JSON.stringify([this.backends.sessions(), this.backends.errors]);
    this.refreshingSessions = true;
    cx.spawn(async cx => {
      try {
        await this.backends.refresh(machines);
        const errors = this.backends.errors.join("\n");
        if (errors && errors !== this.lastErrors && !this.closed) reportError(errors);
        this.lastErrors = errors;
      } catch (error) { if (!this.closed) reportError(error); }
      finally {
        this.refreshingSessions = false;
        if (!this.closed) {
          for (const rename of tabRenames(this.backends.sessions(), panes(), spaces().flatMap(space => space.tabs ?? []), this.tabTitles)) run("tab.rename", rename);
          if (previous !== JSON.stringify([this.backends.sessions(), this.backends.errors])) cx.notify();
          if (this.refreshAgain) { this.refreshAgain = false; this.refreshSessions(cx); }
        }
      }
    });
  }

  toggle(set, key, storageKey, cx) {
    set.has(key) ? set.delete(key) : set.add(key);
    localStorage.setItem(storageKey, JSON.stringify([...set]));
    cx.notify();
  }

  action(action, row, cx, extra = {}) {
    if (this.actions.has(row.key) || this.closed) return;
    this.actions.add(row.key);
    cx.notify();
    cx.spawn(async cx => {
      try { await performSessionAction(row.session.endpoint, action, row.session, extra, actionIO(cx, this)); }
      catch (error) { reportError(error); }
      finally {
        this.actions.delete(row.key);
        if (!this.closed) { this.refreshSessions(cx); cx.notify(); }
      }
    });
  }

  // The name dialog is its own copy of the mod and cannot unfold the project once the thread
  // exists, so its threads show as the dialog opens.
  newThread(row, cx) {
    if (this.projectFolds.has(projectKey(row.key))) this.toggle(this.projectFolds, projectKey(row.key), "projects.folded", cx);
    openDialog("new-thread", row.session);
  }

  // keys.json's fold / unfold, on the selected row.
  fold(fold, cx) {
    const key = foldTarget(this.drawn, this.projectFolds, this.selected, fold);
    if (key) this.toggle(this.projectFolds, key, "projects.folded", cx);
  }

  // keys.json's move-up / move-down: the selected row trades places with its neighbour, as a drag would.
  move(direction, cx) {
    const rank = moveRank(this.drawn, this.selected, direction);
    if (rank !== null) this.reorder(this.order.find(item => item.row.key === this.selected).row, rank, cx);
  }

  // keys.json's toggle-resolved: the archive button of the level the selection is on (projection's `resolvedToggle`).
  toggleResolved(cx) {
    const key = resolvedToggle(this.drawn, this.selected);
    if (key) this.toggle(this.showResolved, key, "projects.resolved", cx);
  }

  // Keeps a dropped row's rank: a session's in its registry, an independent terminal's as an hc label.
  reorder(row, rank, cx) {
    if (row.session) { this.action("order", row, cx, { rank }); return; }
    cx.spawn(async cx => {
      try {
        const result = await hc(["label", row.terminal, "--json", `projects.rank=${rank}`]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "hc did not label the terminal.");
      } catch (error) { reportError(error); }
      if (!this.closed) cx.notify();
    });
  }

  // Stock's space drag for a row under a space: the pressed row dims once the pointer is on another,
  // an accent line marks where it would land, and a press released on its own row opens it.
  // `drawn` already holds this row's space while its rows are being drawn.
  draggable(el, row, t) {
    const drop = this.over === row.key && dropRank(this.drawn, this.pressed, row.key);
    return el.relative()
      .when(this.pressed === row.key && this.over !== row.key, el => el.opacity(0.5))
      .when(!!drop, el => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(drop.after, line => line.bottom(0)).when(!drop.after, line => line.top(0))))
      .on_mouse_down("left", () => { this.pressed = this.over = row.key; })
      .on_mouse_move((_e, cx) => {
        if (this.pressed === null) return;
        const over = this.pressed === row.key || dropRank(this.drawn, this.pressed, row.key) ? row.key : null;
        if (this.over !== over) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed, drop = this.over === row.key && dropRank(this.drawn, from, row.key);
        this.pressed = this.over = null;
        if (drop) this.reorder(this.order.find(item => item.row.key === from).row, drop.rank, cx);
        else if (from === row.key) this.open(row, cx);
        cx.notify();
      });
  }

  hoverRow(key, on, cx) {
    if (on) this.hoveredRow = key;
    else if (this.hoveredRow === key) this.hoveredRow = null;
    cx.notify();
  }

  // A row's click, and what the next/prev keys do. Showing a session never resumes paused work.
  open(row, cx) {
    if (row.session) this.action("show", row, cx, openSpace(this.drawn, row.key));
    else if (row.agent) run("agent.focus", { terminal: row.terminal });
    else { if (row.tab) run("tab.select", { id: row.tab }); if (row.pane) run("pane.focus", { pane: row.pane }); }
  }

  // One visible row down (1) or up (-1) from the row last stepped to, which is the focused one
  // unless its open failed: a row that cannot open must not trap the keys.
  step(direction, cx) {
    if (this.actions.has(this.cursor)) return; // That row is still opening.
    const row = stepRow(this.order, this.cursor, direction);
    // No other row shows (the rail, everything folded): stock's own space order.
    if (!row) { run(direction > 0 ? "space.next" : "space.prev"); return; }
    this.cursor = row.key;
    this.open(row, cx);
  }

  ordered() {
    const rows = super.ordered();
    for (const row of this.projection.values()) if (row.missing) rows.push({ w: row.space, i: rows.length, g: null, tree: null });
    return rows;
  }

  rowLeading(space) {
    const key = spaceKey(space.id), folded = this.projectFolds.has(key);
    return [smallButton(`fold-${key}`, folded ? "chevron-right" : "chevron-down", `${folded ? "Expand" : "Fold"} ${space.name}`, cx => this.toggle(this.projectFolds, key, "projects.folded", cx))];
  }

  // The archive button of a resolved view (`key` in `showResolved`), where there are resolved `what`
  // to show or they show: on the hovered row, as its `+`, and while the view is on, which it then says.
  archive(key, count, what, hovered) {
    const on = this.showResolved.has(key);
    if (!count && !on) return [];
    return [on || hovered ? smallButton(`archives-${key}`, "archive", `${on ? "Hide" : "Show"} resolved ${what} (${count})`, cx => this.toggle(this.showResolved, key, "projects.resolved", cx), on) : slot()];
  }

  // `missing`: the row of a space that is gone or out of reach, where no terminal can start.
  rowTrailing(space, t, missing) {
    const key = spaceKey(space.id), row = this.projection.get(space.id), hovered = this.hoveredRow === key;
    const hidden = row && this.projectFolds.has(key) ? spaceRows(row) : [];
    return [...marks(hidden, hidden.length, t), ...this.archive(key, row?.resolvedCount ?? 0, "projects", hovered),
      ...(missing ? [] : [hovered ? smallButton(`shell-${space.id}`, "plus", `New terminal in ${space.name}`, () => run("tab.new", { space: space.id })) : slot()])];
  }

  // Stock's hook for a row that is no space, dropped on space `w`: what the drop does when the row
  // keyed `from` is a project (projection's `spaceDrop`), and stock draws its drop line. Control
  // keeps the project's new space; one that runs is where its terminal is.
  rowDrop(from, w) {
    const row = spaceDrop(this.drawn, from, w.id);
    return row && (cx => row.live ? reportError("Close this project's terminal before moving it to another space.")
      : this.action("place", row, cx, { space: unqualify(w.machine, w.id) }));
  }

  unavailableRows(rows, t) {
    return rows.filter(({ w }) => this.projection.get(w.id)?.groups.length || this.projection.get(w.id)?.resolvedCount).map(row => this.row({ ...row, snapshot: true }, t));
  }

  row(native, t) {
    const row = this.projection.get(native.w.id), key = spaceKey(native.w.id), selected = this.selected === key;
    if (row) this.drawn.push(row);
    const missing = row?.missing || native.snapshot;
    const head = missing ? h_flex().id(`space-${native.w.id}`).h(30).px(8).gap(9).items_center().rounded(8).text_color(t.dim)
      .when(selected, el => el.bg(t.selected)).on_hover((on, cx) => this.hoverRow(key, on, cx))
      .children(this.rowLeading(native.w)).child(icon("folder"))
      .child(div().flex_1().truncate().tooltip(native.w.id === UNPLACED ? "Projects whose space is gone; one opens in the space you are in."
        : "Out of reach; its projects open again once its machine reconnects.").child(native.w.name))
      .children(this.rowTrailing(native.w, t, true))
      // Stock fills the row of the `active` space; here the selected row has the fill, which a session's may be.
      : super.row({ ...native, w: { ...native.w, active: selected } }, t).on_hover((on, cx) => this.hoverRow(key, on, cx));
    return v_flex().flex_none().child(head).when(!this.projectFolds.has(key) && !!row, el => el.children(
      spaceItems(row).flatMap(item => item.children ? this.groupRows(item, native.w) : [this.independentRow(item)])));
  }

  compact(native, t) {
    if (!this.projection.get(native.w.id)?.missing) return super.compact(native, t);
    return h_flex().h(26).justify_center().items_center().text_color(t.dim)
      .tooltip(native.w.id === UNPLACED ? "Unplaced: projects whose space is gone" : `${native.w.name}: last session snapshot; space unavailable`).child(icon("folder"));
  }

  sessionRow(row, group, anchor) {
    const t = theme(), session = row.session, project = !!group, selected = this.selected === row.key, hovered = this.hoveredRow === row.key;
    const foldKey = projectKey(row.key), folded = project && this.projectFolds.has(foldKey), hidden = folded ? group.children : [];
    const controls = project ? [
      ...this.archive(group.key, group.resolvedCount, "threads", hovered),
      hovered ? smallButton(`thread-${row.key}`, "plus", `New thread in ${session.title}`, cx => this.newThread(row, cx)) : slot(),
    ] : [];
    return this.draggable(h_flex().id(`session-${row.key}`).h(28).flex_none().pl(project ? 26 : 73).pr(8).gap(7).items_center().rounded(7)
      .text_size(12.8).text_color(session.resolved || !row.live ? t.dim : t.foreground)
      .when(selected, el => el.bg(t.selected)).when(!selected, el => el.hover(s => s.bg(t.hover)))
      .on_hover((on, cx) => this.hoverRow(row.key, on, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: MOD, kind: "popup", width: 200, props: { role: "session-menu", session, show: openSpace(this.drawn, row.key) } }); })
      .when(project, el => el.child(smallButton(`fold-project-${row.key}`, folded ? "chevron-right" : "chevron-down", `${folded ? "Expand" : "Fold"} ${session.title}`, cx => this.toggle(this.projectFolds, foldKey, "projects.folded", cx))))
      .child(programIcon(row.program))
      // As stock's truncated texts, the name carries the hover line; the row's buttons have their own.
      .child(div().flex_1().min_w(0).truncate().tooltip(sessionDetail(row, anchor)).child(session.title))
      .children(marks([row, ...hidden], hidden.length, t))
      .children(controls), row, t);
  }

  groupRows(group, space) {
    const t = theme(), key = projectKey(group.key), folded = this.projectFolds.has(key), hidden = folded ? group.children : [];
    const head = group.coordinator ? this.sessionRow(group.coordinator, group, space) : h_flex().h(28).pl(26).pr(8).gap(7).items_center().rounded(7).text_color(t.dim)
      .when(this.selected === group.key, el => el.bg(t.selected))
      .child(smallButton(`fold-${key}`, folded ? "chevron-right" : "chevron-down", `${folded ? "Expand" : "Fold"} ${group.title}`, cx => this.toggle(this.projectFolds, key, "projects.folded", cx)))
      .child(div().flex_1().truncate().child(group.title))
      .children(marks(hidden, hidden.length, t))
      .children(this.archive(group.key, group.resolvedCount, "threads", true));
    return [head, ...(folded ? [] : group.children.map(row => this.sessionRow(row, null, space)))];
  }

  independentRow(entry) {
    const t = theme(), selected = this.selected === entry.key;
    return this.draggable(h_flex().id(`independent-${entry.key}`).h(28).pl(53).pr(8).gap(7).items_center().rounded(7)
      .text_size(12.8).text_color(t.foreground).when(selected, el => el.bg(t.selected)).when(!selected, el => el.hover(s => s.bg(t.hover)))
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "pane", target: { pane: entry.pane, terminal: entry.terminal } } }))
      .child(programIcon(entry.program)).child(div().flex_1().min_w(0).truncate().when(!!entry.cwd, el => el.tooltip(entry.cwd)).child(entry.title))
      .children(marks([entry], 0, t)), entry, t);
  }

  render(cx) {
    const all = terminals();
    // Refresh when a control advertisement changes, and when an overlay says it changed a session.
    const signature = JSON.stringify([shared(CHANGED), all.filter(row => row.labels?.["projects.control"]).map(row => [row.address, row.state, row.labels["projects.control"]])]);
    if (signature !== this.terminalSignature) {
      this.terminalSignature = signature;
      this.refreshSessions(cx);
    }
    // This computer's spaces are all read: until then every one of them looks gone.
    const local = machines().find(machine => machine.name === null)?.layout;
    const rows = projectSpaces({ spaces: spaces(), panes: panes(), agents: agents(), sessions: this.backends.sessions(), terminals: all,
      showResolved: this.showResolved, ready: !local || local === "ready" });
    this.projection = new Map(rows.map(row => [row.key, row]));
    this.selected = selectedKey(rows, this.projectFolds);
    this.drawn = [];
    const view = super.render();
    // The keys walk the rows as drawn: stock's space order, without what a machine's fold hides.
    this.order = displayRows(this.drawn, this.projectFolds);
    const focused = this.order.find(item => item.row.focused)?.row.key ?? null;
    if (focused !== this.focusedRow) this.cursor = this.focusedRow = focused;
    return view;
  }
}
