# herdr-project-spaces

An extended version of [herdr](https://herdr.dev)'s built-in Spaces sidebar. It shows your [herdr-projects](https://github.com/ingur/herdr-projects) under each space.

![herdr-project-spaces](preview.png)

## Install

Ask your agent in herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: github.com/ingur/herdr-project-spaces
```

It copies the mod, points your Spaces panel at it and adds the keys. Your layout stays yours.

Without an agent:

```sh
git clone https://github.com/ingur/herdr-project-spaces
node herdr-project-spaces/install.mjs
```

## Use

| | |
| --- | --- |
| Click a row | open it |
| Click a closed space | open its unresolved projects and sessions |
| `+` on a space | new terminal |
| `+` on a project | new thread |
| Right-click | rename, move folder, close, resolve, delete |
| Archive icon (on hover) | show or hide resolved ones |
| Drag | reorder, or move a stopped project or session to another space |

Keys (macOS uses `cmd` instead of `alt`):

| | |
| --- | --- |
| `alt-down` / `alt-up` | next / previous row |
| `alt-shift-left` / `alt-shift-right` | fold / unfold |
| `alt-shift-down` / `alt-shift-up` | move row |
| `alt-shift-r` | show or hide resolved |

## Good to know

- It runs the command that a terminal's `projects.control` label names, on that terminal's machine.
- It cannot be combined with another mod that replaces Spaces.

## Update, remove

Ask your agent again, or:

```sh
git -C herdr-project-spaces pull && node herdr-project-spaces/install.mjs
```

To remove: point your Spaces panel back at `spaces` and delete `mods/herdr-project-spaces`.

## Develop

```sh
dev/try-herdr       # separate herdr window and settings
node --test tests/*.test.mjs
```
