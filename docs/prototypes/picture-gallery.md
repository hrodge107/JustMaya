# Picture notes and Gallery prototype

Question: can learners dismiss a scene's picture note and comfortably revisit it in Gallery?
Branch: `codex/prototype-picture-gallery`. Verdict: ready for design review; no winner or production integration approved yet.

Run `npm run prototype:gallery` from the repository root. It opens
`http://127.0.0.1:5195/src/player/picture-note-prototype.html`.
The standalone Vite configuration starts no backend and proxies no API requests.
This HTML entry needs Vite to load React; opening it directly from disk is unsupported.

## Walkthrough

1. Open Gallery before advancing: it explains that no notes have been encountered.
2. Close it, then click the dialogue or Next scene. The first card appears and enters Gallery.
3. Click its front to read the description and PDF citation. Close or Escape returns focus.
4. Dismiss the card with its separate cross. Gallery retains the note.
5. Advance to the second note. Revisit the previous scene: its card stays dismissed.
6. Open Gallery, select either note, then Back to Gallery. Focus and scroll position return.
7. Menu > Reset demo clears the in-memory demonstration. Refresh does the same.

Fixtures: real passages and rendered sample PDF pages 2 and 3. Page images are explicitly
described as sample stand-ins, with no invented Commons credit or license.
`?images=broken`, `?images=loading`, and `?long` expose image failure, loading, and long text.

## Design decisions

- Existing Nunito, ink/paper/mint tokens and player shell retain Meet Mita's identity.
- ENERGY 2 / RHYTHM 1 / MOTION 2 comes from player.css, including reduced-motion support.
- The original header, stage, dialogue and rail markup/styles are reused; MascotStage is imported.
- Gallery shares the Menu rail; desktop reserves an extra button's header width, mobile keeps the original rail below dialogue.
- Card fronts have one job: show image and title. Dismiss is a sibling button to avoid nested actions.
- Gallery fronts have equal visual weight because the collected notes have equal rank.
- The shared paper dialog widens for readable source passages without changing its frame.
- Demo navigation and state appear below the full player frame so they cannot cover lesson controls.
- Menu contains prototype reset; live tutoring, backlog and production lesson mutations are outside this mock.
- State uses the existing PictureCard shape plus local scene indexes, with no schema or backend changes.

## Verification, 2026-11-01

Baseline init.ps1 passed. Final lint, TypeScript and production build passed. Production
retains the existing optional VRM chunk-size warning; the prototype is not a production entry.

`scripts/verify-picture-prototype.cjs` runs with Playwright Core on Node's module search path
and `CHROMIUM_PATH` pointing to Chromium. Its default preview URL uses port 5195.
Four viewports: 320, 390, 768, 1280 by 844. Phone contexts enable touch; smaller widths use
reduced motion, desktop uses normal motion. Screenshots were visually reviewed at phone,
tablet and desktop sizes. Evidence/screenshot output: `%TEMP%/mita-picture-prototype/`.

Recorded interactions at every width:

- Gallery > empty explanation; Return to lesson > trigger regains focus.
- Next scene > card appears; keyboard Enter > description and citations modal.
- Citation > correct page URL; bundled PDF endpoint responds 200.
- Escape > modal closes and card regains focus.
- Dismiss > card removed, without opening modal; revisit > stays hidden.
- Advance/revisit > exactly two Gallery fronts, no duplicates.
- Gallery front > detail; Back > grid with original focus and scroll position.
- Close > Gallery trigger; Menu > Reset demo > empty Gallery.
- Shift+Tab/Tab > dialog boundary wraps between first and last controls.
- No horizontal page overflow or unexpected console/runtime errors.
- Broken/loading image > title and detail remain usable; long text > scrollable detail and reachable Close.

## Delivery gate

- Hard gate PASS, R-02/17/18/23/28/36/38: prose and fixtures inspected; no em dashes, invented claims, testimonials or unlabeled sample assets.
- Hard gate PASS, R-03/25: screenshots inspected at four widths; measured zero horizontal overflow. Ink on paper, muted ink on wash, and mint-ink links retain AA contrast (all over 4.5:1).
- Hard gate PASS, R-24/26/32/35: interaction list above covers every prototype control and citation target, including Enter, Escape, focus restoration and boundary Tab.
- Hard gate PASS, R-27: empty Gallery, loading image and failed-image detail were exercised.
- Hard gate PASS, R-33/34/37: source edited directly; existing fixed player theme and written design direction retained, no new theme toggle.
- Purpose gate PASS: palette, type, radius and scene background inherit existing identity; card/grid/dialog hierarchy reasons recorded above. No new decorative icons, glow, blur, badges, patterns or animation loops.
- Liveliness PASS: declared dials, Mita's existing face motif, image/title focus, structural spacing and mint action/focus accent are visible in screenshots.
- Craftsmanship/quality locks PASS: content-driven scene and Gallery, working controls, mobile and keyboard checks, existing shared chrome, honest fixtures and documented design reasons. No new layout template, product clone, marketing section or theme.

This prototype does not change the passing production picture-card behavior. Production
adoption needs a separate confirmed feature scope and real image fixtures.
