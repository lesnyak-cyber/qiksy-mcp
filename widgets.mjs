/**
 * WIDGET REGISTRY — what kind of control is this, and what is the proven way to drive it.
 *
 * WHY THIS FILE EXISTS (owner, 2026-07-29, and he is right): every session I was re-deriving how
 * to work a widget by trial and error, then losing that knowledge to the transcript. "Нужно как-то
 * системно, кодом запомнить, как с такими работать, как определять, что это именно такого типа
 * элемент." So: detection is data, the procedure is data, and both live here.
 *
 * HOW DETECTION WORKS WITHOUT `eval` AND WITHOUT CLASS NAMES IN THE SNAPSHOT.
 * The a11y snapshot gives role / name / state / cssPath — and cssPath carries no classes, so a
 * library cannot be recognised from it. But the bridge CAN read an arbitrary CSS selector
 * (`qa_read { selector }`) and click one (`qa_click { selector }`), and neither needs the element
 * to be in the snapshot at all. That is the whole trick: one cheap read per marker identifies the
 * library, and from then on the recipe addresses its parts by selector — which works on the
 * SHIPPED extension, with no Web Store release.
 *
 * Every recipe below was proven against the live React stand (demo/react), not written from docs.
 */

/** One entry per library we have actually driven. Order matters: first marker that answers wins. */
export const LIBRARIES = [
  {
    id: 'antd',
    /* A VISIBLE dropdown is the honest marker — and ":not(...-hidden)" is the whole of it.
     *
     * Ant hides a closed portal rather than unmounting it, so a bare `.ant-select-dropdown` matches
     * a dropdown that closed minutes ago on another field. Live, that made a MUI date field be
     * detected as Ant — because the step also had an Ant multi-select whose leftover portal was
     * still in the DOM (2026-07-30) — and the Ant recipe was then run against a MUI dialog. */
    markers: [
      '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
      '.ant-cascader-menus:not(.ant-select-dropdown-hidden)',
    ],
    date: {
      /* SCOPE EVERY SELECTOR TO THE VISIBLE DROPDOWN.
       *
       * Ant leaves a closed picker's portal IN THE DOM, merely hidden — and a bare class selector
       * finds that one first. Live, the range picker's end date reported "2031 is not in the panel"
       * while the header it had just read said "Nov2024": it was steering the DEADLINE's leftover
       * panel, whose arrows are zero-size and therefore "do not respond" (2026-07-30). Hidden
       * elements still answer querySelector and still have text, so nothing about this is visible
       * in the reply — which is exactly why it belongs in the recipe rather than in a memory. */
      scope: '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
      // Ant's day is a bare <td title="2026-06-28"> with no role and no aria-label. It is
      // unreachable through the accessibility tree and trivially reachable by selector.
      dayByDate: (iso) => `td[title="${iso}"]`,
      header: '.ant-picker-header-view',
      yearButton: '.ant-picker-year-btn',
      monthButton: '.ant-picker-month-btn',
      prevMonth: '.ant-picker-header-prev-btn',
      nextMonth: '.ant-picker-header-next-btn',
      prevYear: '.ant-picker-header-super-prev-btn',
      nextYear: '.ant-picker-header-super-next-btn',
      // In the year/month panels the cells carry their own title too.
      cellByLabel: (label) => `.ant-picker-cell-inner:not([title]) , [title="${label}"]`,
    },
    tree: {
      /* TWO TREES, TWO OPPOSITE RULES — and the owner named both, a day apart, from watching runs.
       *
       * CHECKABLE (multiple / treeCheckable): click the CHECKBOX. A label click selects-or-expands
       * depending on the library's mood; the checkbox always checks. That was the difference between
       * "TreeSelect does not work" and "TreeSelect works".
       * SINGLE (no checkboxes at all): click the LABEL — "здесь наоборот на лейбл нужно нажимать, а
       * не на чекбоксы" (2026-07-30). And the label that takes the click is NOT the node the
       * accessibility tree exposes: the tree gives you the outer `.ant-select-tree-treenode`, whose
       * click does nothing, while the text sits in a `title` on the content wrapper inside it. So the
       * single-mode route is `[title="Poland"]` inside the visible dropdown — the same trick as the
       * day cell. A single-mode tree also has NO search box (Ant only enables search for multiple),
       * so typing and Enter are not available either.
       */
      preferCheckbox: true,
      labelByTitle: (text) => `.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="${text}"]`,
      switcher: '.ant-select-tree-switcher, .ant-tree-switcher',
      searchInput: '.ant-select-selection-search-input',
    },
    time: {
      /* PROVEN 2026-07-30: a TimePicker is not a calendar and the fill engine's date path misfires
         on it ("calendar did not open — typed an ISO date instead"), leaving the field empty. The
         panel is columns of <li> with NO role, so the tree cannot see the cells — but their text is
         readable and their ORDER is the value: read the column, find the index of "14", click that
         child. Index arithmetic beats guessing at a step size we do not know. */
      column: '.ant-picker-time-panel-column',
      cell: '.ant-picker-time-panel-cell-inner',
      confirm: '.ant-picker-ok button',
    },
    range: {
      /* A RangePicker is two inputs and TWO panels in one dropdown. Its header buttons have real
         accessible names ("Choose a year", "Choose a month", "Last year", "Previous month") and its
         day cells have titles, so the range is driven exactly like a single date — twice, without
         re-opening: Ant moves the caret to the end input by itself once the start is picked.
         Typing is NOT the shorter route here: the engine writes an ISO date, and a picker whose
         format is DD/MM/YYYY turns that into some other date entirely (watched it become
         05/03/2025 from 05/09/2027). */
      /* ADDRESS THE INPUTS BY THEIR OWN CLASS, NOT BY POSITION. `:last-child` was unsatisfiable and
         therefore silent: rc-picker renders the two inputs, then a `-range-separator`, an
         `-active-bar` and the suffix/clear icons as later siblings (RangeSelector.js:190, :195,
         :199, :204), so neither input is the last child of anything. Verified live on the stand
         2026-07-30: `.ant-picker-range .ant-picker-input:last-child input` answers "nothing
         matches", while `.ant-picker-input-end input` resolves. The end date was never typed at
         all, the fast route could not report success, and every range fell through to the 35s
         panel walk that this recipe exists to avoid. */
      startInput: '.ant-picker-input-start input',
      endInput: '.ant-picker-input-end input',
      neverType: true,
    },
    select: {
      /* PROBED FIELD BY FIELD (2026-07-30), because this one wasted an hour of the owner's time.
       *
       * An Ant Select with `showSearch`:
       *   · writing the text natively DOES filter the list — options went from four to one;
       *   · pressing Enter commits NOTHING;
       *   · a bare synthetic `mousedown` on the option commits nothing;
       *   · the FULL synthetic pointer sequence commits it — but only when dispatched from the page's
       *     own context. The same sequence from the extension's content script does not, and the
       *     control ends up cleared and empty, which looks like success from the outside.
       * So: the value goes through the extension's FILL ENGINE, which drives it correctly in about a
       * second. The fast raw route is for controls that PARSE text (dates, times, ranges, tags), not
       * for one that has to choose a row. */
      commitsItsOwnWay: true,
      useEngine: true,
      optionSelector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    },
    tags: {
      // PROVEN: type, then Enter, and do NOT click the field first — a click moves the caret out
      // of the search input and the tag never commits.
      clickFirst: false,
      commitKey: 'Enter',
      /* AND THE TEXT IS NOT IN `input.value` — Ant keeps the search text in its own mirror element,
         so the snapshot's `value="…"` state stays empty and a verification built on it fails every
         tag (2026-07-30). What DOES move is the field's accessible NAME: the label wraps the
         control, so the live search text and every committed chip read back through it. That makes
         the name the honest witness for both halves of the check — the text is live before the key,
         and a chip that got toggled off DISAPPEARS from it. */
      textShowsInName: true,
      /* AND VERIFY THE TEXT IS STILL THERE BEFORE Enter. After a tag commits, Ant clears its search
         input; a value written into it can be wiped by the re-render that follows, and then Enter
         re-submits the PREVIOUS text — which in tags mode toggles that tag OFF. Watched it happen:
         "chilled" appeared, then vanished while "ambient" was being added. */
      verifyBeforeCommit: true,
      /* AND THE VALUE IS KEPT BY THE BLUR, NOT BY THE KEY (owner, 2026-07-30 — he drives this
         control by hand every day and this is the bit no amount of probing had shown me).
         There is a whole CLASS of input that behaves this way: the key merely proposes the value and
         the component holds it provisionally; what commits it is FOCUS LEAVING. Drive one and stop
         at the key and it looks like the value went in and then "vanished" — which is precisely the
         disappearing-tag symptom, and why a repair loop kept trading one tag for another.
         So: type → key → MOVE FOCUS AWAY (Tab), and only then read the value back. */
      commitOnBlur: true,
      blurKey: 'Tab',
      searchInput: '.ant-select-selection-search-input',
    },
    hint:
      'Ant Design (antd). Its popups are portalled to the end of <body> and several parts carry NO ARIA role — ' +
      'the day of a DatePicker is a bare <td title="2026-06-28">. Drive them by CSS selector, which the bridge ' +
      'resolves without the snapshot: qa_pick_date already knows the recipe. TreeSelect: type the leaf name into ' +
      'the control, then click its CHECKBOX (not the label). Select mode=tags: type the value and press Enter ' +
      'WITHOUT clicking the field first, one tag at a time, checking the input still holds your text before Enter. ' +
      'Cascader: qa_pick_path with the levels as they read on screen.',
  },
  {
    id: 'mui',
    markers: ['.MuiPickersLayout-root', '.MuiPickersPopper-root', '.MuiMenu-paper', '.MuiAutocomplete-popper'],
    date: {
      // MUI X's field is three contenteditable sections the component owns: a written value never
      // sticks, and clicking into a section makes its own picker button TOGGLE the dialog shut.
      neverType: true,
      openButtonNamePattern: /^Choose /,
      yearViewButtonNamePattern: /switch to year view/i,
      yearCellRole: 'radio',
      header: '.MuiPickersCalendarHeader-label',
      prevMonthName: 'Previous month',
      nextMonthName: 'Next month',
      dayRole: 'gridcell',
    },
    hint:
      'MUI (Material UI / MUI X). Popups are portalled. A DatePicker field is three contenteditable SECTIONS ' +
      '(Day / Month / Year) the component rebuilds from its own state: writing a value never sticks and can land ' +
      'in the wrong section — use qa_pick_date with open_label "Choose <field>". Select and Autocomplete take a ' +
      'value normally. A Switch or Rating is addressed by its visible caption ("No", "4 Stars"), not by the label ' +
      'text beside it.',
  },
  {
    id: 'react-datepicker',
    markers: ['.react-datepicker'],
    date: {
      // Its input accepts a typed date, and with dropdownMode="select" the month and year are
      // ordinary <select>s — which the fill engine drives directly.
      typeFirst: true,
      header: '.react-datepicker__current-month',
      monthSelect: '.react-datepicker__month-select',
      yearSelect: '.react-datepicker__year-select',
      dayByNumber: (d) => `.react-datepicker__day--0${String(d).padStart(2, '0')}`,
      prevMonth: '.react-datepicker__navigation--previous',
      nextMonth: '.react-datepicker__navigation--next',
      /* A day class carries no MONTH, so clicking `--001` on the wrong month picks the wrong date and
         closes the calendar looking successful. The arrows are the only way to the right month —
         hence `stepMonth` in the plan, which the executor must actually implement (2026-07-30). */
      mustStepToMonth: true,
    },
    /* Its month-only and time-only modes are DIFFERENT panels, and the ordinary date route cannot
       drive either: `showMonthYearPicker` has no day grid at all, and `showTimeSelect` is a list of
       half-hours. Both are read-then-click-the-nth, the same shape as Ant's time columns. */
    month: {
      /* PROVEN 2026-07-30: every month cell carries its own INDEX in a class — `__month-0` … `__month-11`
         — so September is addressable without counting rows, and the year is stepped with buttons whose
         accessible names are "Previous Year" / "Next Year". Typing into this field instead writes an ISO
         date and lands on the wrong month (07/2026 from "09/2026"). */
      cellByIndex: (i) => `.react-datepicker__month-${i}`,
      header: '.react-datepicker__header',
      prevYearName: 'Previous Year',
      nextYearName: 'Next Year',
    },
    time: {
      /* Its time list is 48 items in TWELVE-hour form ("10:30 AM"), one column, so the value has to be
         converted before it can be matched — and matching is by reading the list, not by arithmetic. */
      column: '.react-datepicker__time-list',
      cell: '.react-datepicker__time-list-item',
      twelveHour: true,
    },
    hint:
      'react-datepicker. Its input accepts a typed date (dd/MM/yyyy) — cheapest route. With month/year dropdowns ' +
      'they are ordinary <select>s and qa_type drives them by option text; otherwise step the arrows.',
  },
  {
    id: 'react-select',
    markers: ['[class*="-menu"] [class*="-option"]', '.react-select__menu'],
    // Nothing special: the fill engine's combobox path drives it by value. Kept here so detection
    // can say "this page is react-select" and the caller stops looking for a calendar.
    select: { byValue: true },
    hint: 'react-select. A div-combobox whose input is separate from its value: never assign a value, pass the OPTION TEXT and the fill engine picks it. Async variants only have options after their request — allow ~0.5s.',
  },
  {
    id: 'radix',
    markers: ['[data-radix-popper-content-wrapper]'],
    select: { byValue: true },
    hint: 'Radix UI. Portalled content, focus trapped, and it reacts to pointerdown rather than click — the bridge already sends the full pointer sequence, so a value works normally.',
  },
  {
    id: 'headlessui',
    // Headless UI renders a <button aria-haspopup="listbox">, which the snapshot reports as a plain
    // button — the reason a fields-only match could not see "Service tier".
    markers: ['[data-headlessui-state]'],
    select: { byValue: true, triggerIsButton: true },
    hint: 'Headless UI. Its Listbox/Combobox trigger is a <button aria-haspopup="listbox">, which the snapshot reports as a plain button — a fields-only search will not see it. Address it by name; the fill engine drives it from there.',
  },

  /* ── THE FIFTEEN JIG KNEW AND WE DID NOT (ported 2026-08-21, owner ask) ────────────────
   *
   * Jig's crawl of forty real pages found thirty-two controls it could not name, and eighteen of
   * them belonged to kits absent from this file (products/qiksy-bench/inject/agent.js,
   * LIB_FINGERPRINTS). The six entries above carry full RECIPES because each was driven live and
   * the procedure was measured; the entries below deliberately carry DETECTION AND A SENTENCE
   * ONLY. That asymmetry is the honest part: a recipe I have not run is a guess with the authority
   * of a fact, and the one thing worse than an agent that does not know a widget is one that has
   * been told the wrong way to drive it. Detection alone already pays: the agent learns what it is
   * looking at, gets the general route, and stops re-deriving it per field.
   *
   * Markers follow the same rule as antd above — a marker must match a VISIBLE popup. Kits that
   * hide rather than unmount get the :not(...) guard; kits that unmount do not need it. */
  {
    id: 'angular-material',
    markers: ['.mat-mdc-select-panel', '.mat-mdc-autocomplete-panel', '.mat-datepicker-popup', '.mat-calendar'],
    hint: 'Angular Material (MDC, v15+). Options are `.mat-mdc-option` inside a panel appended to an overlay container at the end of <body>, not next to the trigger — the trigger is a div with role=combobox and the value lives in `.mat-mdc-select-value-text`, so read the value back from there rather than from an input. Its datepicker draws `.mat-calendar-body-cell` with `aria-label` carrying the full date.',
  },
  {
    id: 'prime',
    markers: ['.p-dropdown-panel', '.p-select-overlay', '.p-multiselect-panel', '.p-autocomplete-panel', '.p-datepicker:not(.p-datepicker-inline)'],
    hint: 'PrimeNG / PrimeVue / PrimeReact. One family, two generations of class names: PrimeNG 19+ and PrimeVue 4+ renamed `p-dropdown` to `p-select` and `p-calendar` to `p-datepicker`, while PrimeReact kept the old ones — expect either. Rows are `.p-dropdown-item` / `.p-select-option`; the value shows in `.p-dropdown-label`. The panel is appended to <body> by default.',
  },
  {
    id: 'vuetify',
    markers: ['.v-overlay__content .v-list', '.v-menu > .v-overlay__content', '.v-date-picker', '.v-time-picker'],
    hint: 'Vuetify. Options are `.v-list-item` inside `.v-overlay__content`, which is teleported to the end of <body>. The visible value is `.v-select__selection-text`, and the real <input> underneath is often type=hidden — read the selection text, not the input.',
  },
  {
    id: 'element',
    markers: ['.el-select-dropdown:not([style*="display: none"])', '.el-picker-panel', '.el-cascader-panel'],
    hint: 'Element Plus / Element UI. Rows are `.el-select-dropdown__item`; the dropdown is teleported to <body> and HIDDEN rather than unmounted, so scope every selector to the visible one. Its date panel is `.el-picker-panel` with days as `td.available`.',
  },
  {
    id: 'carbon',
    markers: ['.cds--list-box__menu', '.bx--list-box__menu'],
    hint: 'IBM Carbon. v11 renamed every class from `bx--` to `cds--` and both eras are in the wild. Rows are `.cds--list-box__menu-item`; the trigger is a button whose text is the current value. The menu renders INLINE, next to the trigger, not in a portal.',
  },
  {
    id: 'semi',
    markers: ['.semi-select-option-list', '.semi-datepicker'],
    hint: 'Semi Design (ByteDance). Rows are `.semi-select-option`; the value sits in `.semi-select-selection-text`. Portalled to <body>.',
  },
  {
    id: 'arco',
    markers: ['.arco-select-popup', '.arco-picker-container'],
    hint: 'Arco Design (ByteDance). Rows are `.arco-select-option`; the value sits in `.arco-select-view-value`. Portalled to <body>.',
  },
  {
    id: 'mantine',
    markers: ['.mantine-Select-dropdown', '.mantine-Autocomplete-dropdown', '.mantine-DatePicker-calendar'],
    hint: 'Mantine. Rows are `.mantine-Select-item` (v6) or `[data-combobox-option]` (v7+) — expect either. The trigger IS a real <input>, so the typed text is visible, but the value only commits when an option is chosen.',
  },
  {
    id: 'chakra',
    markers: ['.chakra-menu__menu-list', '[data-popper-placement] .chakra-menu__menuitem'],
    hint: 'Chakra UI. Its Select is a native <select> and needs nothing special; its Menu is `.chakra-menu__menuitem` in a popper. If a control looks like a select but has no <option>, it is the Menu, and it commits on click rather than on value.',
  },
  {
    id: 'select2',
    markers: ['.select2-dropdown', '.select2-results'],
    hint: 'Select2 (jQuery era, still everywhere in enterprise). The original <select> is hidden and MUST NOT be written to — Select2 will not notice, and the visible widget keeps the old value while the form submits the new one. Rows are `.select2-results__option`; the search box is `.select2-search__field`.',
  },
  {
    id: 'choices',
    markers: ['.choices__list--dropdown', '.choices__list[aria-expanded="true"]'],
    hint: 'Choices.js. Rows are `.choices__item--choice`; the original <select> is hidden and must not be written to directly. The typed query goes into `.choices__input--cloned`.',
  },
  {
    id: 'tom-select',
    markers: ['.ts-dropdown'],
    hint: 'Tom Select (and its ancestor Selectize — `.selectize-dropdown`, same shape). Rows are `.option` inside `.ts-dropdown-content`; the original <select> is hidden. Chosen values render as `.item` chips in the control.',
  },
  {
    id: 'chosen',
    markers: ['.chosen-drop', '.chosen-container-active'],
    hint: 'Chosen (jQuery). Rows are `li.active-result` inside `.chosen-results`; the original <select> is hidden and must not be written to.',
  },
  {
    id: 'flatpickr',
    markers: ['.flatpickr-calendar.open'],
    hint: 'flatpickr. The calendar is appended to <body> and only `.open` is the live one. A day cell is `.flatpickr-day` carrying `aria-label` with the full date ("July 26, 2026") — address it by that label rather than by the number, or the same digit in the previous month takes the click. The input itself is usually readonly.',
  },
  {
    id: 'base-web',
    /* Найден не мной, а воротами сверки с Jig — и это ровно то, ради чего они написаны:
       список из двадцати одного кита я собрал руками и один пропустил молча. */
    markers: ['[data-baseweb="popover"]', '[data-baseweb="menu"]', '[data-baseweb="calendar"]'],
    hint: 'Base Web (Uber). Styletron даёт классам случайные имена, которые меняются от сборки к сборке, поэтому единственная устойчивая опора — атрибут `data-baseweb`: сам контрол это `[data-baseweb="select"]`, список `[data-baseweb="menu"]`, строки `[role="option"]` внутри него. По классам этот кит не ищется вообще.',
  },
  /*
   * THE ENTERPRISE HALF OF THE WEB, and the reason it was missing is worth stating: the twenty-two
   * kits above are the stack STARTUPS build on, while the person paying $49 for this tool is
   * usually inside a bank's admin panel or a logistics back office — Kendo, Syncfusion, DevExpress,
   * SAP UI5, Salesforce. We knew the libraries of people who do not buy it.
   *
   * BOTH ENTRIES BELOW WERE READ OFF THE LIBRARY'S OWN PUBLIC DEMO, not written from memory —
   * demo/platforms/kit-recon.mjs opens one dropdown and reports what the page actually contains.
   * That is the standing rule for this file, and it exists because a row selector written from
   * memory fails silently: the list reads as EMPTY, the engine falls back to "take the first row",
   * and a field asked for "Net 30" gets "Prepayment" (measured live, 30.07.2026).
   *
   * Their rows carry role="option", so the fill engine already sees them and needs no new
   * selector — which is exactly the kind of thing that has to be measured rather than assumed.
   */
  {
    id: 'kendo',
    /* Measured 03.09.2026 on demos.telerik.com/kendo-ui/dropdownlist: the popup is
       `div.k-animation-container[role=region] > div.k-child-animation-container >
        div.k-list-container.k-popup > div.k-list > ul.k-list-ul[role=listbox]`.
       The marker requires the LIST, not the container: Kendo reuses an animation container it
       created earlier rather than appending a fresh one, so the container alone would match long
       after the popup closed — the same trap Ant's hidden portal sets two hundred lines above. */
    markers: ['.k-animation-container .k-list-ul', '.k-animation-container .k-calendar'],
    hint: 'Kendo UI (Telerik). The popup is a portal: `.k-animation-container` wrapping `.k-list-container.k-popup`. Rows are `li.k-list-item` and they carry role="option", so ordinary option matching works. The container is REUSED rather than recreated, so never match it alone — require the list or the calendar inside it, or you will drive a popup that closed minutes ago.',
  },
  {
    id: 'syncfusion',
    /* Measured 03.09.2026 on ej2.syncfusion.com/demos/drop-down-list/default: the popup is
       `div.e-ddl.e-popup[role=dialog] > div.e-content.e-dropdownbase > ul.e-list-parent[role=listbox]`,
       rows `li.e-list-item[role=option]`. Only what was seen is written down — the calendar and
       the grid of this kit have not been opened yet, so they are not claimed here. */
    markers: ['.e-ddl.e-popup .e-list-parent', '.e-popup.e-popup-open .e-list-parent'],
    hint: 'Syncfusion EJ2. The popup is `div.e-ddl.e-popup` (role=dialog) holding `ul.e-list-parent`; rows are `li.e-list-item` with role="option", so ordinary option matching works. Its own state class is `.e-popup-open` — prefer a marker that names the list, because `.e-popup` alone also matches this kit\'s dialogs and tooltips.',
  },
  {
    id: 'devextreme',
    /* Measured 03.09.2026 on js.devexpress.com SelectBox demo: the open list is
       `div.dx-list-items[role=listbox]` inside `div.dx-scrollview-content[role=application]`,
       rows `div.dx-item.dx-list-item[role=option]`. The rows announce themselves, so the fill
       engine already sees them. */
    markers: ['.dx-list-items', '.dx-overlay-content .dx-list'],
    hint: 'DevExtreme (DevExpress). The open list is `div.dx-list-items` with role="listbox", rows are `div.dx-item.dx-list-item` with role="option" — ordinary option matching works. Everything lives in an overlay (`.dx-overlay-content`), and the list is VIRTUALISED on long data: what is not scrolled to does not exist in the DOM, so a value you cannot find may simply be below the fold rather than absent.',
  },
  {
    id: 'sapui5',
    /* Measured 03.09.2026 on sapui5.hana.ondemand.com sap.m.Select sample — and the measurement
       is the whole reason this marker is shaped the way it is. The OPEN list is
       `div.sapMPopover[role=dialog] > … > ul.sapMSelectList[role=listbox]`, but the SAME
       `ul.sapMSelectList` also sits inline inside the CLOSED `div.sapMSlt`. A bare
       `.sapMSelectList` therefore matches a select nobody has touched — the identical trap Ant's
       hidden portal sets, and the reason every marker in this file names the open layer. */
    markers: ['.sapMPopover .sapMSelectList', '.sapMDialog .sapMSelectList'],
    hint: 'SAP UI5 (sap.m). The open list is `ul.sapMSelectList` INSIDE `div.sapMPopover`; rows are `li.sapMSelectListItemBase.sapMSelectListItem` with role="option". Never match `.sapMSelectList` on its own — a closed `sapMSlt` carries one inline, so you would drive a select that is not open. Class names are compound and versioned (`sapMSltList-CTX`); match on the stable prefix, not on the whole string.',
  },
  {
    id: 'fluent',
    /* Measured 03.09.2026 on developer.microsoft.com/fluentui Dropdown: the open list is
       `div.ms-FocusZone.ms-Dropdown-items[role=listbox]` inside `div.ms-Callout-main`, and the
       rows are BUTTONS — `button.ms-Button[role=option]` — not list items. */
    markers: ['.ms-Callout .ms-Dropdown-items', '.ms-Callout-main [role="listbox"]'],
    hint: 'Microsoft Fluent UI. The dropdown is a callout: `.ms-Callout-main` holding `div.ms-Dropdown-items` with role="listbox". Its rows are BUTTONS (`button.ms-Button` with role="option"), not list items — anything that looks only for li or [role=option] inside a ul will find nothing. Class names carry generated suffixes (`calloutMain-381`), so match the stable prefix only.',
  },
  {
    id: 'jquery-ui',
    /* Measured 03.09.2026 on jqueryui.com/autocomplete — and it is the only kit here that needed
       the ENGINE changed, which is why measuring rather than remembering earned its keep today:
       jQuery UI sets no ARIA role at all. The menu is `ul.ui-menu.ui-autocomplete.ui-front` with
       an EMPTY role, and the rows are `li.ui-menu-item` with an empty role and the text one level
       down in `div.ui-menu-item-wrapper`. Every other kit in this file announces itself as a
       listbox of options; this one announces nothing, so the fill engine read its list as empty. */
    markers: ['ul.ui-autocomplete.ui-front', '.ui-datepicker[style*="block" i]'],
    hint: 'jQuery UI. It sets NO ARIA roles: the menu is `ul.ui-menu.ui-autocomplete` and the rows are `li.ui-menu-item` whose text sits inside `div.ui-menu-item-wrapper` — so nothing here answers to role="option" and the list looks empty to anything that asks for one. It is an AUTOCOMPLETE: it opens on typing, not on a click, and a click alone will leave you reporting that the widget is broken. The date picker is `#ui-datepicker-div`, a single element reused by every field on the page.',
  },
  {
    id: 'bootstrap',
    markers: ['.dropdown-menu.show'],
    hint: 'Bootstrap dropdown. `.show` is what makes it live — a bare `.dropdown-menu` matches every closed menu on the page. Rows are `.dropdown-item`, and a Bootstrap dropdown is a MENU, not a select: it usually navigates or sets a hidden field rather than holding a value of its own.',
  },
];

/** Everything the agent should know about the libraries detected on this page, as plain sentences. */
export function hintsFor(libIds) {
  return LIBRARIES.filter((l) => libIds.includes(l.id) && l.hint).map((l) => l.hint);
}

/**
 * Which library is drawing this page's popups? One read per marker, cached by the caller.
 * `read` is a function (selector) => text|null — i.e. the bridge's qa_read.
 */
export async function detectLibrary(read) {
  for (const lib of LIBRARIES) {
    for (const marker of lib.markers) {
      const txt = await read(marker);
      if (txt != null && String(txt).length >= 0 && txt !== false) return lib;
    }
  }
  return null;
}

/** The recipe for a widget kind, or null when this library needs no special handling. */
export function recipeFor(libId, kind) {
  const lib = LIBRARIES.find((l) => l.id === libId);
  return lib ? lib[kind] ?? null : null;
}

/**
 * A date, as a plan of bridge calls rather than as branching code.
 *
 * The caller executes the steps in order and stops at the first that fails; each step is one of
 * { click: selector } · { clickName: name, role? } · { type: {selector|name, value} } · { press: key }
 * · { readHeader: selector } · { stepMonth: 'prev'|'next' }. Keeping it declarative is what makes a
 * new library an entry in a table instead of another branch nobody remembers.
 */
export function datePlan(libId, { iso, day, month, year, fieldName, openLabel, monthNameShort }) {
  const r = recipeFor(libId, 'date') || {};
  const steps = [];
  if (libId === 'antd') {
    const sc = r.scope ? r.scope + ' ' : '';               // never steer a hidden leftover portal
    steps.push({ clickName: fieldName });                    // opens the panel
    steps.push({ click: sc + r.yearButton, note: 'year panel' });
    steps.push({ click: `${sc}[title="${year}"]`, note: 'the year' });
    steps.push({ click: `${sc}[title="${year}-${String(month).padStart(2, '0')}"]`, note: 'the month' });
    steps.push({ click: sc + r.dayByDate(iso), note: 'the day, by its title' });
    return steps;
  }
  if (libId === 'mui') {
    steps.push({ clickName: openLabel || `Choose ${fieldName}` });
    steps.push({ clickName: 'switch to year view' });
    steps.push({ clickName: String(year), role: r.yearCellRole });
    steps.push({ stepMonth: 'auto', header: r.header, target: month });
    steps.push({ clickName: String(day), role: r.dayRole });
    return steps;
  }
  if (libId === 'react-datepicker') {
    steps.push({ clickName: fieldName });
    steps.push({ type: { selector: r.yearSelect, value: String(year) }, optional: true });
    steps.push({ type: { selector: r.monthSelect, value: monthNameShort }, optional: true });
    steps.push({ stepMonth: 'auto', header: r.header, target: month });
    steps.push({ click: r.dayByNumber(day), note: 'the day cell' });
    return steps;
  }
  // Unknown library: the generic route — type it, then steer by whatever names exist.
  steps.push({ clickName: fieldName });
  steps.push({ type: { name: fieldName, value: null }, note: 'the caller supplies the formatted date' });
  steps.push({ press: 'Enter' });
  return steps;
}

/* ── STRUCTURAL CLASSIFIER — what IS this control, judged by its shape ───────────────
 *
 * Marker classes tell you the library; they say nothing about a widget hand-rolled from divs, and
 * that is most of the real web. But the SHAPE is the same in both cases: a control that owns a
 * popup list is a select whether it is `.ant-select` or `<div onclick>`, and three adjacent
 * spinbuttons named Day/Month/Year are a sectioned date field in every framework that has one.
 *
 * So classification here uses only what the snapshot always provides — role, tag, name, state and
 * the node's neighbours — and each rule carries `drive`: the one sentence an agent needs, and the
 * verb that already implements it. Order matters: the first rule that matches wins, so the most
 * specific shapes come first.
 */
const NAME_DATEISH = /\b(date|dob|birth|deadline|expiry|expires|issued|valid|from|to|start|end|day)\b/i;
const NAME_TIMEISH = /\b(time|hour|hh:mm|clock)\b/i;

export const SIGNATURES = [
  {
    kind: 'date-sections',
    // MUI X and every field built the same way: the value lives in separate editable sections the
    // component owns, so writing to it is not merely unreliable — it lands in the wrong section.
    test: (n, all) => {
      if (n.role !== 'spinbutton') return false;
      const names = all.filter((x) => x.role === 'spinbutton').map((x) => (x.name || '').toLowerCase());
      return ['day', 'month', 'year'].every((p) => names.some((x) => x.startsWith(p)));
    },
    drive: 'A sectioned date field: never write a value into it. Use qa_pick_date, and pass open_label if a "Choose …" button sits beside it.',
    verb: 'qa_pick_date',
  },
  {
    kind: 'calendar',
    // A grid of day numbers, however it is marked up — table cells, buttons or bare divs.
    test: (n, all) => {
      const numeric = all.filter((x) => /^\d{1,2}$/.test((x.name || '').trim()));
      return numeric.length >= 20 && numeric.some((x) => Number(x.name) > 27) && numeric.includes(n);
    },
    drive: 'An open calendar grid. Click the day by its own name; if the day is a bare <td> the snapshot may miss it, in which case click it by CSS selector (Ant uses td[title="YYYY-MM-DD"]).',
    verb: 'qa_click',
  },
  {
    kind: 'checkable-tree',
    test: (n, all) => n.role === 'checkbox' && all.some((x) => x.role === 'treeitem' && norm2(x.name) === norm2(n.name)),
    drive: 'A checkable tree: click the CHECKBOX, not the label — a label click selects or expands depending on the library. In a SINGLE-select tree it is the opposite: there are no checkboxes, and the element that takes the click carries its text in a `title` attribute rather than appearing in this tree. qa_pick_path knows both routes and tries them in order.',
    verb: 'qa_pick_path',
  },
  {
    kind: 'typeahead',
    // An input that fetches or filters its own options: the value must be the OPTION text, and the
    // options do not exist until something has been typed.
    test: (n) => (n.role === 'combobox' || n.role === 'searchbox') && n.tag === 'input',
    drive: 'A typeahead: give it the option text as a value and let the engine wait for the list. Options may arrive ~0.4–0.6s after typing; never assign a value and move on.',
    verb: 'qa_type',
  },
  {
    kind: 'select-trigger',
    // A button or div that owns a listbox — Radix, Headless UI, downshift, or hand-rolled ARIA.
    test: (n) => n.role === 'combobox' && n.tag !== 'input',
    drive: 'A custom select. Pass the option text as a value — the engine opens the popup, waits for the options, picks the match and verifies the trigger changed.',
    verb: 'qa_type',
  },
  {
    kind: 'multi-select',
    test: (n) => n.role === 'listbox' || (n.tag === 'select' && /multiple/i.test(n.state || '')),
    drive: 'A multi-select: one call per value, and NEVER repeat a value — a second write toggles it back off.',
    verb: 'qa_type',
  },
  { kind: 'switch', test: (n) => n.role === 'switch', drive: 'A switch: address it by its visible caption (its accessible name is often the current state, e.g. "No"), and click rather than write.', verb: 'qa_click' },
  { kind: 'slider', test: (n) => n.role === 'slider', drive: 'A slider: write the number. Forms often demand it be moved off its default, so a value equal to the minimum may not count.', verb: 'qa_type' },
  { kind: 'rich-text', test: (n) => n.role === 'textbox' && n.tag !== 'input' && n.tag !== 'textarea', drive: 'A contenteditable editor: write the text; the engine fires the input event React needs.', verb: 'qa_type' },
  { kind: 'file', test: (n) => n.tag === 'input' && n.role === 'button', drive: 'A file input, probably hidden behind a styled dropzone. Use qa_upload (path, base64 content, or a hostile fixture); files[] attaches several in one call.', verb: 'qa_upload' },
  {
    kind: 'popup-date-input',
    test: (n) => n.role === 'textbox' && (NAME_DATEISH.test(n.name || '') || NAME_TIMEISH.test(n.name || '')) && /readonly|expanded|collapsed/i.test(n.state || ''),
    drive: 'A read-only field with its own picker. Do not write into it — qa_pick_date opens the picker and steers it.',
    verb: 'qa_pick_date',
  },
  {
    /* COMMIT-ON-BLUR — a whole class of input, not an Ant quirk (owner, 2026-07-30; he drives this
     * control by hand every day and this is the part no amount of probing had shown me).
     *
     * The value is typed, a key PROPOSES it, and the component keeps it only once FOCUS LEAVES.
     * Tags and chips inputs, inline-edit table cells, "add another" rows and most spreadsheet-like
     * grids behave this way. At rest it is indistinguishable from a plain field — which is exactly
     * why it is named here: the instruction is the whole value, and it costs one extra Tab. */
    kind: 'commit-on-blur',
    test: (n) => (n.role === 'combobox' || n.role === 'searchbox' || n.role === 'textbox') && n.tag === 'input' && /\b(tags?|chips?|keywords?|labels?|skills?)\b/i.test(n.name || ''),
    drive: 'A commit-on-blur input (a tags / chips field): type the value, press Enter, then MOVE FOCUS AWAY — Tab, or a click elsewhere — because the key only proposes the value and the blur is what keeps it. Read it back only after the blur, or you will watch it "vanish". qa_pick_tags does all three.',
    verb: 'qa_pick_tags',
  },
  { kind: 'text', test: (n) => n.role === 'textbox' || n.role === 'spinbutton' || n.role === 'searchbox', drive: 'A plain field: write the value. Check `stuck` in the reply — a masked field rewrites what it is given.', verb: 'qa_type' },
  { kind: 'checkbox', test: (n) => n.role === 'checkbox' || n.role === 'radio', drive: 'A checkbox or radio: a truthy value checks it, and the engine clicks so the app’s own listeners run.', verb: 'qa_type' },
];

const norm2 = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[\s*:•?​]+$/, '').toLowerCase();

/** Classify one snapshot node against its siblings. Returns {kind, drive, verb} or null. */
export function classifyNode(node, allNodes = []) {
  if (!node) return null;
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(node, allNodes)) return { kind: sig.kind, drive: sig.drive, verb: sig.verb };
    } catch {
      /* a signature that throws on an odd node must not take the whole classification down */
    }
  }
  return null;
}

/** Classify a whole snapshot: kinds present, and the guidance for each — deduplicated. */
export function classifySnapshot(nodes = []) {
  const seen = new Map();
  for (const n of nodes) {
    const c = classifyNode(n, nodes);
    if (!c) continue;
    if (!seen.has(c.kind)) seen.set(c.kind, { ...c, examples: [] });
    const entry = seen.get(c.kind);
    if (entry.examples.length < 3 && n.name) entry.examples.push(n.name.slice(0, 40));
  }
  return [...seen.values()];
}

/* ── BEHAVIOURAL CLASSIFIER — what a control IS, judged by what it DID ───────────────
 *
 * The rules above read a control at rest, which covers everything built on ARIA and misses
 * exactly the case the owner keeps meeting: a widget hand-rolled from <div>s has role "generic",
 * no accessible name and no state, so at rest it is indistinguishable from a caption. The one
 * thing it cannot hide is its BEHAVIOUR — click it and something appears — and `qa_click`
 * already answers with what appeared, disappeared and changed. So this half reads that diff.
 *
 * It is also the answer to the owner's own observation: "когда я нажимаю на селект даты, у нас в
 * body внизу появляются новые DOM-ноды — можем это детектить?" We can, and the diff is where. A
 * portalled popup sits outside the field's subtree but not outside the page, so it lands in
 * `appeared` — UNLESS its parts carry no role at all (Ant's day is a bare <td title="…">), and
 * that case has a signature of its own: the field flipped to `expanded` and nothing appeared.
 * Which is the most valuable verdict in the table, because it is the one that says "stop looking
 * through the snapshot, address this by CSS selector".
 *
 * Two constraints from the shipped extension, both deliberate to work with rather than around:
 * `appeared` is capped at 12 nodes, so no rule may require more than a handful; and cssPath
 * carries tags but no classes, so the shape of the markup (a `td` inside a `table`) is readable
 * while the library's class names are not.
 */
const DAY_NUM = /^\d{1,2}$/;
const YEAR_NUM = /^(19|20|21)\d{2}$/;
const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|янв|фев|мар|апр|мая|май|июн|июл|авг|сен|окт|ноя|дек)/i;
const GRID_TAGS = new Set(['td', 'th', 'tr', 'table', 'tbody']);

/** Boil a qa_click reply's `changed` down to the handful of counts the rules ask about. */
export function diffDigest(changed) {
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  const appeared = arr(changed?.appeared);
  const disappeared = arr(changed?.disappeared);
  // `updated` on the wire, `changed` inside the extension — accept both spellings.
  const updated = arr(changed?.updated).length ? arr(changed?.updated) : arr(changed?.changed);
  const names = appeared.map((n) => String(n?.name ?? '').trim());
  const roles = new Set(appeared.map((n) => String(n?.role ?? '')));
  const tags = new Set(appeared.map((n) => String(n?.tag ?? '')));
  const paths = appeared.map((n) => String(n?.selector ?? '')).join(' | ');
  return {
    appeared,
    disappeared,
    updated,
    names,
    roles,
    tags,
    has: (r) => roles.has(r),
    count: (r) => appeared.filter((n) => n?.role === r).length,
    days: names.filter((s) => DAY_NUM.test(s)).length,
    years: names.filter((s) => YEAR_NUM.test(s)).length,
    months: names.filter((s) => MONTH_WORD.test(s)).length,
    grid: [...tags].some((t) => GRID_TAGS.has(t)) || /\b(td|th|tr|table)\b/.test(paths),
    // "It opened": a control whose aria-expanded went false → true. stateOf spells these
    // 'collapsed' and 'expanded', so the transition is readable without the attribute.
    opened: updated.some((u) => /expanded/.test(String(u?.after ?? '')) && !/expanded/.test(String(u?.before ?? ''))),
    closed: updated.some((u) => /collapsed/.test(String(u?.after ?? '')) && /expanded/.test(String(u?.before ?? ''))),
    toggled: updated.some((u) => /checked|selected/.test(String(u?.after ?? '')) !== /checked|selected/.test(String(u?.before ?? ''))),
    valued: updated.some((u) => /value=/.test(String(u?.after ?? '')) && !/value=/.test(String(u?.before ?? ''))),
    empty: !appeared.length && !disappeared.length && !updated.length,
  };
}

/** First match wins, so the most specific shape comes first. `test` takes a diffDigest. */
export const BEHAVIOURS = [
  {
    kind: 'navigated',
    // FIRST, and it has to be: a step that advanced replaces its fields wholesale, so the new
    // step's own inputs land in `appeared` and every popup rule below would happily explain them.
    // A swap is the one diff where BOTH sides are large, which nothing else produces.
    test: (d) => d.disappeared.length >= 5 && d.appeared.length >= 5,
    drive: 'The page CHANGED WHOLESALE — a step advanced or a route changed. Every ref you were holding is void: snapshot again before the next call, and do not reuse the field list from before.',
    verb: 'qa_snapshot',
  },
  {
    kind: 'calendar-popup',
    test: (d) => d.days >= 6 || (d.grid && d.days >= 3) || (d.days >= 2 && (d.years >= 1 || d.months >= 2)),
    drive: 'That click opened a CALENDAR. Do not write into the field — call qa_pick_date with the ISO date; it switches to the year view, steps the month and clicks the day.',
    verb: 'qa_pick_date',
  },
  {
    kind: 'tree-popup',
    // Checkboxes rather than options is the tell: a checkbox-per-row popup is a tree or a
    // checkbox group, and both are driven by clicking the box. A plain multi-select answers
    // with role=option instead, which the next rule owns.
    test: (d) => d.has('treeitem') || (d.count('checkbox') >= 2 && !d.has('option')),
    drive: 'That click opened a TREE. Click the CHECKBOX of the leaf, never its label — a label click selects or expands depending on the library. qa_pick_path walks the levels and does exactly that.',
    verb: 'qa_pick_path',
  },
  {
    kind: 'option-list',
    test: (d) => d.count('option') >= 2 || d.has('listbox'),
    drive: 'That click opened an OPTION LIST, so this control is a select however it is built. Undo the click habit: pass the option TEXT to qa_type (or put it in the qa_type_many batch) and the fill engine opens, waits, picks and verifies in one call.',
    verb: 'qa_type',
  },
  {
    kind: 'menu',
    test: (d) => d.has('menuitem') || d.has('menuitemcheckbox') || d.has('menuitemradio') || d.has('menu'),
    drive: 'That click opened a MENU (not a form control). Click the item by its own name — a menu commits on the item click, so there is nothing to type.',
    verb: 'qa_click',
  },
  {
    kind: 'modal',
    // BEFORE popup-search: a modal usually contains an input, and being a dialog is the stronger
    // fact about it — a dialog is a place to fill, a bare popup input is part of one control.
    test: (d) => (d.has('dialog') || d.has('alertdialog')) && d.days < 3,
    drive: 'A MODAL opened. Snapshot with `within` set to the dialog before filling — a page-wide snapshot hands you the fields underneath it, which are not the ones that will submit.',
    verb: 'qa_snapshot',
  },
  {
    kind: 'popup-search',
    test: (d) => d.appeared.some((n) => n.role === 'searchbox' || (n.role === 'textbox' && n.tag === 'input')),
    drive: 'The popup brought its OWN input: this is a typeahead whose options do not exist until something is typed. Type the option text into that input, allow ~0.5s for the list, then take the match.',
    verb: 'qa_type',
  },
  {
    kind: 'portalled-invisible',
    // The highest-value verdict: the control says it opened, yet the tree gained nothing. Its
    // popup was rendered into a portal out of bare divs and table cells that carry no role, so
    // no amount of snapshotting will find it. Ant's DatePicker is exactly this.
    test: (d) => (d.opened || d.valued) && d.appeared.length === 0,
    drive: 'It opened, but the popup is INVISIBLE to the accessibility tree — portalled markup with no roles (Ant Design does this). Stop snapshotting for it: address its parts by CSS selector, which the bridge resolves without the tree (qa_read / qa_click take one), or let qa_pick_date / qa_pick_path use the library recipe. Ant days are td[title="YYYY-MM-DD"].',
    verb: 'qa_click',
  },
  {
    kind: 'expanded-empty',
    test: (d) => d.opened,
    drive: 'It opened and the tree gained only a little — read it with qa_snapshot { within } on the control, and if the parts you need are still missing, go by CSS selector.',
    verb: 'qa_snapshot',
  },
  {
    kind: 'toggle',
    test: (d) => d.toggled && !d.appeared.length,
    drive: 'That was a TOGGLE — it flipped its own state and opened nothing. A checkbox, radio or switch: give it a truthy value inside the batch instead of a click of its own.',
    verb: 'qa_type',
  },
  {
    /**
     * NOTHING WAS NOTICED — WHICH IS NOT THE SAME AS NOTHING HAPPENED, and the old wording said
     * it was. It ended on «the click genuinely does nothing, which is a finding», so a session
     * reading it stopped and reported a dead control. Twice in one week that report was wrong:
     * a Figma canvas that was taking drags perfectly (12.10.2026), and a Shelf toggle whose
     * aria-pressed had flipped under the diff's nose (11.10.2026). The second kind is the
     * expensive one: in Partner Center the same sentence followed a Submit that HAD gone
     * through, and a repeat would have landed on Delete submission beside it.
     *
     * So the verdict now hands over the next move and keeps the finding as the LAST option,
     * where the evidence actually puts it.
     */
    kind: 'inert',
    test: (d) => d.empty,
    drive: 'Nothing was NOTICED — which is not the same as nothing happening, and the difference has been expensive. The diff sees nodes appear, disappear and change; it can miss a state attribute flipping, a child swapped inside the control you pressed, text rewritten in place, a new tab, a file the browser saved, and anything behind a modal that is hiding the rest of the page. Before concluding the control is dead: read the page back (qa_read or qa_collect on the control, with `state`), and if the action was irreversible — Submit, Pay, Delete — do NOT repeat it, because the first one may well have worked.',
    verb: null,
  },
];

/**
 * Classify a control by the diff its click produced. Returns {kind, drive, verb, why} or null.
 * `why` names the evidence, because a verdict an agent cannot check is a verdict it should not
 * trust — and on a hand-rolled widget this is the only classification available.
 */
export function classifyBehaviour(changed, evidence = {}) {
  /**
   * WHAT THE TREE CANNOT SEE DECIDES THIS FIRST.
   *
   * `inert` is the verdict for a dead control, and it used to be reached by one road: an empty
   * diff. An empty diff is also what a route change leaves when the new view happens to look like
   * the old one, what a DOWNLOAD leaves (nothing in this page moves at all), and what a snapshot
   * that could not be built leaves. On 16.09.2026 a tester was told that «Create new», which had
   * just changed the route, and «Download», which had just fetched a file, were both inert —
   * believed, that files a bug against a healthy button.
   *
   * So the two facts the accessibility tree cannot show are consulted before the shape rules: the
   * ADDRESS (the extension now reports it when it changed) and the NETWORK (whether the click put
   * a request on the wire). And an answer the extension could not measure is no longer an answer.
   */
  if (evidence.navigated && evidence.navigated.to) {
    return {
      kind: 'navigated',
      drive:
        'The click CHANGED THE ADDRESS — every ref you were holding is void. Snapshot again before the next call, and do not reuse the field list from before.',
      verb: 'qa_snapshot',
      why: `the address went to ${String(evidence.navigated.to).slice(0, 120)}`,
    };
  }
  if (evidence.measured === false) {
    return {
      kind: 'unmeasured',
      drive:
        'The click was made, and what it did could NOT be measured — the page would not give a tree to compare (it was navigating, or the document was replaced under us). Do not read this as a dead control: snapshot to see where you are.',
      verb: 'qa_snapshot',
      why: 'the page could not be snapshotted after the action',
    };
  }
  const d = diffDigest(changed ?? {});
  if (d.empty && evidence.requests > 0) {
    return {
      kind: 'off-page',
      drive: `Nothing in the page moved, but the click put ${evidence.requests} request${evidence.requests > 1 ? 's' : ''} on the wire — a download, a background save or a new tab. This control is NOT dead; check qa_findings for what came back, and look for the file rather than for a DOM change.`,
      verb: 'qa_findings',
      why: `${evidence.requests} request${evidence.requests > 1 ? 's' : ''} started, no visible change`,
    };
  }
  for (const b of BEHAVIOURS) {
    let hit = false;
    try {
      hit = !!b.test(d);
    } catch {
      /* a rule that throws on an odd diff must not take the whole classification down */
    }
    if (!hit) continue;
    const bits = [];
    if (d.appeared.length) bits.push(`${d.appeared.length} appeared`);
    if (d.days) bits.push(`${d.days} day numbers`);
    if (d.count('option')) bits.push(`${d.count('option')} options`);
    if (d.grid) bits.push('a grid');
    if (d.opened) bits.push('the control went expanded');
    if (d.valued) bits.push('it took a value');
    if (d.toggled) bits.push('its state flipped');
    if (d.disappeared.length) bits.push(`${d.disappeared.length} gone`);
    return { kind: b.kind, drive: b.drive, verb: b.verb, why: bits.join(', ') || 'nothing changed' };
  }
  return null;
}
