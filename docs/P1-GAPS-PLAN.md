# P1 gaps — design, ready to implement

Two gaps found during the real-Chrome / bilibili work. Both are INDEPENDENT of the
blocked chokepoint-widening question (bobo's A/B/C answer): neither opens a banned
surface, both stay inside the `_br.*` structured-action model, i.e. they are exactly
the direction option A points.

Status: **designed, NOT yet implemented.** Code reading done against
`extension/actions.js`, `extension/policy.js`, `relay/chokepoint.js`,
`tools/test-real-chrome.js`, `tools/test-extension.js`.

---

## Gap 1 — `_br.press` (named-key whitelist)

**Why:** P0 has navigate/click/fill/snapshot/waitFor but no keyboard. bilibili's
search submits on Enter; that was worked around with a direct URL nav. Raw
`Input.dispatchKeyEvent` from the agent is and stays BANNED.

**Shape:** the agent sends a key *name*; the extension owns the descriptor. Same
rule as the rest of the file — agent supplies data, never code, never coordinates,
and here never raw key codes either.

```js
// extension/actions.js
const NAMED_KEYS = {
  Enter:  { key: 'Enter',  code: 'Enter',  windowsVirtualKeyCode: 13, text: '\r' },
  Tab:    { key: 'Tab',    code: 'Tab',    windowsVirtualKeyCode:  9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};
```

Exactly these three (what the recorded plan says). No modifiers — no ctrl/meta
combos, which is what keeps this from becoming a raw-input lane by degrees. The
table is the single place to extend.

**Injected helper `pagePrepareKey({selector})`:**
- optional `selector` → `scrollIntoView` + `focus()`; else act on `document.activeElement`
- refuse when nothing is focused (`activeElement` is null or `document.body`) —
  a blind keystroke is the keyboard equivalent of a blind click
- refuse when the focused element is a password field (same stance as `_br.fill`;
  use the IDL `el.type`, not `getAttribute('type')` — see gap 2)
- report `el.closest('form')?.action` so `brPress` can screen it

**`brPress(tabId, params)`:**
1. exact-match `params.key` against `NAMED_KEYS`; anything else → refusal naming the
   three accepted values
2. run `pagePrepareKey`, then `isBlockedUrl(formAction)` → refuse (Enter submits;
   the form's action is the only place that destination is visible)
3. `Input.dispatchKeyEvent` keyDown (+`text` when the key has one) then keyUp
4. Enter can navigate → poll `chrome.tabs.get` briefly like `brNavigate` does and
   re-screen the landed URL with `isBlockedUrl`

**Wiring (all four lists must move together — `test-extension.js:301` asserts
capabilities ≡ `policy.ALLOWED_BR_METHODS`, and `:298` asserts extension ⊆ relay):**
- `extension/actions.js` → `CAPABILITIES`, `HANDLERS`
- `extension/policy.js` → `ALLOWED_BR_METHODS`
- `relay/chokepoint.js` → `ALLOWED_BR_METHODS` **and** `MUTATING_METHODS`
  (press can submit a form, so a retry after a mid-flight cutoff must be
  idempotency-cached)
- `docs/PROTOCOL.md`, `README.md`

⚠️ Adding `_br.press` to `chokepoint.js` is NOT the widening bobo is being asked
about. It touches only the `_br.*` pseudo-method list; `BANNED_METHOD_PATTERNS`
(`Runtime.*`, raw `Input.*`, `Target.*`) is untouched. Say so in the commit.

**Tests:** `tools/test-chokepoint.js` (allowed + `isMutating`);
`tools/test-extension.js` (stub `pagePrepareKey` result; assert a bad key name is
refused and that a good one reaches `Input.dispatchKeyEvent`);
`tools/test-real-chrome.js` (fixture form that submits on Enter — the page's own
handler must observe it, which is the only proof the event was trusted).

---

## Gap 2 — `labelOf()` tightening

**Why:** on machine-generated markup a wrapper `<a>` card has no text of its own, so
the current "own text" step concatenates every descendant: a bilibili result card
labelled itself `"6.5万\n109\n02:25:21"` — true, useless, and it crowded out the real
title. Three further defects found while reading it:

1. `document.querySelector('label[for="' + el.id + '"]')` is built by string
   concatenation from page-controlled data. An id containing `"` or `]` changes what
   it matches, or throws — and an uncaught throw kills the whole snapshot.
2. password detection uses `getAttribute('type')`, so a field whose type was set from
   script (`el.type = 'password'`) is not detected — and the same attribute read is
   used for `rec.type`/redaction in the main loop and in `pagePrepareFill`.
3. labels keep newlines, so the 120-char cap truncates a blob rather than carrying
   ~120 chars of meaning.

**New chain (first non-empty wins), everything through `norm()` = collapse
whitespace + trim:**

1. `aria-label`
2. `aria-labelledby` → resolve the ids, join their text
3. native label — build the map ONCE in `pageSnapshot` scope before the element
   loop: `label[for]` → element, compared via `l.htmlFor === el.id`. No selector
   string is built from page data at all, which removes defect 1 by construction
   rather than by escaping (and is O(1) per element instead of a DOM query).
4. wrapping `el.closest('label')` text
5. **direct child text nodes only** (`nodeType === 3`) — this is the fix for the card
   case: a wrapper has none, so it falls through instead of swallowing the card
6. own `title` attribute — for card links this is usually the real title
7. best-labelled descendant: `el.querySelector('[aria-label], [title], img[alt], h1, h2, h3, h4')`
8. `placeholder`
9. `value` — **only when `isSecret(el)` is false**
10. last resort: full `innerText`, normalized to one line. Kept so a label is never
    empty when there IS text; it is now the last thing tried, not the third.

**Secret handling, two helpers in `pageSnapshot` scope:**

```js
function fieldType(el) {
  // el.type reflects the IDL attribute: lowercase, defaults to 'text', and --
  // unlike getAttribute('type') -- follows a type set from script.
  return String((el.tagName === 'INPUT' ? el.type : el.getAttribute('type')) || '').toLowerCase();
}
function isSecret(el) {
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  if (fieldType(el) === 'password') return true;
  const hint = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id].join(' ').toLowerCase();
  return /pass(wd|word)?|passcode|\botp\b|one-?time|\bcvv\b|\bcvc\b|security-?code|secret|token|\bpin\b/.test(hint);
}
```

**Deliberate asymmetry, document it in the source:** the broad `isSecret` heuristic
gates *reads* (redaction) only. Over-redacting costs nothing — the field is still
reported so the agent knows it exists. `_br.fill`'s *refusal* stays at
`fieldType(el) === 'password'`, because over-refusing a write breaks legitimate
form-filling. `pagePrepareFill` still gets the `el.type` fix so a script-set
password type is caught.

**Regression check before committing** (existing assertions that must still hold):
- `test-real-chrome.js`: `#name` label `'Your name'` (step 3), `#go` `'Submit name'`
  and `#docs` `'go to page two'` (step 5), `#pw` `redacted === true` /
  `value === undefined`, and no `hunter2` anywhere in the snapshot payload.
- `test-extension.js` uses canned inject results, so it is unaffected by the injected
  functions changing — real-Chrome is the only thing that covers them.

**New fixture coverage to add in `test-real-chrome.js`:** a card `<a title="…">`
wrapping metric noise (asserts step 5→6, the actual bilibili symptom); an element
with a hostile id like `a"] , input` (asserts the snapshot survives defect 1); an
input whose type is set from script to `password` (asserts defect 2).
