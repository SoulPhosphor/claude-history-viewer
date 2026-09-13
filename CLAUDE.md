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

## Product notes (labels + bulk tool)

- **Conversations can have multiple labels** (not one).
- **Bulk tool Preview**: the Preview button stays. Preview **temporarily applies
  all the current filter criteria to the conversation list** so the user can
  review which conversations match — it is not a stats-only readout. The user is
  **never required** to press Preview before Apply; Apply works on its own.
