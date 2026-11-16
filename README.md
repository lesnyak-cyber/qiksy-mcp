# qiksy-mcp

> **This server needs the free Qiksy Bridge Chrome extension. On its own it has nothing to drive.**
>
> 1. Install **Qiksy Bridge** from the [Chrome Web Store](https://chromewebstore.google.com/detail/jcnbcbpndahhblhobhjjkhafmbkleoem) (free, no account).
> 2. Click its icon, turn the **MCP bridge** On and press **Generate**.
> 3. Press **Copy agent config** and paste it into your agent's MCP settings (`.mcp.json` for Claude Code, `~/.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code). Restart the agent window.
>
> That is the whole setup: the agent now works in the Chrome you already have open, with your logins.

A **browser MCP server** for the tab you already have open. Pairs with **Qiksy Bridge**, the [Qiksy](https://qiksy.app/qa-copilot/) Chrome extension. It lets any MCP-capable coding agent, **Claude Code, Cursor, Cline, Windsurf, Zed, VS Code**, read the live QA state (findings with CSS selectors, detected forms, failed requests with server error bodies, recorded repro steps) straight from the browser, so you can say *"fix what Qiksy found on this page"* and the agent has the full context.

With **Agent control** switched on (free, one confirmation in the popup) the agent also **acts** in that tab: it fills whole forms, clicks, uploads files, navigates and follows a multi-step task to the end, all inside the session you are *already logged into*. That is the whole reason to use this rather than a cold automated browser: no second browser, no re-login, SSO and staging just work. Until you switch it on, the agent only reads.

## How it works

```
agent  ⟷ (MCP over stdio, JSON-RPC)  ⟷  qiksy-mcp  ⟷ (WebSocket @ 127.0.0.1)  ⟷  extension service worker
```

The extension is the WebSocket **client** (a service worker can't listen on a socket); this process is the WebSocket **server**, bound to loopback only. When the agent calls a tool, this process passes it to the extension, which answers from the live page.

## Two things to know before you wire it up

**All of it is free.** No licence, no trial, no key and no account. The one gate is the
**`drive` consent**: reading is unconditional, while acting on the application under test
asks the human once, in the popup.

**`npx qiksy-mcp` always runs the latest build**, with every tool
including `qa_follow` (a task of several steps answered step by step), a filterable full-page `qa_snapshot`, `qa_fill_json` (a whole wizard step,
custom dropdowns, calendars, cascaders, trees, tags and time included, in one call),
the `qa_pick_*` verbs for the composites, `qa_probe` for the one control that refuses,
recipes that make the second run cheap (`qa_recipe_save` / `qa_recipe_list` /
`qa_recipe_apply`), and Agent control (`qa_click`, `qa_type`, `qa_press`, `qa_upload`,
`qa_navigate`, `qa_open_isolated`, `qa_close_tab`). Just `npx qiksy-mcp`, no clone, no
local path, no version to pin (it always fetches `latest`). (For hacking on the bridge
itself, see **Local run** at the bottom.)

**The manual installs itself, on the first run in a project.** The agent starts this process
with the project as its working directory, so the process already knows where the docs belong:
it writes the full agent guide to `.claude/qiksy-bridge.md` and adds a short, marker-fenced
block to `CLAUDE.md` / `AGENTS.md`, the rules that decide whether a run goes well. **The
bridge is the first browser tool in the project**; a form is one call; a control that refuses
is a ladder, not a reason to reach for a second browser driver; and the only thing worth
handing over for is arbitrary JavaScript (`evaluate`).

It is careful about it: only where a project actually is (a `.git`, a `package.json` or an
agent file already present, a bare `$HOME` gets nothing), byte-idempotent (identical content
is not rewritten, so `git status` stays quiet on every later launch), nothing outside the
markers is ever touched, and **`QIKSY_MCP_NO_DOCS=1` turns it off**. The pointer is read at the
START of a session, so it takes effect from the next one; the guide itself is readable
immediately, and the first tool reply says where it went.

Run it by hand any time with **`npx qiksy-mcp init`**, same result, plus a printed summary.
Flags: `--dir <project>`, `--out <path>`, `--no-claude` (print the block instead of writing it).

## Tools

Eighty-two in total. **Read**: sense the page (all accept an optional `tabId` from `qa_tabs`; default = the tabs you attached to the agent session, or the active tab if you attached none):

| Tool          | What it returns |
|---------------|-----------------|
| `qa_tabs`     | Every browser tab Qiksy can read, incl. which are **isolated multi-login sessions** (`isolatedSession` = the login name). Use a tab's `tabId` with the other tools to read that specific login. |
| `qa_status`   | URL + error/warning/form counts + isolated-login name. |
| `qa_read`     | The **rendered text** of the page or of one element (`ref` / `selector`). The companion to `qa_snapshot`, which maps what you can ACT on and caps every name at 80 characters, so a one-time code in a mail tab, an error paragraph or a generated invoice number is invisible to it and plain here. `innerText`, so hidden branches and a collapsed quoted history stay out. |
| `qa_styles`   | **Computed styles of one element, its box in CSS pixels, and the design TOKENS in scope for it.** `color: rgb(37,99,235)` says what is drawn; `--accent: #2563EB` says which token decided it, which is how a built page is checked against a design without a screenshot and without measuring by eye. |
| `qa_storage`  | The app's own `localStorage` / `sessionStorage`. Reading is free (`op: list \| get`); `set` / `remove` / `clear` WRITE and take the same gates as a click, because changing a stored token changes what the app does. In a multi-login tab it reads the isolated session's store, not the profile's. |
| `qa_axe`      | The full **axe-core** rule set against the live DOM, the industry engine, bundled in the extension, run on the page as it is right now with its real data and its real state. `qa_run_audit` is Qiksy's own faster sweep; this one is the standard. |
| `qa_screenshot` | **A real picture** of the page or of one element. The panel is hidden and password and card fields are covered BEFORE the frame is taken. Its one condition: the tab must be in FRONT, because the browser photographs the active tab and this extension refuses to hand you a different one. |
| `qa_wait_for` | Wait for ONE named condition and return the moment it is true: `appears` · `disappears` · `enabled` · `text` · `textGone` · `countOf` (+`atLeast`/`exactly`) · `announced` · `urlContains`. A named condition instead of a sleep, the sleep is either too short to be true or too long to be cheap. |
| `qa_follow` | **A task of several steps, followed instead of stopped after each one.** Turn it on with the goal; until `qa_done` every click, key, fill, upload and navigation answers with the step it led to: the page waited for until it stops loading, where the wizard is, what changed (a button became active, an error appeared), the fields left and the live buttons. A step that is the PERSON's (a password, a code, a captcha) is named as such, and `waitForPerson` shows them a line beside the field and returns by itself when the page moves on. |
| `qa_focus_walk` | Presses Tab through the page and reports the ORDER focus actually takes, what each stop is, and where the ring is invisible or the order jumps. Needs the tab in front, like anything that involves real keys. |
| `qa_findings` | Findings (with selectors + detail); `severity` = `all` \| `error` \| `warning`. |
| `qa_export`   | The full `qa-export/v1` bundle: findings, failed requests + bodies, form structure, repro steps, env. |
| `qa_annotate` | **Marks that name an ELEMENT, not a coordinate.** A box, a numbered pin, or an arrow between two controls, placed from the page at capture time, so the same instruction draws the correct picture after a re-render or at another width. `fromFindings` makes the page's own findings draw themselves. A mark whose element is not there is reported, never dropped. |
| `qa_focus_proof` | **Is focus visible on this control?** Two measurements instead of an argument: which ring-drawing property changed, and what fraction of the PIXELS differ between the two frames. A screenshot of a missing ring looks exactly like one of a faint ring; «0% of the pixels differ» does not. |
| `qa_wiring`   | **Which error message is attached to which field, and which to nothing.** Proximity on screen is not association; assistive technology reads the attachment. Under-reports on purpose, a message inside its label, or a summary linking to its fields, is correct by another route. |
| `qa_diff`     | **What changed, by control rather than by pixel.** «The Submit button moved 8px down, padding 8 → 12, and it went disabled» instead of «23 417 pixels differ». Text is not compared: a name or a total differs between two healthy runs, and that noise is why pixel diffing gets switched off. |
| `qa_failure_gallery` | **How this screen looks when everything goes wrong**: empty, 500 with the server's own words, a held request, 403, a dropped connection, as one self-contained HTML sheet. It CAUSES the failures rather than waiting for them, and always removes the rules afterwards. |
| `qa_collect`  | **A table instead of a page.** Name which nodes (`selector` / `role` / `nameContains`, scoped by `within`) and which properties to `take`, `text`, `value`, `name`, `role`, `tag`, `selector`, `href`, `state`, `geometry`, plus `attr:<name>` and `style:<property>`, and the answer is that table, once. «Every row with its price», «every input with what it holds» is one call here and a dozen with a snapshot plus a read per element; `value` is what a control HOLDS, which a snapshot cannot tell you. A property nobody can supply is named back rather than dropped. |
| `qa_watch`    | **Watches for a few seconds**: the one question the other verbs cannot answer. Everything else reports NOW, so a toast that appears and leaves, a request fired by a timer, a late row or a live-region announcement are invisible to a snapshot taken before or after them, and polling misses the gaps between looks. `op:"start"` with `what`: `mutations` \| `network` \| `console` \| `announcements`; then `op:"read"` for the buffer. **Every watch expires by itself**, `ttlMs` is capped at two minutes and there is no «until stopped», because a watch left running is silent and the readings taken after it are the ones that go wrong. Observes only: no consent beyond the bridge. |
| `qa_gap`      | **What the bridge could not do**, in one sentence, appended to `~/.qiksy/gaps.jsonl`. The sanctioned way out of a dead end, the unsanctioned one is a quiet switch to another browser driver, which has none of your logins and ends the run's meaning. `op:"list"` reads them back. |
| `qa_snapshot` | A full-page accessibility snapshot, interactive elements + landmarks with their roles, labels and a `ref` you can pass to `qa_click`/`qa_type`/`qa_press` instead of a CSS selector. Read-only. **One snapshot owns its refs**: taking a new one renumbers them, so `e12` from an earlier snapshot may now be a different control and the click will succeed on the wrong thing, keep only the latest snapshot's refs, or target by `name`. **Narrow it** on a component-heavy app: `fields_only` (form controls only), `roles: ["button"]`, `match` on the accessible name, `within: "<selector of a container>"` for one dialog or wizard step, `limit`, `format: "tree"` for about half the bytes. Filtering happens on the way out, so the refs you get back are as valid as the full tree's. |


**Asking a reply for the fields you want.** The big reads (`qa_snapshot`, `qa_export`, `qa_findings`,
`qa_axe`, `qa_run_audit`, `qa_collect`, `qa_watch`) take `select`, keep only these field paths, and
`omit`, drop these: `qa_snapshot { select: ["nodes[].name", "nodes[].ref"] }`. Dots walk into
objects, and a path through a list applies to every entry while keeping it a list, so anything you
already knew about the reply stays true. A path that matches nothing is reported back with the field
names that *are* there, so a mistyped field costs one call rather than a bigger request. Paths only:
no expressions and no code, the caller names a field, exactly as every verb here names an element
rather than a program.

**Command**: drive Qiksy's own UI / analysis (never the app under test; all accept `tabId`):

| Tool            | What it does |
|-----------------|--------------|
| `qa_open_panel` | Open/close the Qiksy side panel and optionally jump to a tab (`forms` \| `findings` \| `tour` \| `tools` \| `history` \| `roles`). |
| `qa_run_audit`  | Run the a11y/markup audit on the current DOM and return the findings (also refreshes the panel). Static, read-only DOM analysis. |
| `qa_tour`       | Return the generated exploratory-testing checklist (from forms + interactive surfaces), auto-checked from the recorded session, raw material for test cases. Markdown + structured items. |
| `qa_report`     | Generate Qiksy's self-contained HTML session report and return the HTML (needs History recording to have captured steps). |
| `qa_spotlight`  | Dim + outline an element (by `ref` or CSS selector), with an optional caption, so the human can see what the agent means. A non-destructive overlay, no click/focus/mutation. |
| `qa_focus_tab`  | Bring a tab in front of the human, activate it, raise its window, so a walkthrough happens where they are actually looking. The one verb that deliberately takes their attention: scoped to the app under test and its isolated logins, and meant for "show me", not for the agent's own convenience. Pair with `qa_spotlight`, whose `label` turns a run of clicks into "step 3 of 6". |
| `qa_open_tab`   | Open an address the driving verbs will not navigate to, as a **new** tab, beside the ones already open, losing nothing. The out-of-scope refusal stays exactly as it is; this is the sanctioned way through it. It lands in the right browser by construction: a machine has several Chrome profiles, the extension lives in one, and naming a profile does not work (a running Chrome ignores the flag and still exits 0), so this anchors on a tab the bridge can already see and inserts the new one into that window. Read the answer: `inSession: true` carries the tabId to drive; `inSession: false` means it is open but the human has to switch "Agent drives this tab" on for it. macOS for now. |

| `qa_width_law`  | **What width the code DECLARES, not what it measured.** «The container is 1360 wide» is a fact about the window it was measured in, true now, false one drag of the mouse later, which is why comparing a layout to a mockup by measuring has never worked. This reads the declarations on the layout spine instead: how many width ceilings exist, which element sets the tightest, and what content band follows at any window. Pass `figmaWidth` (one number off the design) and it prints the two declarations side by side plus what follows, and never says which one is right, that is the human's call. Values that move with the window (`clamp()`, `vw`, `%`) declare no single law, so they go to `notMeasured` with the reason rather than being resolved at the current width and printed as if they were fixed. Narrow boxes are not judged: a sidebar is narrow on purpose. Read `notMeasured` FIRST, a clean page and an unexamined one look identical without it. |

| `qa_frames`     | **A page is often several documents, and the interesting one is usually not the outer one.** A payment form, an SSO step, a chat widget, a Stripe or 3-D Secure field: each lives in a frame of its own, and a frame from another domain cannot be read from the page around it, that is the same-origin rule, and no amount of JavaScript gets past it. Qiksy enters the frame instead and answers about its own document. This lists them: `frameId`, address, title and how many controls each holds, the page itself first. Pass that `frameId` to `qa_read` and `qa_styles`. **Call it the moment a control you can SEE is missing from `qa_snapshot`**, nine times out of ten it is not missing, it is in a frame nobody named. Nothing is loaded into a frame until one is asked about, so an ordinary page costs what it always did, and no new permission is involved. |

Because tools accept a `tabId`, an agent can read **several logins at once**: call `qa_tabs`, then `qa_export` per isolated tab to compare what admin vs. member vs. anon each see.

**Agent control**: these ACT on the app under test:

| Tool       | What it does |
|------------|--------------|
| `qa_click` | Click an element by `ref`, by CSS selector, or by the control's accessible **`name`** (`{ name: "Next", role: "button" }`). Use the name right after a fill: a fill re-renders the step, and a ref from before it either gets refused as stale or, worse, after any new snapshot, silently means a different control. The bridge resolves a name against a snapshot it takes at that moment. Sends the full pointer sequence (`pointerdown` → `mouseup` → `click`), so Radix/shadcn/MUI components that listen for `pointerdown` react like they would to a real click. Scrolls into view first; refuses a selector that matches nothing or has zero size instead of silently doing nothing. |
| `qa_type`  | Set ONE field of **any kind** to a value. This is the extension's own fill engine, not a keystroke emulator, so the same call covers text/number/date inputs and textareas (native setter + `InputEvent`, so React/Vue controlled inputs keep the value), native `<select>` (matched against the option labels), checkboxes and radios, sliders, contenteditable rich text, **and** the widgets that look like they need clicking: Radix/shadcn, MUI, Ant, react-select dropdowns, typeahead comboboxes, popup date & time pickers. It opens the popover, waits for the options, picks the match and verifies the trigger changed. Reports `stuck: false` when the field rejected the value, masked, read-only or controlled. |
| `qa_type` + `raw` | **Put the value straight in.** Writes the string verbatim through the native value setter (React swaps `value` for its own tracked property, so a plain assignment is reverted on the next render) and commits with a key. Measured: a date **0.30s against 26s** through its calendar, a time 0.30 against 14, a range 0.60 against 35. For controls that PARSE text, dates, times, range ends, tags, in the format the control DISPLAYS. `pick: true` adds the other half for a select: write to filter, then click the matching option. `open: true` opens the list first (a select filters only while it is up); `blur: true` for a tags field, which keeps its value only once focus leaves. A select that must choose from its own list keeps the ordinary engine path. |
| `qa_type_many` | Fill a WHOLE form, or one step of a wizard, in ONE call: an array of `{ ref \| selector, value, action? }`. **Every widget kind `qa_type` drives goes in the same batch**, a batch where half the entries are dropdowns and dates is the normal use, not an edge case. Prefer `ref`: a form built from a repeated component gives several inputs the identical cssPath, and a batch of selectors would pour every value into the first match. Returns a per-field result list + filled/total; only an entry that came back `ok:false` is worth a follow-up call. |
| `qa_fill_json` | Fill a form from a plain `{ "Field label": "value" }` object, a value of **`"click"`** presses the thing instead (a chip, a custom radio, a switch, any control that takes no value), and **`"Label#2"`, `"Label#3"`** address the 2nd and 3rd control sharing one label, which is how a form built from a repeated component is filled, **the same shape as the JSON behind the panel's `{ }` editor and its ⚡Fill button**. It snapshots for you, resolves the labels (exact → truncated → contains) and hands the whole lot to the batch filler, so the agent needs no refs and no snapshot of its own: one call for a form it has never seen. Keys that matched nothing come back **with the page's real field names**, so the next call fixes its own key. Keys are read in order, so on repeated labels the Nth key takes the Nth control. `dry_run` resolves without filling. |
| `qa_upload` | Attach a file to an `<input type=file>`, including the hidden one behind a styled dropzone: `path` (this process reads it, so the bytes never enter the agent's context), `content` as base64, or a hostile `fixture` built in the page. `files: [...]` attaches several in one round trip. |
| `qa_pick_date` | An EXACT date in one call, whatever library owns the calendar. Types it first (two calls, and correct for most inputs); if the value does not stick, opens the picker and steers it, MUI X's year view, Ant's clickable header year, react-datepicker's month/year dropdowns, plain arrows otherwise, stepping until the header agrees, then clicking the day. Reports `via` and a `trail`, so an unrecognised picker is visible rather than silent. **Use it for MUI X date fields**: they are three contenteditable sections the component rebuilds from its own state, so a written "14" can land in the YEAR and the day stay empty. |
| `qa_pick_path` | A value that lives across several levels, in one call: an Ant Cascader (country → region → city), a submenu chain, a drill-down. Opens the control and clicks each level on a FRESH snapshot, because opening a level is what re-renders the popup. A level that never appears is reported with the ones that did. |
| `qa_pick_tags` | A whole list of tags on a control that CREATES its values, Ant's Select in `mode="tags"`, and every chips input built the same way. Per tag it types, **verifies the text is still in the field**, then presses the key, on a ref re-resolved each time. The verification is the whole point: when a tag commits the component clears its own search input, the re-render can wipe a value written a moment earlier, and the key then re-submits the PREVIOUS text, which in tags mode toggles that tag back **off**, so the form loses the tag you added first. It also never clicks the field first (a click moves the caret out of the search input). |
| `qa_pick_time` | A time on a column-based picker (Ant's TimePicker). Needed because the cells are bare list items with NO role, invisible to the snapshot, and the ordinary fill path misreads the control as a date field, types an ISO date into it and leaves it empty *while reporting success*. This reads each column's text, finds which entry is your value, clicks that child, then presses the panel's own OK, which is not optional: without it the value stays provisional. |
| `qa_pick_range` | Both ends of a date range that live in ONE control (Ant's RangePicker). Not two `qa_pick_date` calls: the control walks from the start panel to the end panel itself, and approaching it cold a second time restarts the range on the start input. Says so plainly when the panel closes after the start, then the end is its own field. |
| `qa_press` | Dispatch a key (`Enter`, `Escape`, `Tab`, …). Without a selector it goes to the focused element, like a real keyboard. |
| `qa_probe` | **What kind of widget is this, and how do I drive it?**, for the one control that refused a value. Judges by SHAPE first (role, tag, name, state, neighbours), which settles a sectioned date field, a file input, a switch or a slider **without touching the page**; when the shape says nothing, the case of a widget hand-rolled from `<div>`s, where role is `generic` and there is no name and no state, it clicks once, reads what the page DID, and presses Escape to put it back. Returns the `kind`, the `verb` that drives it, and `why`. The verdict worth the most is `portalled-invisible`: it opened and the accessibility tree gained NOTHING, which means role-less markup in a portal (Ant Design) and the parts must be addressed by CSS selector. |

| `qa_hover` | Put the pointer on something **and leave it there**, a tooltip, a menu that opens on hover, a row that shows its actions only under the cursor. A click would commit to something; this does not, and the hover survives the next read, which is the whole point. |
| `qa_click_point` | A click at an x/y INSIDE a named element, the canvas, the map, the chart, the signature pad: surfaces with no controls to name. The coordinates are relative to that element, so they survive a re-layout that would move an absolute point. |
| `qa_drag_point` | A drag from one point to another inside a named element: a slider handle pulled along its track, a map panned, a range brushed on a chart. Same reasoning as `qa_click_point`, it names an ELEMENT and moves inside it. |
| `qa_reload` | Reload the tab and wait until the page answers again. An action, not a read: an unsaved form dies with it, which is why it takes the same gates as a click. |
| `qa_dialogs` | What the page's **native dialogs** do, `beforeunload` ("Leave site?"), `confirm`, `alert`, `prompt`. Nothing can click those: they are browser chrome, outside the document. This decides their answer instead, per tab, off by default, and **every suppressed dialog is reported as a finding carrying the question the page asked and the answer given**, the app DID ask; Qiksy answered. `op:"list"` is free; setting one takes the drive gates, because an auto-accepted `confirm()` can be the one in front of Delete. |

**One step of a multi-step form is one call**, and this is the single biggest difference
between a fast run and a slow one:

```
qa_follow { goal: "create the initiative" }          → once, at the start: every press now answers with the next step
qa_fill_json { fields: { "Initiative name": "Test run", "Country": "Ukraine",
                         "Start date": "2026-08-01", "I agree": true }, advance: "Next" }
                                                     → the whole step, labels instead of refs, then Next
```

Keep `qa_snapshot` + `qa_type_many` for when you must pick a specific control among duplicates.

Opening a dropdown, snapshotting to read its options and clicking one works, but it pays
a settle window twice per field and costs three round trips where the batch costs a share
of one. Keep it for an entry the batch reported `ok:false`.

**Recipes**: so the second run is the cheap one. Refs live for one snapshot and a new
session starts with nothing, which is why a form that took twenty calls to work out used to
take twenty again. These three keep the flow on your machine, in field NAMES:

| Tool | What it does |
|------|--------------|
| `qa_recipe_save` | Writes what the agent just filled, uploaded and clicked to `~/.qiksy/recipes/<name>.json`, folded into steps (a click after a group of fills is what ends a step of a wizard). Pass `steps` to write or correct one by hand. Local only, no browser, no Pro. |
| `qa_recipe_list` | The saved flows, newest first: host, step count, the first step's field names. Worth one call before starting anything form-heavy. |
| `qa_recipe_apply` | Replays a recipe against the page as it is **now**, per step it snapshots, matches every field by accessible name (exact → truncated → contains → the stored cssPath), fills the step in one batch, attaches its uploads and clicks the advance control. `values` overrides the stored data (one flow, many datasets); `dry_run: true` resolves everything and touches nothing; `all: true` walks the remaining steps, which means it will click a final Submit, so keep it stepwise on anything irreversible. A target the page no longer has comes back under `missing` instead of failing silently. |

The recipe is a plain JSON file you own, editable, deletable, never uploaded.
`QIKSY_RECIPES_DIR` moves the folder (e.g. into the project, to share flows with a team).

### Reports land in the project, not in a download folder

This process is started **from the folder you work in**, so it knows which project a run is about
and files the paperwork there. `qa_report_build` with no `out` writes
`qiksy-reports/<date>-<subject>.html` under that folder, and the reply carries the path. The
panel's own **Report** button goes to the same place while the bridge is connected, and falls back
to an ordinary browser download when it is not, the toast says which of the two happened.

Why there and not `~/.qiksy`, where the recipes live: a recipe is a tool, and the same login flow
serves every project; a report is the work itself, attached to a ticket and read by somebody else,
so it belongs beside the code it is about. `QIKSY_REPORTS_DIR` moves the folder, and `off` means
write nothing unless a path is named. A folder with none of `.git` / `package.json` / `CLAUDE.md` /
`AGENTS.md` is not treated as a project, and neither is your home directory.

### Pictures, and a shelf both hands can reach

A screenshot usually leaves the tool the moment it is taken, and everything after that is
description. Here it stays: the extension keeps a **shelf** of shots, the tester can draw on one
by hand in the panel, and the agent reads those marks back as DATA rather than as pixels, which
is the difference between "look at the red box" and a mark that says which element it points at.

| Tool | What it does |
|------|--------------|
| `qa_shot_list` | The shots on the shelf, name, when, size, and the marks each one carries. |
| `qa_shot_read` | One shot back out: its image and, separately, its marks with the element each one names. |
| `qa_shot_mark` | Add marks to a shot already on the shelf, a box, a numbered pin, an arrow between two controls, a note. Marks are DATA on top of the picture, so re-drawing one changes every document that holds it. |
| `qa_shot_crop` | Crop a shot to a region or to one marked element, keeping the marks that survive the cut. |
| `qa_shot_drop` | Forget one shot. |

`qa_annotate` is the other way in: it marks the LIVE page by naming elements and photographs
the result, so the same instruction draws the correct picture after a re-render or at another
width.

### Reports, and the hour after one is written

| Tool | What it does |
|------|--------------|
| `qa_report` | Qiksy's own session report as self-contained HTML (needs History recording to have captured steps). |
| `qa_report_build` | **Build a report from BLOCKS you pass**, a heading, a paragraph, a finding with what was expected and what happened, a picture held by NAME from the shelf. One assembly, so a document written by hand in the panel and one written by an agent are the same document. `save: true` keeps it in the extension under a name. |
| `qa_reports` | The reports the extension is holding, so «send me the one from this morning» has an answer that is not «look in your Downloads». |
| `qa_report_get` | Take one back out, as HTML or written to a path you name. Open it and print to PDF; the structure is the same on paper. |
| `qa_report_drop` | Forget one. |
| `qa_draft` | **The report being written right now**, the same draft the person is filling in the panel, with every line and its POSITION. A screenshot they flicked in this morning is in it; a line you add appears on their screen. |
| `qa_draft_add` | Put a line in as it is noticed, the same block shapes `qa_report_build` takes. It answers with how many lines actually LANDED, which at the cap is not the same as how many were offered. |
| `qa_draft_edit` | Rewrite the line at a position, in place. Deleting and re-adding would move it to the end, which is rarely where it belongs. |
| `qa_draft_move` · `qa_draft_drop` | Reorder by destination, or take a line out. |
| `qa_draft_meta` | The document's own title, and what kind it is: issues · verified · notes. |
| `qa_draft_clear` | Abandon it. There is no undo here and the draft may be an hour of somebody else's work, read it first. |
| `qa_draft_build` | Turn the draft into the document, kept by default. **The draft is only emptied if the document was really kept**, when the browser has no room the HTML still comes back and the lines stay. |
| `qa_report_edit` | Read back the blocks a saved document was built from, change them, rebuild it under the SAME name. The run's own context is carried over and is not rewritten. |

### Scenarios, a flow recorded once, replayed later

Recipes (above) are the agent's own journal folded into steps. Scenarios are the **tester's**:
recorded by hand in the panel, stored per project with tags, and visible to the agent so it never
has to ask somebody to read names out of a panel.

| Tool | What it does |
|------|--------------|
| `qa_scenarios` | The saved scenarios, with their projects and tags. Free, listing is a read. |
| `qa_scenario_get` | One scenario's steps, as data. |
| `qa_scenario_save` | Write or correct one. It stores data and touches no page, so it sits with the reads. |
| `qa_scenario_run` | Replay one against the page as it is now. This types and presses, so it takes the drive gates, and it stops at the first field the page no longer has rather than filling the wrong thing. |
| `qa_suite_run` | A whole project of scenarios as ONE set, with a single answer about the lot. |

Passwords and card numbers are recorded as **fields, never as values**, a scenario is a document
that can be shared, and an imported one is stripped of every address that leaves its own site
before it can run.

### Saying the run is over

| Tool | What it does |
|------|--------------|
| `qa_done` | **Call it when the work is actually over.** The mark on every driven tab the person is NOT looking at then pulses slowly, so somebody who walked away from the screen can see from across the room that it ended; it stops by itself when they look at that tab, and a tab already in front is never pulsed. A short sound plays too, for somebody not looking at the browser at all. It is a nudge, not a report, still say what you did. It is not a progress beat either: called between steps it teaches people to ignore it, which costs the signal its only job. |

### Qiksy talking to you

Now and then a tool result carries `qiksySays`, a line for the **human**, which the agent is asked
to pass on in your language. It says hello the first time, and after that it speaks only when
something happened: your agent went quiet for a long time, the same control got clicked three times,
a couple of fields refused their values in a row, or a long form is worth saving as a recipe. It is
blunt and it swears mildly, and it is rationed on purpose, an 8-minute floor, a 10–30 minute gap
per kind of remark, five lines per session, so 40-odd calls produce at most one.

| Variable | Effect |
|---|---|
| `QIKSY_MCP_VOICE=rude` | Default. The character, as described above. |
| `QIKSY_MCP_VOICE=nice` | Same moments, polite wording. **Chosen automatically in CI** (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `TEAMCITY_VERSION`, `JENKINS_URL`) so a pipeline log and a customer demo stay strictly business. |
| `QIKSY_MCP_VOICE=off` | Nothing addressed to the human at all. |
| `QIKSY_MCP_QUIPS=0` | Silences the voice *and* the decorative `qx …` line on every result. |

**Chaining**: what makes a multi-page, multi-role run reliable:

| Tool               | What it does |
|--------------------|--------------|
| `qa_wait_ready`    | **Free.** Block until the tab finished loading AND a fresh Qiksy answers in the new document. Call it after anything that navigates, a submit, a link click, `qa_navigate`, before the next `qa_type`/`qa_click`, or the call lands on a page still being replaced. `timeoutMs` default 15000, max 60000. |
| `qa_navigate`      | Point a tab at a URL and wait for that same ready signal (built in). |
| `qa_open_isolated` | Open one or MANY tabs, each with its own private session, `sessions: ["admin","manager","member","viewer"]` or `count: N` (max 12). Returns a `tabId` per login; pass it to any tool to run the whole flow as that user. **Also needs the multi-login confirmation**, because it intercepts the site's cookies, a separate acknowledgement from Agent control. |
| `qa_close_tab`     | Close one tab (`tabId`) or a batch (`tabIds`), how you tidy up after a role matrix. |
| `qa_mock`          | Answer a request from a **rule** instead of the server, a 500, an empty list, a malformed payload, a 30s delay, a dropped connection (`fail`). The failure branches are the ones nobody tests, because a working backend will not produce them on demand; `times: 1` mocks the first call and lets the retry through, which is how you prove a retry exists. `url` is a substring or `/regex/`. A rule belongs to **one tab**, survives its reloads, dies with it, and covers the page's own `fetch`/`XHR` in the **top frame only**, not the document, subresources, WebSocket/EventSource, `sendBeacon`, iframes or the page's service worker. Mocked answers are marked `(mocked)` in the session, the HAR and the report. `op: "list"` is free; `set`/`remove`/`toggle`/`clear` take the gates below. **Clear your rules when done.** |

Two independent gates, re-checked on **every** call, both inside the extension where the server cannot bypass them:

1. the **`drive` consent**, granted separately from the bridge's own (Qiksy panel → Tools → **Agent control**) and revoked when you switch it off, so the warning is faced again next time;
2. the bridge itself, loopback only, shared token, off by default.

There used to be a third, a Pro licence or an unexpired trial; it went when the price did, in 1.72.0. Fail the consent and the call returns `consent-required` and does nothing. **It acts for real**: it can submit, spend and delete under your live login, with no undo. Point it at test environments.

## Driving the browser: Agent control is the hands

**Agent control** drives the browser *you are already using*, the session you logged into by hand, including isolated multi-login tabs. Nothing to launch, no second browser, no re-authentication. It clicks, types, fills a whole wizard step in one call, drives calendars, cascaders, trees, tags and time pickers by their own verbs, attaches files, navigates, and opens isolated logins. **This used to say "pair Playwright MCP for the clicking"; that advice is out of date**, it predates `qa_fill_json`, the `qa_pick_*` verbs and `raw`, and following it now costs you the one thing the bridge is for.

**Rule zero for an agent on this bridge:** do not switch to a second browser driver (Playwright, Puppeteer, Selenium, CDP) because a control looked unfamiliar or refused once. That driver opens a *different, empty* browser, none of your logins are in it, so the run stops being the test you asked for. A refusal is a rung on a ladder: `qa_probe { name }` → `raw: true` → the widget's own `qa_pick_*` verb → a CSS selector (every verb takes one) → `qa_click { name }` and read the `widget` verdict → `qa_focus_tab` if the tab is in the background.

**The one genuine gap**, and the only honest reason to reach for another tool:

- **arbitrary JavaScript**, no `evaluate`, by design (a Web Store requirement). Every verb names an element, never a program.

**Pixels are no longer on that list.** `qa_screenshot` returns a real picture of the page or of one element, with the panel hidden and password and card fields covered before the frame is taken; `path` writes it to a file instead of spending your context on base64. One condition, and it is real: the browser photographs the window's **active** tab, so a background tab cannot be photographed and Qiksy refuses rather than handing you a page you did not ask about. Reach for the numbers first anyway, boxes in CSS pixels (`qa_snapshot { geometry: true }`), computed styles and the design token behind a colour cost nothing and work in a background tab.

For that, and for a run that must be reproducible from cold in CI with tracing and parallel contexts, **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** is the right neighbour. It can attach over CDP to the very browser Qiksy runs in ([wiring below](#wiring-both-servers-playwright-mcp-needs-a-cdp-browser)), so it works in the session you are actually in.

**Example workflow (Jira story → verified test cases):**

1. Drop a Jira story/acceptance criteria into your agent.
2. The agent walks the flow with **Agent control**: `qa_fill_json` per step, `qa_click` by name, `qa_wait_ready` after anything that navigates.
3. After each step it reads what *actually* happened (`qa_export`, `qa_run_audit`, `qa_findings`), console/JS errors, failed requests **with server bodies**, a11y/markup issues, the detected form structure.
4. The agent reconciles the story against reality, then writes test cases (using `qa_tour` for coverage) and pulls a `qa_report` as the artifact, with `spec`, the report leads with its verdict per acceptance criterion.

**How fast, and why it matters.** Measured on the same page and question ("what forms are here with selectors, and what is broken?"): `qa_export` answers in **~9 ms** from an already-open tab, against **~2.5 s** for Playwright from a cold start, but that gap is almost entirely browser launch. With both browsers already up it is ~9 ms vs ~28 ms for an equivalent DOM scrape: the same order. The reason to use Qiksy is not raw speed, it is that the 9 ms carries *meaning*, `kind: "first-name"`, the label, `required`, `maxLength`, plus findings, failed requests with server bodies and repro steps in the same payload. A scrape returns raw DOM and leaves the agent to work out what each field is; matching the rest needs more code and a reload to attach console listeners before load.

So: **Agent control for anything that happens in the live, already-authenticated session, which is nearly everything. Playwright when you need `evaluate`, or a run that starts from cold in CI.** Reading is worth doing through Qiksy either way.

### Wiring both servers (Playwright MCP needs a CDP browser)

Only worth doing for the gap above, `evaluate`. Playwright MCP drives a browser over the **Chrome DevTools Protocol**, a *normal* Chrome window can't be driven, you must start Chrome with a debugging port so Playwright can attach. Qiksy must be **installed in that same Chrome** (from the Web Store, or loaded unpacked) so its content scripts + bridge run there.

1. **Launch Chrome with the debug port** (quit other Chrome windows first, or use a separate `--user-data-dir`):
   ```bash
   # macOS
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
   # Windows:  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
   # Linux:    google-chrome --remote-debugging-port=9222
   ```
2. **In the Qiksy popup** → *Agent bridge*: **On**, **Generate** a token (it saves as you go), then **📋 Copy agent config**.
3. **Register both MCP servers** in your agent, one config, paste and go. Claude Code `.mcp.json` (project root):
   ```json
   {
     "mcpServers": {
       "playwright": {
         "command": "npx",
         "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9222"]
       },
       "qiksy": {
         "command": "npx",
         "args": ["-y", "qiksy-mcp", "--port", "7333"],
         "env": { "QIKSY_MCP_TOKEN": "YOUR_TOKEN" }
       }
     }
   }
   ```
   Now the agent has Qiksy for everything in the live session and Playwright, attached to the same Chrome, for `evaluate`.

### Multi-login (RBAC) with the agent

Qiksy runs several logins on one domain at once, one per tab, each with its own cookie jar + virtualized storage. The reliable division of labour:

- **You spin up the logins** (a few clicks, one-time): Qiksy panel → **Roles** → **＋ Isolated tab** for a fresh empty session, or **⧉** on a saved role to open it isolated. (There's also an **auto-isolate** toggle per site: new tabs *you* open, Ctrl/Cmd+T, get their own session automatically. Note: tabs opened programmatically by Playwright carry an opener and are deliberately **not** auto-isolated, so they don't hijack OAuth-popup / `target=_blank` flows, create isolated logins from the Roles panel instead.)
- **The agent reads every login at once**: `qa_tabs` lists them with `isolatedSession` = the login name and a `tabId`; then `qa_findings`/`qa_export` with that `tabId` reads each. So the agent can diff what **admin vs. member vs. anon** each see, permissions leaks, missing guards, role-specific errors, in one pass.
- **The agent drives within a login** with Agent control, pass that tab's `tabId` to `qa_click` / `qa_fill_json` / `qa_type_many` and it acts as that user; Qiksy senses the result per tab.

## Setup

### The short way: one command

```bash
npx qiksy-mcp connect
```

Run it **in the project you work in**. It picks a free port, mints a token, writes the `qiksy`
server into every agent config it finds on the machine, Claude Code (`.mcp.json`), Cursor
(`~/.cursor/mcp.json`), VS Code (`.vscode/mcp.json`, which uses its own `servers` key), Windsurf,
Claude Desktop, and puts the token on your clipboard. Then: **popup → Agent bridge → On → paste**,
restart the agent, ask it to call `qa_status`.

`npx qiksy-mcp init` does the same **and** writes the agent guide into the project, which is what
stops your agent proposing Playwright on the first unfamiliar field. Use `init` the first time.

What it will not do: it writes a config **only where that client's own folder already exists**, so
you never get a Windsurf config for an editor you do not have; it keeps every other server already
in those files; it refuses to touch a config it cannot parse rather than overwriting it; and on a
second run it **keeps the token that is already there**, so a browser you have already paired stays
paired. On Windows the entry is written as `cmd /c npx …`, which is the form that actually starts:
a bare `npx` fails in about half the clients there.

Flags: `--dir <path>` (which project), `--port <n>`, `--token <value>`, and `--no-connect` on
`init` if you want the guide without the wiring.

### The manual way

1. **In the extension popup** → *Agent bridge*: toggle **On**, click **Generate** for a token, keep the default port `7333` (or pick your own). It **saves as you go**, there is no separate Save step.
2. **Click 📋 Copy agent config** in the popup, it copies the whole `mcpServers` block below with **your port and token already filled in**, and paste it into your agent's MCP config file (below). No hand-editing the token or port.
3. **Watch the status line** under the toggle. 🟡 *Waiting…* until your agent's `qiksy-mcp` is up, then 🟢 *Agent connected on port 7333*. If it stays yellow or turns red, see [Connection status & troubleshooting](#connection-status--troubleshooting).

The token is the only thing guarding the bridge, localhost is reachable by any local process/page, so keep it secret and unique.

### Connection status & troubleshooting

The popup shows the live link state, so you fix the right thing instead of guessing:

| Status | Means | Fix |
|--------|-------|-----|
| 🟢 **Agent connected** | Socket open on that port, token matched. | Nothing, you're live. |
| 🟡 **Waiting for the agent** | Bridge on, but nothing answering on that port. | Start your agent so `qiksy-mcp` runs, and make sure **its `--port` matches the popup's port**. The #1 snag: docs pin `7333` but the agent was launched on a different port, the numbers must match. |
| 🔴 **Token rejected** | Something answered, but the shared secret didn't match. | The popup token and the agent's `QIKSY_MCP_TOKEN` must be identical. Re-copy with **📋 Copy agent config** and repaste. |
| 🔴 **Another browser took over** | Only an **old** `qiksy-mcp` (before 1.82) does this: it kept one browser and pushed the first off when a second connected. | Close the agent window that has run for days, or restart it so it fetches the current server. The extension retries by itself after a minute; toggling it **off then on** brings it back at once. |
| 🔴 **A licence is required** | Only possible against an **old extension** (1.71.0 or earlier), whose key or trial ran out. | Update the extension: `chrome://extensions` → Update. Nothing needs buying; Qiksy is free from 1.72.0. |

One failure has nothing to do with the popup, and the tool result says so in words: **“Port … is held by something this bridge cannot share it with.”** Another process (or an older `qiksy-mcp`, or one on a different token) owns the port, so *this* agent window has no link, the extension and the browser are fine. Restart or update whatever holds the port, or give this window its own `--port`.

### Two browsers at once

**Since 1.82 several browsers share one port and one token.** Point a second browser, or a second Chrome profile, at the same bridge and both stay connected: every tab in `qa_tabs` names its `browser` (1 is the one that connected first), a call with that tab's `tabId` goes to the browser holding it, and a call with no `tabId` goes to browser 1. Nothing to configure.

Separate ports still work if you want two fully independent links, each under its own server name:

```json
{ "mcpServers": {
  "qiksy":   { "command": "npx", "args": ["-y", "qiksy-mcp", "--port", "7333"], "env": { "QIKSY_MCP_TOKEN": "TOKEN_A" } },
  "qiksy-2": { "command": "npx", "args": ["-y", "qiksy-mcp", "--port", "7334"], "env": { "QIKSY_MCP_TOKEN": "TOKEN_B" } }
} }
```

### Several agent windows, one browser (automatic since 1.1.0)

The mirror case, and it needs **no setup at all**: open a second Claude Code / Cursor window on the same project, or a third, and they all reach the same browser through the same popup toggle. Nothing to change, no second port, no second token.

Each MCP client starts its own copy of `qiksy-mcp`, but only one process can own the loopback port. The first to bind it becomes the **hub** and holds the extension's socket; every later one detects the taken port, dials the hub with the same token and relays its calls one hop further. Close the hub's window and the rest race for the port; whoever wins becomes the new hub and the extension reconnects on its own.

Two things worth knowing:

- **Reading is safe from any window** (`qa_tabs`, `qa_status`, `qa_snapshot`, `qa_findings`, `qa_export`). When several agents *drive*, give each one its own tab, pass `tabId` from `qa_tabs`, or let each open its own isolated login with `qa_open_isolated`. Two agents clicking in the same active tab will fight, and neither will know why.
- **Both halves must be 1.1.0+.** Against an older hub the new window refuses to join and says so, rather than stealing the browser from it, a pre-1.1 server would mistake a sibling for a browser and kick the real extension out of its slot.

### Claude Code

```bash
claude mcp add --transport stdio qiksy --env QIKSY_MCP_TOKEN=YOUR_TOKEN -- npx qiksy-mcp --port 7333
```

or `.mcp.json` at the project root:

```json
{ "mcpServers": { "qiksy": {
  "type": "stdio",
  "command": "npx", "args": ["-y", "qiksy-mcp", "--port", "7333"],
  "env": { "QIKSY_MCP_TOKEN": "YOUR_TOKEN" }
} } }
```

### Cursor (`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Cline (`cline_mcp_settings.json`)

Same canonical shape:

```json
{ "mcpServers": { "qiksy": {
  "command": "npx", "args": ["-y", "qiksy-mcp", "--port", "7333"],
  "env": { "QIKSY_MCP_TOKEN": "YOUR_TOKEN" }
} } }
```

### Zed (`settings.json`), key is `context_servers`, `source` is required

```json
{ "context_servers": { "qiksy": {
  "source": "custom",
  "command": "npx", "args": ["-y", "qiksy-mcp", "--port", "7333"],
  "env": { "QIKSY_MCP_TOKEN": "YOUR_TOKEN" }
} } }
```

### VS Code native (`.vscode/mcp.json`), top-level `servers`, `type` required

```json
{
  "inputs": [{ "type": "promptString", "id": "qac-token", "description": "Qiksy MCP token", "password": true }],
  "servers": { "qiksy": {
    "type": "stdio",
    "command": "npx", "args": ["-y", "qiksy-mcp", "--port", "7333"],
    "env": { "QIKSY_MCP_TOKEN": "${input:qac-token}" }
  } }
}
```

## Local run (dev)

```bash
QIKSY_MCP_TOKEN=YOUR_TOKEN node server.mjs --port 7333
```

Logs go to **stderr** (stdout is the JSON-RPC channel). You should see `bridge listening…` and, once Chrome has the extension with the bridge enabled, `extension connected`.

## Notes / limits

- **Which tab**: every tool takes a `tabId` from `qa_tabs`, so the agent works in a background tab while you use another. Without one it uses the tabs you attached to the agent session, or the active tab. Only a screenshot needs its tab in front, because the browser photographs what is on screen.
- **Service-worker sleep**: if Chrome idles the extension's worker, the socket drops and reconnects automatically (≤~30 s). If a tool times out, retry.
- **Security**: bound to `127.0.0.1` only; connections without the matching token (or from a non-extension origin) are closed before any data is sent.

## Follow the build

We build Qiksy in the open, what shipped, what broke, what's next.

- **LinkedIn**: [linkedin.com/company/qiksy](https://www.linkedin.com/company/qiksy)
- **Site**: [qiksy.app](https://qiksy.app)
- **Source of this server**: [github.com/lesnyak-cyber/qiksy-mcp](https://github.com/lesnyak-cyber/qiksy-mcp)

## License

This server is MIT-licensed (see [LICENSE](LICENSE)). The Qiksy Bridge Chrome extension it talks to is
free to install from the [Chrome Web Store](https://chromewebstore.google.com/detail/jcnbcbpndahhblhobhjjkhafmbkleoem)
but is not open source.
