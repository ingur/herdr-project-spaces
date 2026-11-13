import { div } from "gpui-kit";
import { Button, Input, InputState, h_flex, v_flex } from "gpui-base";
import { closeOverlay, notify, setShared, theme } from "herdr";
import { currentSession, errorText, savedSessions } from "./backends.js";
import { deletion, performSessionAction, sessionMenu } from "./actions.js";
import { sessionKey } from "./projection.js";
import { actionIO, backendStorage, CHANGED, icon, openDialog, reportError, settled } from "./tree.js";

const PENDING = { rename: extra => ({ title: extra.title }), resolve: () => ({ resolved: true }) };

// An overlay is its own copy of the mod: shared state tells the tree what is changing, so the row
// shows it at once, and has it refresh when the action is done rather than at its next poll.
// A failed action may have changed the session too.
async function act(owner, session, action, extra, cx) {
  const key = sessionKey(session), pending = PENDING[action]?.(extra);
  if (pending) setShared(CHANGED, { at: Date.now(), pending: { key, fields: pending } });
  let done = pending && { failed: key };
  try {
    const result = await performSessionAction(session.endpoint, action, session, extra, actionIO(cx, owner));
    if (pending) done = { pending: { key, fields: settled(pending, result) } };
    return result;
  } finally { setShared(CHANGED, { at: Date.now(), tabTitle: owner.tabTitle, ...done }); }
}

export class SessionMenu {
  init(options, cx) {
    this.options = options;
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() { this.closed = true; }

  // Props hold the session as its row knew it when clicked; the tree's snapshot is newer.
  session() { return currentSession(this.options.session, backendStorage); }

  choose(index, cx) {
    if (this.busy) return;
    const session = this.session(), item = sessionMenu(session)[index];
    if (!item) return;
    if (item.action === "rename" || item.action === "delete") {
      closeOverlay(this.options.overlay);
      openDialog(item.action, session);
      return;
    }
    this.busy = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        // shortcut: where a stopped session opens was decided as this menu opened; decide here if menus ever stay open long.
        await act(this, session, item.action, item.action === "show" ? this.options.show : {}, cx);
        closeOverlay(this.options.overlay);
      } catch (error) { reportError(error); }
      finally { this.busy = false; if (!this.closed) cx.notify(); }
    });
  }

  render() {
    const t = theme(), list = sessionMenu(this.session()), ends = list.findIndex(item => item.action === "resolve" || item.action === "delete");
    return v_flex().id("session-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(this.options.overlay);
        else if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else return;
        cx.notify();
      })
      .children(list.map((item, index) => v_flex()
        // Stock's menus set off what ends something the same way: one line, the items themselves uncolored.
        .when(index === ends, el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(Button.new(`session-action-${item.action}`).h(31).w_full().px(8).flex().gap(9).items_center().rounded(7)
          .text_color(t.foreground).disabled(!!this.busy).when(index === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .accessibility_label(item.title).on_click((_e, cx) => this.choose(index, cx))
          .child(icon(item.icon, 14).text_color(t.muted)).child(div().flex_1().child(item.title)))));
  }
}

// What the dialogs share with stock's prompt and confirm: a title beside the Esc hint, then Cancel
// beside the one action (`dialog.submit`), which is `solid` in stock's confirm too: Herdr has no red button.
const heading = (t, text) => h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(text))
  .child(div().text_size(11).text_color(t.dim).child("Esc"));
function buttons(t, dialog, label) {
  const button = (id, text, primary, action) => Button.new(id).h(32).px(14).rounded(8).border_1()
    .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).disabled(!!dialog.busy)
    .hover(s => s.opacity(0.88)).on_click((_e, cx) => action(cx)).child(text);
  return h_flex().gap(8).justify_end()
    .child(button("dialog-cancel", "Cancel", false, () => closeOverlay(dialog.options.overlay)))
    .child(button("dialog-submit", label, true, cx => dialog.submit(cx)));
}

// Names a session, drawn as stock's prompt: a new thread under the project in props (role "new-thread"), else a rename.
export class NameSession {
  init(options, cx) {
    this.options = options;
    this.create = options.role === "new-thread";
    const value = this.create ? "" : options.session.title;
    this.input = InputState.new(this.create ? { placeholder: "Optional" } : { value });
    this.input.set_selected_range({ start: 0, end: value.length });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("change", (_e, cx) => cx.notify());
    this.focused = true;
    this.input.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.input.focus();
    this.handle = cx.focus_handle();
  }

  close() { this.closed = true; this.input.release(); }

  submit(cx) {
    if (this.busy) return;
    const title = this.input.value().trim(), session = this.options.session;
    if (/[\x00-\x1f\x7f]/.test(title) || (!title && !this.create)) { this.error = this.create ? "Enter a printable name, or none." : "Enter a nonempty, printable name."; cx.notify(); return; }
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = this.create ? await act(this, session, "create-thread", title ? { title, by: "human" } : {}, cx) : await act(this, session, "rename", { title }, cx);
        closeOverlay(this.options.overlay);
        if (result.focusError) notify({ title: `Thread "${result.title}" created`, body: `Click its row to open it; do not create another thread to retry. ${result.focusError}`, level: "info" });
      } catch (error) { this.error = errorText(error); }
      finally { this.busy = false; if (!this.closed) cx.notify(); }
    });
  }

  render() {
    const t = theme();
    const title = this.create ? "New thread" : this.options.session.role === "thread" ? "Rename thread" : "Rename project";
    const save = this.create ? (this.busy ? "Creating…" : "Create") : this.busy ? "Saving…" : "Save";
    // In the place of stock's hint ("empty: its number"): what went wrong, else what an empty name does.
    const note = this.error || (this.create && "empty: it names itself");
    return v_flex().id("name-session").track_focus(this.handle).w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.options.overlay); cx.stop_propagation(); } })
      .child(heading(t, title))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.focused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground).accessibility_label("Session name"))
      .when(!!note, el => el.child(div().pt(6).text_size(11.5).text_color(this.error ? t.blocked : t.dim).child(note)))
      .child(buttons(t, this, save).pt(20).text_size(12.5).font_medium());
  }
}

// Asks before a session is deleted, saying what goes with it, drawn as stock's confirm. Enter deletes
// and Esc cancels, as there; a failure stays in the dialog.
export class DeleteSession {
  init(options, cx) {
    this.options = options;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() { this.closed = true; }

  submit(cx) {
    if (this.busy) return;
    const session = this.options.session;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await act(this, session, "delete", {}, cx);
        closeOverlay(this.options.overlay);
      } catch (error) { this.error = errorText(error); }
      finally { this.busy = false; if (!this.closed) cx.notify(); }
    });
  }

  render() {
    const t = theme(), session = this.options.session;
    const { title, detail, kept } = deletion(session, savedSessions(session.endpoint, backendStorage));
    return v_flex().id("delete-session").track_focus(this.handle).size_full().min_h(0).p(18).gap(12).rounded(8).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && !e.is_held) this.submit(cx); // Not the Enter still held from choosing Delete.
        else if (e.key === "escape") closeOverlay(this.options.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(heading(t, title))
      // Not flex_1: the dialog fits its content, and a growing child with no minimum collapses to nothing.
      .child(v_flex().gap(4).text_color(t.muted)
        .child(div().child(detail)).child(div().text_color(t.dim).child(kept))
        .when(!!this.error, el => el.child(div().text_color(t.blocked).child(this.error))))
      .child(buttons(t, this, this.busy ? "Deleting…" : "Delete").text_size(12));
  }
}
