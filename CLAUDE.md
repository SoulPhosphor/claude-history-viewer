# Working rules for Claude in this repo

These are hard rules. Follow them exactly.

## Interaction

- **NEVER use pop-up / interactive multiple-choice questions** (the
  `AskUserQuestion` tool, chips, option cards, any modal picker). They are not
  acceptable here. If something genuinely needs clarifying, ask in **plain text**
  in your normal reply — but prefer to follow the instructions already given and
  just do the work.
- Do not re-ask things the user already answered. Read the whole message before
  acting.
- Keep replies short. Do the work; don't narrate options you won't take.

## Behavior

- Follow the user's instructions literally. Do not add, remove, or redesign
  features the user did not ask for. "Make it work" ≠ "redesign it."
- When told to change one thing, change that thing only.
- Use concise, direct language, plain english language.
- With UI elements consider that later color theming will happen and elements
  should be adjustable from anywhere.
- In practice that means: no hard-coded colours, sizes, or weights in a rule
  that a theme would want to change. Put the value in a CSS variable on
  `:root` and use `var(--x)` everywhere, so one override rethemes the lot.

## Product notes (labels + bulk tool)

- **Conversations can have multiple labels** (not one).
- **Label names are optional.** A label with no name is a colour-only square.
  Enabling labels never forces the user to type names.
- **Sidebar placement.** One bare square (no name shown) sits inline before the
  title. As soon as there are two or more squares, or any square shows a name,
  they all move to their own row under the date/messages line. Bare squares wrap
  freely across that row; named ones are capped at three per line
  (Box Label Box Label Box Label, then wrap).
- **One element everywhere.** The chip beside the title, the chips under the
  date/messages line, and the chips in the thread header are the same
  `.label-chip`, sized from the same CSS variables.
- **Square + Label reminder.** While "Square + Label" is selected and any square
  still has no name, show the warning by the display dropdown. It clears when
  every square has a name and comes back if a name is later emptied. When no
  square has a name, put the cursor in the top name box.
- **Bulk tool Preview**: the Preview button stays. Preview **temporarily applies
  all the current filter criteria to the conversation list** so the user can
  review which conversations match — it is not a stats-only readout. The user is
  **never required** to press Preview before Apply; Apply works on its own.
