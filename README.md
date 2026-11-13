# herdr-project-spaces

A [herdr](https://herdr.dev) sidebar that shows [pi-projects](https://github.com/ingur/pi-projects) under each space: projects, their threads, agents and shells.

It is herdr's own Spaces panel with a few rows added. Everything else stays stock.

## Install

Ask your agent in herdr:

```text
add the mod github.com/ingur/herdr-project-spaces
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
| `+` on a project | new thread |
| Right-click | rename, close, resolve, delete |
| Archive icon | show or hide resolved ones |
| Drag | reorder; drag a stopped project onto another space to move it |

Keys (macOS uses `cmd` instead of `alt`):

| | |
| --- | --- |
| `alt-down` / `alt-up` | next / previous row |
| `alt-shift-left` / `alt-shift-right` | fold / unfold |
| `alt-shift-down` / `alt-shift-up` | move row |
| `alt-shift-r` | show or hide resolved |

## Update, remove

Ask your agent again, or:

```sh
git -C herdr-project-spaces pull && node herdr-project-spaces/install.mjs
```

To remove: point your Spaces panel back at `spaces` and delete `mods/herdr-project-spaces`.

## Good to know

- Based on herdr 0.1.15's Spaces panel. After a herdr update it may need a refresh; it tells you when the versions differ.
- Cannot be combined with another mod that replaces Spaces.

## Develop

```sh
dev/try-herdr       # separate herdr window and settings
node --test tests/*.test.mjs
```
