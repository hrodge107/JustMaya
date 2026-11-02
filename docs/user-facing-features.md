# Meet Mita — user-facing features

What the app does and what a learner can do in it. This document is the lobby
mascot's app knowledge: `backend/app/services/mascot_chat.py` injects it into
the Talk prompt so Mita answers app questions from fact rather than memory.
Keep it product-level — no endpoints, model names, or internals — and update
it when a feature ships or changes.

## What Meet Mita is

- Meet Mita turns a document into a playable visual-novel lesson. A document
  goes in; a learning roadmap and one fully generated episode come out.
- Mita is the in-app guide and mascot. She narrates episodes, chats in the
  lobby, and voices the tutor. One name, one personality, everywhere.
- The app is a project build — free to use, no accounts, no ads.

## Home (the lobby)

- Mita greets the learner and keeps up ambient chatter while the page is open.
- Four actions run the app: Talk, Upload, Learn, Menu.
- Talk opens a question box. Mita answers questions about the app and honest
  general questions; questions about a specific document or lesson belong to
  the tutor inside an episode.

## Upload

- Upload accepts one PDF (a chapter, paper, or lecture notes; text-heavy
  documents work best) or 1–5 photos of readable pages.
- Photos can be JPEG, PNG, or static WebP — up to 10 MiB each, 20 MiB total.
- A sample chapter is built in, so the whole pipeline can be tried with no
  file at all.
- While the pipeline runs, a progress chip tracks the stages and Mita narrates
  what she is finding. A stalled read can be retried from the chip.

## Learn and episodes

- Every finished document gets a roadmap: the big ideas, their order, and
  where understanding gets checked.
- Episode 1 is generated fully — scenes, dialogue, checkpoints. Later
  episodes stay as planned outlines only; quality over quantity is a house
  rule.
- Learn lists every document's episodes and which are ready to play.
- When an episode finishes generating, a ready card stays on screen until it
  is played, and Mita asks once whether to jump in.

## Playing an episode

- Episodes play as visual-novel scenes: dialogue beats advance on click or
  Enter, and Mita's expression follows the line.
- Every line read stays reviewable in the backlog; the learner can rewind to
  an earlier moment.
- Recall checkpoints pause the story and ask about what it taught. Wrong
  options are eliminated across attempts, and each wrong pick gets a tailored
  explanation that points at the idea worth rechecking rather than naming the
  answer.
- Picture cards — illustrated note cards — appear during scenes and rest in
  the Gallery afterwards.
- Finishing an episode ends in a recap of what the learner showed.

## Raise Hand (the tutor)

- At any line or checkpoint the learner can raise a hand and ask a free-text
  question — the story position is held exactly.
- The tutor answers in Mita's voice, grounded in the learner's document, and
  shows expandable page references for what it used.
- Two help modes: a straight explanation, or hints that escalate in levels —
  a gentle nudge first, a worked example last.
- Questions beyond what the document covers get honest general-knowledge
  answers, labeled as such.
- Resume Lesson returns to the exact interrupted line.

## Saving and comfort

- Finished episodes (and their PDF) can be kept in the browser's own storage;
  the Learn dialog's "On this browser" shelf lists, replays, and clears them.
- Menu holds a motion toggle (reduced motion swaps typing and animation for
  instant text) and the About page.
- Menu also has Mita’s voice: optional spoken dialogue across Home, lessons,
  and tutor replies. It starts off, carries across surfaces for this visit,
  and resets on refresh. Learner messages stay silent. If voice is unavailable,
  reading continues and a retry remains available.
- No accounts and no tracking; uploaded documents stay in app storage so the
  pipeline can build and replay lessons from them.
