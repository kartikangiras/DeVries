# Third-party notices for the DeVries UI

The UI in this directory is DeVries's own code. Its look and its structure are not original:
they follow two other projects, on purpose. This file says what was taken from each, under what
terms, and what was changed.

## Manthan (the whole interface)

- Project: Manthan, <https://github.com/akash-mondal/manthan> (site: <https://www.manthan.quest/>)
- Copyright 2026 Manthan Engineering
- Licence: Apache License, Version 2.0. A copy is in [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt).
  The Manthan repository has no NOTICE file.

DeVries's interface is adapted from Manthan's `manthan-ui`: its "Operations Memo" design system, the
structure of its app, and its landing page. Read for this were `manthan-ui/.impeccable.md`,
`src/globals.css`, `src/components/app/AppShell.tsx`, `src/components/ui/{Page,Button,Badge}.tsx`,
`src/components/app/workspace/atoms.tsx`, `src/pages/Inbox.tsx`, `src/pages/drafts/WorkspaceMemo.tsx`,
`src/pages/Approvals.tsx`, `src/pages/Audit.tsx`, `src/pages/Landing.tsx`,
`src/components/landing/LandingHeroDemo.tsx`, `src/components/marketing/HowItWorksScenes.tsx`, the
product screens shown on the site, and the landing page at <https://www.manthan.quest/>.

What was taken:

- **Design tokens** (`src/styles/tokens.css`): the warm-tinted dark surfaces, rules and ink tiers,
  the single accent, amber reserved for "waiting for a person", the danger and info colours, the
  radii and the two easings, as OKLCH values; the base element rules; the eyebrow label, the
  footnote marker and the hairline rule.
- **Type**: Geist for text, Geist Mono for ids, figures and times, a serif italic for the editorial
  voice.
- **Structure and measurements** (`src/styles/app.css`, `src/Shell.tsx`, `src/pages/*`, `src/ui.tsx`,
  `src/ApprovalBar.tsx`, `src/Trace.tsx`): the sidebar shell with a workspace switch, large nav rows
  with counts and a widget at the foot, and no top bar; the page header that is a sentence in serif
  italic; the inbox as a stack of small memos (strip, headline with a "this → that" figure, footer
  with the next action); the case workspace (strip with a view toggle and a status word, brief,
  numbered actions, a rail of facts, cited evidence and policy, an approval bar docked underneath);
  the approval ledger (filter tabs, table, selection rail); the audit log grouped by day; the
  three-pane page with a list, the thing itself and what it affects.
- **The landing page** (`src/landing/*`, `src/styles/landing.css`, `src/styles/landing-parts.css`):
  the section order and the measurements of Manthan's landing page (nav, hero with an announcement
  pill, a showcase frame with a product demo that the visitor plays and nods through, a manifesto lit
  word by word on scroll, a stack card with a marquee that magnifies under the pointer, three
  verb-led steps each with an animated scene, a grid of six cards each with a small working surface,
  a pricing section, a two-card footer with a tilted badge and a watermark); the staging of the hero
  demo's phases and of the three scenes; the hover, slider, feed and chart ideas of the six cards.

What was changed:

- No Manthan source file is included. Everything is rewritten as plain CSS and React components for
  DeVries's own data; Tailwind, `motion`, `lucide` and the router are not used.
- Token names are shortened (`--color-bg` is `--bg`). The light theme is left out. `--info` is lighter.
- The accent is a desaturated iris, `oklch(0.64 0.15 285)`, where Manthan's is a desaturated emerald,
  `oklch(0.62 0.15 150)`; the chroma and the role of the colour are the same.
- The landing page is plain React and CSS: no Tailwind, `motion`, GSAP, `lucide` or router. Its
  reveals are an IntersectionObserver, its scenes are CSS transitions, and its videos (Manthan's are
  on its own CDN and not part of the repository) are replaced by a drawn background: a canvas of slow
  colour and ripples. The pricing section is a "run it" section, since DeVries has no price. All copy,
  all content of the demo and the cards, and all product logic are DeVries's.
- The display serif is Instrument Serif everywhere (Manthan's app styles name Spectral).
- Fonts are served by the app from `@fontsource` packages, not fetched from Google Fonts.
- A "case" is a finding, "drafted actions" are the changes of a plan, "policy" is the workflows a fix
  must not break, and the view toggle shows the audit trace.
- Icons, the mark, all copy and all product logic are DeVries's. Manthan's name, logo, images and
  text are not used.

## simple-icons (the marks on the landing page)

- Project: simple-icons, <https://github.com/simple-icons/simple-icons>, licence CC0-1.0.
- Used: the SVG paths and brand colours of thirty marks, in `src/landing/servers.ts`, for the marquee
  of MCP servers on the landing page. Each mark is its owner's trademark; it names a server DeVries
  can load and implies no endorsement.

## Agent Ethology (charts only)

- Site: <https://agent-ethology.vercel.app/> (pages read: `backstage.html`, `ideas.html`, `contagion.html`)

How DeVries draws a graph follows the charts on that site: a rounded panel; dots on lanes, each with
a dark ring; thin arcs between them; the region of concern shaded faintly; notes written on the chart
as sentences in a mono face; names next to their dots; pill controls above and a source note below;
a panel that reads whatever dot is clicked. The five chart colours in `src/styles/chart.css` are
close to the ones that site uses.

No code or asset was taken from it, and none was available to take: the charts in `src/graph/` are
written from scratch in SVG. The type in the charts is the app's own.

## Fonts

Bundled through `@fontsource` (5.3.0) and served by the app. All three are under the SIL Open Font
License 1.1; each package carries its licence text.

- Geist Sans: (C) 2023 Vercel, made in collaboration with basement.studio
- Geist Mono: Copyright 2024 The Geist Project Authors (<https://github.com/vercel/geist-font>)
- Instrument Serif: Copyright 2022 The Instrument Serif Project Authors (<https://github.com/Instrument/instrument-serif>)

## Earlier references, no longer used

An earlier version of this UI also drew on the Misaligned Agent Activity Survey
(<https://swarmchase.alecto.dev/>) and Envelope (<https://envelope-web-coral.vercel.app/>). Nothing
of either one's look is left. One plain device first borrowed from the survey is kept because it is
the chart's text alternative: the edges of a chart, as a table, under the chart.

## The chart libraries (revision 3, Oct 16)

The charts are drawn with these libraries, used unmodified as dependencies; none of their code is copied
into this repository.

- **React Flow** (`@xyflow/react` 12), <https://reactflow.dev/>, MIT. Draws DeVries's own chart: the
  cards, the arcs, zoom and pan. The node and edge components, the lanes and the key are DeVries's.
- **ELK** (`elkjs` 0.12, the Eclipse Layout Kernel compiled to JavaScript), <https://github.com/kieler/elkjs>,
  EPL-2.0 (or GPL-3.0-or-later; the EPL is used here). Lays the cards out in lanes, left to right.
- **FalkorDB canvas** (`@falkordb/canvas` 0.3), <https://github.com/FalkorDB/falkordb-canvas>, MIT.
  FalkorDB's own graph component, the second renderer on every chart. DeVries's node drawing on it
  (`src/graph/GraphCanvas.tsx`) is DeVries's; the layouts, the hit testing and the camera are the component's.

The lane chart that these replace was drawn by hand in SVG after Agent Ethology's charts; what survives of
that is the vocabulary of the key (hot, private, plain, gated, cut, central) and the lanes.
