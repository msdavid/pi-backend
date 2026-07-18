# src/ui — the console's owned design system

Small, dependency-free component set implementing the design language of
`docs/console.md` §4 and the design principles DP-1..DP-14 (§3). No external
component library, no CDN assets, no web fonts — system font stack and inline
SVG icons only (the `default-src 'self'` CSP of console-spec §3.4 enforces
this at runtime; tests enforce it at build time).

## Conventions (binding for anything added here)

- **Tokens only.** Every color comes from a custom property defined in
  `src/styles/tokens.css` (`--color-*`, `--status-*`); the same goes for type
  (`--font-*`), spacing (`--space-*`), and radii (`--radius-*`). Zero raw
  color values in components — `src/styles/tokens.test.ts` fails the suite on
  any hex/rgb/hsl/named color under `src/ui/`.
- **Both themes for free.** Components never know about light/dark; the theme
  swaps token values (see `src/lib/theme.ts`). New tokens must be added to
  the light `:root` block and to BOTH dark blocks, kept identical (also
  test-enforced).
- **One file trio per component:** `foo.tsx` + `foo.module.css` +
  `foo.test.tsx`. Styles via CSS Modules, composed with the `cx()` helper.
- **Every component ships with tests** covering behavior, keyboard
  interaction where relevant (DP-13), and an axe check
  (`expect(await axe(container)).toHaveNoViolations()`). Import `axe` from
  `./test-utils.js` — it also registers the matcher and RTL cleanup.
- **One phone breakpoint: 720px.** All responsive rules use
  `@media (max-width: 720px)` — the value is written literally because CSS
  cannot `var()` inside a media query (documented in
  `src/styles/tokens.css`). Do not introduce a second width;
  `test/phase4-gate/responsive-css.gate.test.ts` fails on any other
  max-width media query.
- **Motion:** state change only, never decorative.

## Components

| Component | File | Notes |
| --- | --- | --- |
| `Button` | `button.tsx` | `variant`: `primary` (accent, one per view), `secondary` (default), `destructive`. |
| `Input` | `input.tsx` | Always-labeled; `hint` (DP-6 microcopy) and `error` wire into the accessible description. |
| `Select` | `select.tsx` | Always-labeled native `<select>` for enum filters (session status, trace event type); mirrors `Input`. |
| `Table` | `table.tsx` | Generic semantic table; with `onRowActivate`, rows are keyboard-navigable (roving tabindex, arrows, Enter/Space). `empty` slot pairs with `EmptyState`. |
| `Dialog` | `dialog.tsx` | Focus-trapped modal; Escape/backdrop close, focus restore to opener. |
| `TypedConfirmDialog` | `typed-confirm-dialog.tsx` | DP-7: states consequences, requires retyping the resource name to enable the destructive button. |
| `Tabs` | `tabs.tsx` | WAI-ARIA tabs, roving tabindex, automatic activation; only the active panel renders (DP-2/DP-4). |
| `StatusChip` / `statusTone` | `status-chip.tsx` | ONE lifecycle vocabulary for all resources; maps any status string to five tones, unknowns → neutral. |
| `ToastProvider` / `useToast` | `toast.tsx` | Info/success are polite `status` and auto-dismiss; `danger` is an `alert` and stays (DP-9 builds on this — never a bare error toast). |
| `EmptyState` | `empty-state.tsx` | DP-5 teaching empty state: microcopy, create action slot, and a copyable equivalent CLI command. |
| `ErrorAlert` | `error-alert.tsx` | DP-9 failure line: message + machine `code` + `requestId` (via `src/lib/errors.ts`) and a "docs" link to the api-reference error envelope. |
| `CopyableId` | `copyable-id.tsx` | Mono, middle-truncated, one-click copies the FULL id (console.md §4: ids are first-class UI). Optional `link` render prop wraps the id in its detail-route link (console-spec §7.6) while keeping this module router-agnostic — see `src/features/linked-id.tsx`. |
| `SecretReveal` | `secret-reveal.tsx` | DP-8 show-once secret (raw API key, `whsec_` secret, worker key): copy-and-confirm behind an ack checkbox or the Copy action itself (`confirmVia`), locked reason wired via `aria-describedby` (§6.1). The caller unmounts it on `onConfirm`, dropping the mutation result — the secret's only home. |
| `JsonViewer` | `json-viewer.tsx` | Collapsed by default; payload stringified lazily on first expand (DP-2). |
| `Sparkline` | `sparkline.tsx` | Inline SVG trend line, no deps (DP-14); decorative unless given a `label`. |

Shared helpers: `cx.ts` (class joiner), `use-copy.ts` (clipboard + "Copied"
feedback), `test-utils.ts` (test-only: axe matcher + RTL cleanup).
