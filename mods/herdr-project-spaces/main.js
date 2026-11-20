import { View } from "gpui-kit";
import { props } from "herdr";
import ProjectTree from "./tree.js";
import { DeleteSession, SessionLine, SessionMenu, SpaceMenu } from "./session-overlays.js";

const ROLES = { "session-menu": SessionMenu, "space-menu": SpaceMenu, rename: SessionLine, "new-thread": SessionLine, move: SessionLine, delete: DeleteSession };

// Use the same per-overlay role convention as the installed native mods.
export default class ProjectSpaces extends View {
  init(_options, cx) {
    const options = props() ?? {}, Role = ROLES[options.role];
    // The tree is a View, whose constructor calls its init as Herdr's does; the overlays are plain classes.
    this.role = Role ? new Role() : new ProjectTree(options);
    if (Role) this.role.init(options, cx);
  }

  render(cx) { return this.role.render(cx); }
  close() { this.role.close?.(); }
}
