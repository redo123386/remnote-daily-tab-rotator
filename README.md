# Daily Tab Rotator

A RemNote plugin that keeps **today's daily note** as your locked tab. Each day it opens today's
note, locks its tab, and unlocks the previous day's daily-note tab. Locked tabs that aren't daily
notes (lectures, dashboards, Quran Memo…) are never touched.

## Install (local plugin)

1. Install Node.js 18 or newer.
2. In this folder run `npm install`, then `npm run dev`. Leave it running.
3. In RemNote open **Settings → Plugins → Build → Develop from localhost** and enter
   `http://localhost:8080`. If RemNote asks whether to allow native access, allow it — the plugin
   needs it (see *Why native mode*).
4. Open the command palette and run **Daily Tab: Diagnose**. The toast should say today's
   tab is `locked`, `unlocked` or `not open`. If it says *not a tab* for every entry, see
   *Troubleshooting*.
5. Run **Daily Tab: Switch to today's note now** once to do the first rotation.

A localhost plugin loads only while its server is running. For everyday use, run
`npm run build` once and then `npm run serve` (a static server on port 8080) whenever you use
RemNote, or keep `npm run dev` running.

## Two modes

RemNote decides whether a plugin may use **Native mode** (Settings → Plugins → the plugin's
*Native mode* switch). For a plugin loaded from localhost that switch can be greyed out, so the
plugin works either way:

- **Sandboxed (default):** the plugin can't press Lock/Unlock in the tab bar, but it can change
  which note a tab shows — and a lock belongs to the tab. After the day changes, the first time
  you're on the tab showing the previous day's daily note (your locked tab), it swaps that note
  for today's. The lock stays on that tab; other tabs are never changed. It swaps once per day,
  so opening yesterday's note on purpose later is left alone.
- **Native:** the full behaviour below — it opens, locks and unlocks tabs itself.

Commands: **Daily Tab: Switch to today's note now** (in sandboxed mode it swaps the current tab if
it shows a past daily note) and **Daily Tab: Diagnose**.

## What it does in Native mode

- **On startup, at the day boundary, and whenever the window regains focus**, if today hasn't
  been handled yet on this device:
  1. Finds open tabs whose title is an existing daily document (checked with the plugin API;
     nothing is created to check).
  2. If today's note isn't open, opens it. When yesterday's tab is locked it opens from there, so
     RemNote creates a new tab instead of replacing the tab you're in.
  3. Locks today's tab, *then* unlocks older daily-note tabs — so a daily tab is always locked.
  4. Switches to today's tab (optional).
- It runs once per day per device. If you unlock today's tab yourself, it won't re-lock it until
  tomorrow (or until you run the command).
- If any step fails it stops without unlocking anything, retries a few times, then shows a toast.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Rotate automatically | on | Turn off to use only the command. |
| Switch to today's tab after rotating | on | |
| Day starts at (HH:MM) | `00:00` | Use e.g. `04:30` to keep yesterday's note locked until 4:30am. |
| Tab menu labels | `Lock Tab` / `Unlock Tab` | Must match the tab right-click menu exactly. Comma-separate alternatives. |
| Advanced: CSS selector for one tab | empty | Only if Diagnose can't find tabs. |
| Log details to console | off | |

## Why native mode

The RemNote plugin SDK (checked against `@remnote/plugin-sdk` 0.0.46, the latest) has daily-note
APIs but **no API for tabs or tab locking** — `plugin.window` only sees the panes of the current
tab. So the plugin uses the tab bar the way you do: it right-clicks a tab, reads whether the menu
offers *Lock Tab* or *Unlock Tab*, and clicks that item. Sandboxed plugins run in an iframe that
can't see the tab bar, so this one requests native mode.

Safety rules in the code:

- An element is only treated as a tab once its own right-click menu offers Lock/Unlock.
- The only menu items ever clicked are the exact Lock/Unlock labels from settings.
- Every change is confirmed by reading the menu again.
- A tab is unlocked only if its title is an existing daily document and isn't today's.

## Troubleshooting

- **Nothing happens / "needs Native mode" toast** — reinstall and allow native access.
- **Diagnose finds no tabs** — copy the report (it's put on the clipboard) and look at
  `tabCandidates`. Set *Advanced: CSS selector* to something matching one element per tab.
- **RemNote renamed the menu items** — update the two label settings.
- Escape hatch if RemNote misbehaves: open `https://www.remnote.com/notes?disablePlugins`.

## Limits

- Desktop only (`enableOnMobile: false`); tabs are handled per device.
- Any locked daily-note tab other than today's gets unlocked, not just yesterday's.
- Native plugins drive RemNote's UI, so a future RemNote redesign could need a settings tweak.
