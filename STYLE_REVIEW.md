# Style and accessibility review

Reviewed the live app against `f3b2722` (the Simple Search merge). This is a maintenance refactor: the existing default palette and desktop layout remain intact. No theme was created or applied. The Advanced Search design-reference HTML files remain unchanged.

## Scope

Reviewed all app-owned HTML, CSS, JavaScript modules, generated Markdown/feature markup, stylesheet serving/reload logic, and repository documentation. The Python launcher/backend do not define a second visual interface. All live app appearance defaults now belong to `static/theme.css`; component rules remain in external CSS. `STYLE_GUIDE.md` describes roles, existing components, runtime exceptions, responsiveness, and verification for future features.

Self-contained `advanced-search.html` and `advanced-search-desktop.html` are design references, not routes or live stylesheets. KaTeX owns its mathematical typesetting and generated formula positioning. Those are legitimate exceptions to the live app's centralization rule.

## Changes made

- Centralized colours, fonts, type sizes, spacing, dimensions, borders, shadows, opacity, and motion. Kept distinct existing component values instead of normalizing them. Accent-derived search shading now follows the central accent.
- Replaced generated table alignment styles with named classes; project placeholders, branch visibility, drag cursors, and user-selection state also use CSS classes.
- Moved label colours, content highlights, saved Compare preferences, measured preview widths, result heights, and overlay order to documented custom properties. Default colour-picker values come from the theme.
- Kept popover anchor coordinates dynamic. A stylesheet cannot know the clicked element's screen position or the current viewport collision.
- Added available-width container queries for compact content, field/grid constraints, wrapping toolbar/header controls, scrollable compact table wrappers, and bounded/scrollable dialogs. A minimized Advanced Search results panel now fits its wrapped toolbar instead of clipping it.
- Added shared reduced-motion handling, including programmatic scrolling. The global focus outline and the settings-switch focus ring were removed at the user's request; do not add them back.
- Added explicit names to Summary/Notes fields, model-table editors, the bulk limit, search, naming, and bookmark/Custom GPT editors. Added alert/status semantics for existing feedback, provider pressed state, native level-one screen headings, and a navigation landmark for floating workspace controls.
- Added shared modal naming, focus entry/trapping, inert background isolation, Escape cancellation, and return focus for seven static dialogs, the image lightbox, and the Custom GPT confirmation. Destructive confirmations start on Cancel. Coverage Escape uses Okay, preserving the warning; Dismiss keeps its existing explicit permanent-dismiss behaviour.
- Added keyboard access to conversation/month/folder/search targets, inline images, bookmark and Custom GPT names, and summary previews. Compare/history rows expose their open action separately from their remove button. Existing label-reorder keyboard behaviour remains intact.
- Added keyboard resizing and announced values for navigation, file/artifact previews, and Advanced Search results: relevant arrow keys, Shift for larger steps, Home/End for limits. Added keyboard menu entry, arrow/Home/End navigation, Escape, and return focus.
- Added `scripts/check_styles.py` to detect embedded/decorative styling, misplaced defaults, literal component colours/lengths/fonts, and undefined CSS variables. Updated the reload signature for the new theme/accessibility modules and Summary files.

## Existing differences retained

These are findings for a future design decision, not changes made by this refactor.

| Area | Current difference / consequence | Where to adjust later |
| --- | --- | --- |
| Buttons | Dialog primary/danger actions are filled; generic dialog actions and many screen controls are outlined or surface-coloured. Some destructive screen actions only change on hover. | `.modal-btn-*`, `.summary-btn-*`, `.snapshot-btn-*`, `.label-row-*`; use the guide's component map rather than applying one button rule everywhere. |
| Unsaved Notes dialog | Uses a native `h2` and `.modal-actions`; other dialogs use `.modal-title` and `.modal-buttons`. This produces different text/button arrangements. | `notes-unsaved-modal` in `index.html`. Its current appearance is deliberately retained. |
| Provider identity | Compare/Advanced Search use blue/green provider identifiers; import history uses different provider badge colours. | `--compare-*-default` versus `--import-provider-*`. |
| Surfaces | Compare-strip, sidebar, input, code, user-message, and overlay surfaces are not all identical. | `--tabs-bg`, `--sidebar-bg`, `--code-bg`, `--user-bubble`, component surface aliases. |
| Fonts / radii / spacing | Multiple existing monospace stacks, fractional text sizes, radii, gaps, and minimum widths remain. | Shared scales and semantic component variables in `theme.css`. |
| Markdown table wrapping | Previously, selectors looking for spaced inline `text-align: center/right` never matched the generated compact `text-align:center/right` attributes. All body cells therefore wrapped and had the same minimum width. The class refactor preserves that effective behaviour. | `.message-body td` and `.md-align-*`; alignment works, but changing wrapping is a separate visual decision. |
| Workspace on phones | The app is a multi-pane workspace. At very narrow widths it allows horizontal workspace scrolling; each pane adapts its own contents. | A mobile navigation redesign would be separate work. Tables/code retain internal scrolling where appropriate. |
| Recycle controls | Existing `#recycle-controls` display rules can override the element's `hidden` attribute. Changing that would remove currently rendered controls from ordinary views. | Resolve the intended visibility separately; this appearance-preserving refactor does not silently change it. |

## Colour contrast findings retained for the colour pass

The current palette still fails several text-contrast checks. Correcting these requires changing visible colours, conflicting with the request to keep the present appearance. They have not been silently recoloured. Accessibility fixes above do not imply full WCAG conformance.

Approximate solid-colour ratios below use the current default values. Normal text generally needs 4.5:1; large text needs 3:1. Actual states must also account for opacity, overlapping surfaces, and user-chosen colours. Reference: [WCAG contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

| Current pairing | Ratio | Affected role |
| --- | ---: | --- |
| Muted text `#7c6f67` on sidebar `#f0ede8` | 4.16:1 | Secondary text on sidebar/editor surfaces |
| Accent `#d97757` on main `#faf9f6` | 2.97:1 | Small accent action/selected text |
| White on accent `#d97757` | 3.12:1 | Filled small primary actions |
| White on import Claude badge `#b8622f` | 4.35:1 | Import badge text |
| White on import ChatGPT badge `#10a37f` | 3.20:1 | Import badge text |

The axe audit also flags author/other muted states. Resolve contrast centrally through the semantic roles, then inspect hover, selected, disabled, highlight, provider, and saved custom-colour states. Labels with arbitrary user colours retain their existing accessible names and text alternatives; do not overwrite saved content colours to match a UI theme.

## Verification

- Python suite: 83 tests passed.
- JavaScript syntax checks, whitespace checks, and the central-style guard passed.
- Chromium comparison at 1440×1000: 17 views checked against the baseline for computed paint, typography, spacing, dimensions, borders, shadows, alignment, wrapping, and element rectangles. Native heading changes and Markdown alignment classes were normalized only for DOM identity matching; their computed appearance was compared normally.
- Responsive checks: Settings, Labels, Summary, Notes, and Global Bookmarks at 1024, 768, 480, and 320px; no unintended content overflow in those checks. Compact tables scroll inside their wrappers. Checked preview close controls and wrapped/minimized Advanced Search toolbar behaviour.
- Keyboard/browser checks cover modal isolation/focus/cancellation, menu navigation, resizing, reduced motion, and summary-preview focus. Automated accessibility checks across the representative screens retain colour-contrast findings described above.

Fixtures use an isolated sample database, not private conversation data. These checks cannot substitute for testing a future palette or every possible imported document. KaTeX CDN requests were disabled in browser comparison so network availability did not affect the result; vendor formula rendering was outside this refactor.
