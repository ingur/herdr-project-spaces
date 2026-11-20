import { div } from "gpui-kit";
import { Button, Input, InputState, h_flex, v_flex } from "gpui-base";
import { closeOverlay, notify, theme } from "herdr";
import { currentSession, errorText, savedSessions } from "./backends.js";
import { act, deletion, sessionMenu, sessionWord } from "./actions.js";
import { actionIO, backendStorage, icon, openDialog, reportError } from "./tree.js";

class Menu {
  init(options, cx) {
    this.options = options;
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() { this.closed = true; }

  choose(index, cx) {
    const item = this.list()[index];
    if (this.busy || !item) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await this.run(item, cx);
        closeOverlay(this.options.overlay);
      } catch (error) { reportError(error); }
      finally { this.busy = false; if (!this.closed) cx.notify(); }
    });
  }

  render() {
    const t = theme(), list = this.list(), ends = list.findIndex(item => ["close", "resolve", "delete"].includes(item.action));
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
export class SessionMenu extends Menu {
  // Props hold the session as its row knew it when clicked; the tree's snapshot is newer.
  session() { return currentSession(this.options.session, backendStorage); }

  list() { return sessionMenu(this.session()); }

  choose(index, cx) {
    const item = this.list()[index];
    if (this.busy || !["rename", "move", "delete"].includes(item?.action)) return super.choose(index, cx);
    closeOverlay(this.options.overlay);
    openDialog(item.action, this.session());
  }

  // shortcut: where a stopped session opens was decided as this menu opened; decide here if menus ever stay open long.
  run(item, cx) { return act(item.action, this.session(), item.action === "open" ? this.options.open : {}, actionIO(cx, this)); }
}

export class SpaceMenu extends Menu {
  list() { return [{ title: "Remove space", action: "resolve", icon: "check" }]; }

  async run(item, cx) {
    for (const session of this.options.sessions) await act(item.action, currentSession(session, backendStorage), {}, actionIO(cx, this));
  }
}

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

// Asks for one line about a session, drawn as stock's prompt: the name of a new thread under the project
// in props (role "new-thread"), a session's new name (role "rename"), or the folder a stopped session's
// folder was moved to (role "move").
export class SessionLine {
  init(options, cx) {
    this.options = options;
    this.create = options.role === "new-thread";
    this.move = options.role === "move";
    const value = this.create ? "" : this.move ? options.session.folder : options.session.title;
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
    const line = this.input.value().trim(), session = this.options.session;
    if (this.move && !line.startsWith("/")) { this.error = "Enter the folder's full path."; cx.notify(); return; }
    if (/[\x00-\x1f\x7f]/.test(line) || (!line && !this.create)) { this.error = this.create ? "Enter a printable name, or none." : "Enter a nonempty, printable name."; cx.notify(); return; }
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = this.move ? await act("move", session, { folder: line }, actionIO(cx, this))
          : await act(this.create ? "create-thread" : "rename", session, line ? { title: line } : {}, actionIO(cx, this));
        closeOverlay(this.options.overlay);
        if (result.focusError) notify({ title: `Thread "${result.title}" created`, body: `Click its row to open it; do not create another thread to retry. ${result.focusError}`, level: "info" });
      } catch (error) { this.error = errorText(error); }
      finally { this.busy = false; if (!this.closed) cx.notify(); }
    });
  }

  render() {
    const t = theme();
    const title = this.create ? "New thread" : `${this.move ? "Move folder of" : "Rename"} ${sessionWord(this.options.session)}`;
    const save = this.create ? (this.busy ? "Creating…" : "Create") : this.busy ? "Saving…" : "Save";
    // In the place of stock's hint ("empty: its number"): what went wrong, else what an empty name does.
    const note = this.error || (this.create && "empty: it names itself") || (this.move && "where the folder is now; nothing is moved");
    return v_flex().id("session-line").track_focus(this.handle).w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.options.overlay); cx.stop_propagation(); } })
      .child(heading(t, title))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child(this.move ? "Folder" : "Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.focused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground).accessibility_label(this.move ? "Session folder" : "Session name"))
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
        await act("delete", session, {}, actionIO(cx, this));
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
