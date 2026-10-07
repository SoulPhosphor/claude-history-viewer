# App style guide

This guide describes the **current live app**. The default colours and desktop appearance are preserved. No new theme is included. `advanced-search.html` and `advanced-search-desktop.html` are standalone design references, not live app pages; their purple design has not been applied.

## Where styles belong

| File | Responsibility |
| --- | --- |
| `static/theme.css` | **Single source of appearance values.** Colours, typography, spacing, dimensions, borders, shadows, motion, and existing component variables. |
| `static/style.css` | Shared reset, app layout, conversation rendering, feature screens, shared controls, runtime state classes, responsive content, reduced motion. |
| `static/settings.css` | Settings rows, switches, About/update controls, and existing header/folder refinements. Uses `theme.css` values. |
| `static/advanced_search.css` | Advanced filters, search history, results, and result sizing states. Uses `theme.css` values. |
| `static/index.html` | Semantic markup and stylesheet links, in the order above. **No embedded `<style>` blocks or decorative `style` attributes.** |
| Frontend JavaScript | Behaviour, classes, user content values, and measured positioning/resizing. It does not define the app's palette or decorative styles. |
| `static/accessibility.js` | Shared modal focus/isolation, keyboard actions, menu navigation, resize semantics, summary-hint focus, and reduced-motion scrolling. Loaded before feature modules. |
| KaTeX stylesheet/rendered markup | Vendor-owned mathematical typography and formula geometry; keep its layout intact. App text inherits its surrounding theme. |

The split component stylesheets are intentional: the app has one central value source without forcing every feature into one unmanageable rule file. All app-owned CSS is external. When adding a stylesheet, link it after `theme.css` and include it in `server.py::_static_signature()` so the existing update/reload mechanism notices changes.

## Colour roles

Use a role, not a literal colour. Matching current colours do not imply matching meanings.

| Variable | Use |
| --- | --- |
| `--bg` | Main surfaces, fields, menus, dialogs. |
| `--sidebar-bg` | Navigation and secondary/editor surfaces. |
| `--hover` | Hovered controls and subtle raised surfaces. |
| `--active-bg`, `--active-line` | Selected conversation fill and its leading indicator. |
| `--border` | Normal separators and control borders. |
| `--text` | Primary readable text. |
| `--muted` | Secondary information, dates, hints, idle icons. |
| `--accent`, `--on-accent` | Actions/selected controls and their foreground. Check their contrast together when creating a theme. |
| `--user-label`, `--user-bubble` | User-message role text and bubble background. |
| `--code-bg` | Code and table-header surfaces. |
| `--mark-bg` | Default summary highlight; derived from the accent. Custom highlights are saved content colours. |
| `--warning-text`, `--warning-weight` | Existing warning copy and destructive confirmation colour. |
| `--error-text` | Errors and destructive control hover outlines/text. Kept distinct from the current warning colour. |
| `--model-warning-icon` | Model availability/coverage information icons. Their current black colour is deliberate in repo guidance. |
| `--compare-chatgpt-default`, `--compare-claude-default` | Default Compare provider identifiers. |
| `--compare-chatgpt`, `--compare-claude` | Effective Compare identifiers; explicitly saved preferences may override them. Advanced Search uses these same provider identifiers. |
| `--import-provider-chatgpt`, `--import-provider-claude` | Import-history provider badge backgrounds. Their existing colours differ from Compare identifiers; do not normalize them without a design decision. |
| `--tabs-bg` | Compare strip background; intentionally kept distinct from secondary surfaces. |
| `--search-term-bg` | Highlight of matched text in a conversation. |
| `--search-user-hit-bg`, `--search-current-bg`, `--search-match-border`, `--search-flash-*-bg` | Search-result role shading, selected match, match rail, and jump animation. Accent-derived translucencies follow `--accent`. |
| `--attachment-unavailable-color`, `--attachment-resolved-bg` | Unavailable-file indicator and repaired attachment row. |
| `--lightbox-*`, `--modal-backdrop` | Image overlay and modal dimming. These have their own foreground/backdrop roles. |
| `--shadow-menu`, `--shadow-popover`, `--shadow-modal`, `--shadow-hairline` | Shared elevation/depth treatments. |
| `--summary-author-*-color` | Existing summary authorship identifiers, independent of provider identity. |

`theme.css` retains the existing component APIs (`--summary-*`, `--bookmark-*`, `--notes-*`, `--switch-*`, `--settings-*`, `--about-*`, `--update-*`, `--label-*`, `--gb-*`, `--advanced-*`). Most component colours alias the roles above, allowing a global palette change or a targeted component override in the same file.

## Typography, spacing, and dimensions

| Family | Meaning and rule |
| --- | --- |
| `--font-ui` | System interface font stack. Preserve native controls' existing typography; explicitly inherit for new app controls. |
| `--font-message-code`, `--font-file-code`, `--font-identifier` | Existing monospace stacks for Markdown/code, file previews, and source IDs. Separate names preserve their current differences. |
| `--font-size-*px` | Shared absolute UI type scale. Values use `rem`, so `--font-size-15px` defaults to `0.9375rem` (15px with the browser's default 16px root font). The suffix records the old default, not a mandatory unit. |
| `--font-size-*em`, `--font-size-*rem` | Existing document-relative and section-relative sizes. Keep `em` when text should scale with its parent. |
| `--weight-*` | Shared medium, semibold, and bold weights. |
| `--line-height-*` | Unitless text rhythm; scales with font size. |
| `--space-*` | Existing spacing scale: gaps, margins, and padding. `em` spacing follows text. |
| `--size-*` | Reusable small control/icon dimensions. A visible glyph and its clickable area are different dimensions. |
| `--radius-*`, `--radius-pill` | Corners; pill means fully rounded. |
| `--stroke-*` | Border/outline thickness. |
| `--duration-*`, `--opacity-*` | Existing motion durations and opacity levels. |
| `--content-max-width`, `--content-detail-max-width` | Reading widths for messages/cards and narrower detail content. |
| Component dimension variables | Feature-specific widths, minimum heights, truncation limits, and form/table column dimensions. Use the component's semantic token when the dimension has a specific purpose. |

The scales preserve fractional sizes, different radii, spacing, and minimum heights. **Do not round values or make unlike components identical during a maintenance change.** If a new element needs independent adjustment, add a meaningful component variable that aliases the closest existing shared scale. Do not copy a raw value into a component rule or invent a theme-specific selector.

Structural CSS can use `0`, percentages, `auto`, `none`, `inherit`, `currentColor`, `transparent`, flex/grid fractions, and transformation geometry. These describe layout relationships rather than a palette. The 980px viewport, 760px viewport, and 600px content-container query conditions are literal because CSS variables cannot be used in query conditions. SVG view boxes, path coordinates, and strokes in SVG source are image geometry; use `currentColor` for app icon paint.

## Which existing styles to use

| Purpose | Classes / selectors | Appearance variables |
| --- | --- | --- |
| Main navigation | `#sidebar`, `.sidebar-header`, `.conv-item`, `.conv-title`, `.conv-meta`, `.conv-snippet`, `.conv-item.active` | Base surface/text roles, `--sidebar-w`, `--sidebar-collapsed-w` |
| Provider selection | `.provider-toggle`, `.provider-seg`, `.provider-seg.active` | Base roles, shared type/size/radius scale |
| Simple search | `#simple-search-panel`, `.search-wrap`, `#search`, `#search-clear-btn`, `#manage-search-btn` | `--simple-search-*` |
| Floating action menu | `.sidebar-menu`, `.sidebar-menu-item`, `.thread-dropdown`, `.thread-dropdown-item` | Base roles, menu/dropdown dimensions, `--shadow-menu`, `--shadow-popover` |
| Conversation header | `.thread-titlebar`, `.thread-header`, `.thread-header-main`, `#thread-actions`, `#thread-meta`, `#thread-tags` | Base roles, shared scale, `--thread-chevron-*`, `--tag-row-*` |
| Conversation messages | `.message`, `.message.user`, `.message.assistant`, `.message-body`, `.message-role`, `.message-time` | Reading widths, text roles, user/code/highlight roles, `--message-time-*` |
| Markdown tables | `.message-body .table-wrap`, `.md-align-left`, `.md-align-center`, `.md-align-right` | Code/border roles, `--table-text-cell-min-width` |
| Source/code content | `.message-body code`, `.message-body pre`, `.copy-btn`, `.plaintext-block`, `.diagram-block` | Code surface, monospace/type scales |
| File/artifact controls | `.file-chip`, `.artifact-chip`, `#file-panel`, `#artifact-panel` | Chip widths, `--file-panel-*`, `--artifact-panel-*`, `--side-panel-*` |
| Media gallery | `.media-hub-*`, `.gallery-thumb` | Shared roles/scale, `--media-grid-min-column`, surface sheen/shadow |
| Memory/project cards | `.memory-block`, `.project-card`, `.project-docs-loading`, `.project-docs-empty` | Reading widths and shared roles/scale |
| Dialog | `.modal-overlay`, `.modal`, `.modal-title`, `.modal-buttons`, `.modal-btn`, `.modal-btn-primary`, `.modal-btn-danger`, `.modal-check` (a checkbox line) | Modal dimensions/shadow/backdrop and action/warning roles, `--modal-check-*` |
| Screen heading | `.thread-header h1` | Existing screen-title type/colour scale; document headings use separate `.message-body h*` rules. |
| Tags and selection chips | `.tag-chip`, `.tag-chip-name`, `.tag-add-btn`, `.tag-add-input` | Shared role/scale, tag field/truncation variables |
| Conversation labels | `.label-chip`, `.label-square`, `.label-text`, `.label-indicator`, `.conv-label-row` | `--label-*` and runtime `--label-color` |
| Label picker entries | `.menu-label-dot`, `.menu-label-bar`, `.label-choice-menu` | Label/picker dimensions and runtime `--label-color` |
| Settings section/row | `.settings-section`, `.settings-section-title`, `.settings-setting`, `.settings-setting-text`, `.settings-setting-title`, `.settings-setting-subtext` | `--settings-*` |
| Settings switch | `.settings-switch`, `.settings-switch-track`, `.settings-switch-thumb` around a native checkbox | `--switch-*`; keep the native checkbox and label |
| About/update | `.about-update-row`, `.update-status`, `.update-status-error`, `.update-spinner`, `#check-update-btn` | `--about-*`, `--update-*` |
| Label management / bulk operations | `.labels-section`, `.labels-section-title`, `.labels-section-hint`, `.label-row`, `.bulk-row`, `.bulk-chip-row`, `.bulk-buttons` | Label/form dimensions, shared roles/scale |
| Snapshots and saved runs | `.snapshot-row`, `.snapshot-btn`, `.snapshot-btn-danger`, `.bulk-run-*` | Shared roles/scale and form widths |
| Import screens | `.import-*`, `.audit-*`, `.att-report-*`, `.att-row-resolved` | Import provider/attachment roles, reading widths, shared scale |
| Custom GPT manager | `.gizmo-*` | Reading widths, identifier font, shared roles/scale |
| Full Summary / Notes editors | `.summary-section`, `.summary-editor`, `.summary-toolbar`, `.summary-textarea`, `.summary-btn`, `.notes-full-textarea` | `--summary-*`, `--notes-full-min-height` |
| Visual summary | `.summary-visual`, `.summary-visual-line`, `.summary-palette-*` | Summary/editor roles, palette defaults; runtime author colours |
| Temporary Notes sidebar | `.notes-side-panel`, `.notes-side-section`, `.notes-side-heading-row`, `.notes-side-revert` | `--notes-panel-*` |
| Conversation bookmarks | `.bookmark-msg-btn`, `.bookmark-title`, `.bookmark-name-dialog`, `.bookmark-bar`, `.bookmark-panel` | `--bookmark-*` |
| Global bookmarks | `.gb-*`, `#global-bookmarks-toolbar`, `#global-bookmarks-scroll` | `--gb-*` |
| Related Conversations | `#related-toggle-btn`, `.related-panel`, `.related-panel-*`, `.related-sort-row`, `.related-list`, `.related-empty`, `.related-find-*`, `.related-location*`, `.related-link-btn`; rows are sidebar `.conv-item` rows | `--related-*` (aliases the bookmark-panel, Load more and Advanced Search location values) |
| Advanced filters/results | `.advanced-filter-*`, `.advanced-chip-*`, `.advanced-result-*`, `.advanced-results-*` | `--advanced-*` |
| Warning / hidden accessible copy | `.warning-text`, `.sr-only` | Warning roles; keep `.sr-only` geometry intact |
| Branch visibility and resizing | `.branch-hidden`, `body.resizing-columns`, `body.resizing-rows` | State/interaction only, no palette |

Class names above are a lookup map, not interchangeable utilities: read the corresponding component section before reusing a class with different markup. Many IDs define screen-specific layout and should not be copied into new controls.

## Features that share code (change together)

**Related Conversations** (`related.js`, `related.py`) is built from existing pieces. When one of these changes, check the other place:

| What | Shared with | Where |
| --- | --- | --- |
| Rows in the Related panel | Sidebar rows | `buildRelatedRow()` in `related.js` copies `appendListItems()` in `app.js` (same `.conv-item` classes, label squares, summary hint, ⋮ button). A new piece of information on sidebar rows needs adding to both. |
| ⋮ menu on Related rows | Sidebar ⋮ menu | `openRelatedRowMenu()` in `related.js` mirrors `openConvItemMenu()` in `app.js`, with "Remove Link" on top. Archive/Restore/Delete follow where each chat lives instead of the sidebar view. |
| Location\Title | Advanced Search results | Advanced Search: `resultLocation()` and `.advanced-result-location` (a button that lists the location). Related panel: `relatedLocationName()` and `.related-location` (plain text). `--related-location-*` aliases `--advanced-location-*`, so one change rethemes both. |
| Find Related Conversations | Advanced Search itself | Not a copy: it is Advanced Search in Related mode (`ui.related` in `advanced_search.js`). Filters, history, result cards and the result ⋮ menu are the same code, so Advanced Search changes apply to both. Related mode only adds: `relatedLinkButton()` (Hub / Add Circle before the title), the top ⋮ item ("Add to Related Chats" / "Remove Link"), result clicks that preview without closing the search, and `exclude_ids` so the chat never lists itself. |
| "Permanently Remove this link?" | Dialog styles | `#unlink-modal` in `index.html`; standard `.modal` classes plus `.modal-check`. |

## State and dynamic exceptions

Use existing `.active`, `[hidden]`, `:hover`, `:disabled`, `:focus-visible`, `[aria-pressed]`, `[aria-expanded]`, and feature data attributes. A CSS `display` rule can override the browser's `[hidden]` rule: add a matching `[hidden] { display: none; }` for any new explicitly displayed surface. Keep state attributes meaningful to assistive technology.

These runtime changes are legitimate and intentional:

| Runtime value | Why it is dynamic |
| --- | --- |
| `--label-color` | A validated saved colour belongs to a user's label. Every label surface draws it through shared CSS. The fallback lives in `theme.css`. |
| `--summary-inline-highlight-color`, `--summary-swatch-color` | Author-selected content/highlight colours; preserve them across UI themes. The legacy `#fff3a3` comparison in `summary.js` is a persisted Markdown shorthand sentinel, not an app style. |
| Compare custom properties | Explicit provider colour preferences. Defaults and Reset come from `theme.css`; default preferences leave the CSS values free to inherit. |
| `--sidebar-w` | Saved sidebar width / drag result. Supported persisted limits are 220–520px; backend and form validation share that product contract. |
| `--file-panel-width`, `--artifact-panel-width` on `#main` | User drag measurements. CSS computes message clearance from the same width and gap; no duplicated `paddingRight` styling. |
| `--advanced-results-height` | User-dragged result height. Existing min/default/max classes/data attributes continue to control layout. |
| `--sidebar-overlay-layer` | Notes/bookmarks/Related Conversations opening order. CSS owns the layer declaration; JS supplies the stack order. |
| Inline `left` / `top` for popovers | Measured anchor coordinates and viewport collision handling cannot be a static stylesheet value. Only position, not colour/font/padding, is supplied at runtime. |
| `<input type="color">.value` | Native editable form data. Defaults are read from CSS; user edits remain data. |
| KaTeX-generated inline geometry | Vendor output needed to position formula parts; do not strip it. |

`themeValue()` / `themePixels()` in `app.js` are the shared bridge for CSS defaults used by controls/dragging. Pixel dimension tokens read by `themePixels()` must resolve to a numeric px value, not an unresolved `clamp()`/`calc()` expression.

## Responsiveness and accessibility

Content panels query their **available width**, so the layout responds when sidebars consume space. Below 600px of content, padding contracts and headers/actions reflow. Fields and media grids stay within their parent width. Dialogs scroll when the window is short. File/artifact widths are bounded, and compact previews keep close controls reachable.

Below a 760px viewport, the workspace can scroll horizontally to reach open panes. This preserves the existing multi-pane navigation; it is not a new mobile navigation design. Normal reading within a pane, forms, and controls should wrap; tables, code, and diagrams can scroll horizontally when preserving their structure matters.

New controls need a semantic button/input and accessible name, keyboard access, and a disabled/error state when applicable. Do not add focus outlines or focus rings: the app has no global focus outline and no switch focus ring. New resizers need a keyboard alternative. Colours must retain readable contrast and must not be the only indicator of an error or selection. Honour reduced motion; use the shared reduced-motion values. See `STYLE_REVIEW.md` for outstanding findings and retained differences.

Follow these existing accessibility patterns without adding decorative inline styles:

- Use native buttons for new actions. For existing text/image targets whose layout must stay intact, `makeKeyboardAction()` adds Enter/Space and a name. Apply it to the action itself, never a row containing another button/input. Compare/history rows keep open and remove actions separate.
- Use a native `h1` for each screen title and labelled `aside`/`nav` landmarks for navigation. `.workspace-controls` uses `display: contents` to group floating controls semantically without adding a box to the flex layout. Keep the main landmark outside navigation landmarks.
- Name fields with visible labels or `aria-labelledby`; use `aria-label` for compact controls when a new visible label would change the existing layout. Model editors include row identity in their name. Announce errors with `role="alert"` and normal asynchronous feedback with `role="status"`.
- Dialogs need `role="dialog"`, `aria-modal="true"`, and an accessible title; optional descriptions use `aria-describedby`. Mark a safe cancellation button `data-dialog-cancel`. Escape **must not** invoke permanent deletion/dismissal. Use `data-dialog-initial-focus` when the safe initial choice is not the first control. The shared lifecycle traps Tab, isolates the background, and restores focus on hide/removal. Keep dialogs outside the app workspace so background isolation can work.
- Call `prepareActionMenu(menu, trigger, close)` when opening an action menu and `restoreActionMenuFocus(menu)` before hiding/removing it. It supplies arrow/Home/End, Escape, and focus return. Menus stay inside the workspace navigation landmark. Preserve explicit feature cancellation hooks.
- Call `setupResizeHandle()` for keyboard-accessible separators. Mouse and keyboard setters must update the same width/height custom property. Arrow direction follows the pane edge; Shift increases the step, Home/End reach existing limits, and current values are announced.
- Summary previews are available on focus and hover and dismiss with Escape. Maintain the tooltip's description relationship and do not leave stale descriptions after hiding.
- Use `preferredScrollBehavior()` for programmatic scrolling so reduced-motion users get immediate movement. CSS reduced-motion rules cover transitions and animations separately.

The preserved default palette has known contrast failures, recorded in `STYLE_REVIEW.md`. A future colour pass must fix those pairings centrally; this appearance-preserving refactor does not certify full accessibility conformance.

## Verification before merging future style work

1. Run `python -m unittest discover -s tests -q` and `node --check` on changed JS files.
2. Run `python scripts/check_styles.py` to check centralization and variable references.
3. Inspect representative pages and interaction states at ordinary desktop size and narrow content widths. Include expanded/collapsed sidebars, advanced results, Summary/Notes, label pickers, bookmarks, code/tables, previews, and dialogs.
4. For a maintenance-only refactor, compare current defaults against the previous version. Preserve inconsistent legacy styling unless the user requested a visual change.
5. For a future theme, override the roles/component variables centrally, check translucent/search/provider/overlay states as well as normal screens, and verify that saved content colours remain unchanged.
