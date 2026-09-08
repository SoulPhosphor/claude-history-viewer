# Working agreement for this repository

These rules are binding for any AI assistant working in this repo. They exist
because getting UI/UX/wording wrong costs the user real money to undo and redo.

## Never make decisions for the user

- It is **NEVER acceptable to make a decision for the user** unless they have
  **explicitly** said it is acceptable for that specific decision. No exceptions,
  no "sensible defaults," no "I'll do X unless you say otherwise."

## Never assume — especially UI, UX, and wording

- Do **NOT** make assumptions about UI, UX, or wording. If any detail of layout,
  placement, styling, interaction, labels, button text, dialog copy, or ordering
  is unspecified or ambiguous, **stop and ask** before writing code. Do not pick
  a "sensible default" and proceed.
- Do **NOT** tell the user "I'll do X, tell me if you'd rather otherwise" and
  then implement X. If input is needed, you have not been given permission to
  proceed. Saying they can redirect is not the same as waiting for them to.

## Stop and wait when input is needed

- If you need instructions or a decision, **stop immediately and wait**. Do not
  keep building past the point of uncertainty. Ask your question(s) in plain
  text (the user dislikes the pop-up/question tool) and wait for the answer
  before continuing.
- It is always better to ask one more question than to build the wrong thing.

## Language

- Everything must be in English. If you encounter non-English text (e.g. kanji)
  in code you are already editing, change it to English.
