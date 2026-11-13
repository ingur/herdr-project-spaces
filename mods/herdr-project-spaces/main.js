import { View } from "gpui-kit";
import { props } from "herdr";
import ProjectTree from "./tree.js";
import { DeleteSession, NameSession, SessionMenu } from "./session-overlays.js";

const ROLES = { "session-menu": SessionMenu, rename: NameSession, "new-thread": NameSession, delete: DeleteSession };

// Use the same per-overlay role convention as the installed native mods.
export default class ProjectSpaces extends View {
  init(_options, cx) {
    const options = props() ?? {};
    this.role = new (ROLES[options.role] ?? ProjectTree)();
    this.role.init(options, cx);
  }

  render(cx) { return this.role.render(cx); }
  close() { this.role.close?.(); }
}
