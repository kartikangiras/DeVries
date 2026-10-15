# Cistern — pivot plan

**Written:** 2026-10-13, revised 2026-10-15 · **Owner:** Kartik Angiras · **Status:** Revision 1 (Phases 0 and 1) is built; the model ran on Oct 13 and matched the baseline on every scenario. Revision 2 (Phases 2 to 5, below) was built on Oct 15, all of it but the deploy (2.3: the owner decided not to host it for the event), the drift watch (5.5, the first cut line) and the last design pass (3.7). Each item's row says ✔ when it is built; the item tables are otherwise as planned, so the plan can be read beside what exists. [PLAN.md](PLAN.md) describes what exists; this document says what changes next and why.

The rule for every item, from the owner's direction of Oct 13, stands: it has to show FalkorDB doing the work, or the agent deciding from the graph. Revision 2 adds a second rule from the owner's direction of Oct 15: **a stranger at a public address must understand the system from one screen, and the product must fix the real configuration, not only its graph of it, with a person reading the change before it is written.**

## Revision 3 (Oct 16): the workflow, and the charts drawn by libraries

**What the owner said.** The UI is still scattered, with fewer places and no order; the graphs are low quality and should use a library; the product should give an analysis of the problem through the graph, then a fix, then every other option; both Cistern's own graph and FalkorDB's canvas should be shown; for the custom chart, the library that gives the highest quality.

**What was read.** BloodHound Enterprise presents a finding with exposure and impact, a graph view that opens into remediation guidance, and a table view for triage ([Attack Paths](https://bloodhound.specterops.io/analyze-data/findings/attack-paths)); XM Cyber frames remediation around choke points, colour-coded on the attack graph ([brochure](https://info.xmcyber.com/hubfs/XM%20Cyber%20Company%20Brochure.pdf)); Wiz's attack-path analysis runs discovery, graph, path, prioritisation, validation, then a code-level fix with approval controls ([academy](https://www.wiz.io/academy/attack-path-analysis)); LINCHPIN attaches to each fix the paths it breaks as evidence ([repo](https://github.com/rakshit-737/linchpin)). The attack-graph literature's one agreement is that the whole graph is clutter and the path, trimmed, is the picture ([KSU](https://www.cs.ksu.edu/~xou/publications/vizsec08.pdf), [MIT LL](https://www.ll.mit.edu/r-d/publications/interactive-attack-graph-cascade-and-reachability-display)). The common shape: problem with its evidence, then the fix, then the alternatives and what-ifs, one screen each.

**Built on Oct 16.**

| # | Item | How |
| --- | --- | --- |
| 6.1 ✔ | **The finding as a workflow** | Three steps across the top of the finding page, **Problem** (brief, the path drawn, hops, an analysis of the agents against the Rule of Two, the workflows that constrain a fix, the OWASP class), **Fix** (the plan that passed, the preview with it applied, the change to the file in the bar), **Options** (every plan tested with its verdict and a preview, the what-if line, the cheapest cut as rules, the servers on the path, the rehearsal), with the run's **Trace** beside them |
| 6.2 ✔ | **The nav in four groups** | Findings (Inbox, Done), Fixes (Ledger, What if), System (Graph, Servers, Queries), Audit (Runs, Import). Servers and What if became pages of their own; Queries is a row that opens the drawer |
| 6.3 ✔ | **Two renderers on every chart** | **Cistern's chart**: React Flow (MIT) drawing cards in lanes laid out by ELK (EPL-2.0) with partitions for the lanes, labelled arcs, cut marks, rankings and communities; **FalkorDB's canvas** (`@falkordb/canvas`, MIT) on the database's own node ids, force or tree. The switch over each chart remembers the choice. The hand-drawn SVG lane chart is gone |
| 6.4 ✔ | **The overview as a sankey** | d3-sankey (BSD-3) lays out the three columns and the ribbons, ordered to cross least; a ribbon's width grows with its routes on a log scale |

**Why these libraries.** React Flow is the one node-diagram library whose default rendering looks designed and whose nodes are React components, so the cards carry Cistern's tokens; ELK is the one layout engine with partition constraints, which is what lanes are; d3-sankey is exactly the overview's shape; FalkorDB's canvas is the database's own component and the second view the owner asked for. Cytoscape was passed over for its own styling language and tool-like look; a force layout alone was passed over because the overview exists to avoid the whole-network picture.

**Not done.** Running a query live from the drawer (3.3); the verdict of applying the exported policy (5.6); the drift watch (5.5); the deploy (2.3).

## Contents

- [Revision 3 (Oct 16): the workflow, and the charts drawn by libraries](#revision-3-oct-16-the-workflow-and-the-charts-drawn-by-libraries)
- [Revision 2 (Oct 15): what the owner asked, and what was read](#revision-2-oct-15-what-the-owner-asked-and-what-was-read)
- [Phase 2: a public address](#phase-2-a-public-address)
- [Phase 3: one screen that explains the system](#phase-3-one-screen-that-explains-the-system)
- [Phase 4: fix the real configuration, with a person reading the diff](#phase-4-fix-the-real-configuration-with-a-person-reading-the-diff)
- [Phase 5: what the field expects now](#phase-5-what-the-field-expects-now)
- [Order, sizes and gates (revision 2)](#order-sizes-and-gates-revision-2)
- [Decisions needed from the owner (revision 2)](#decisions-needed-from-the-owner-revision-2)
- [What revision 2 does not do](#what-revision-2-does-not-do)
- [Sources read on Oct 15](#sources-read-on-oct-15)
- [Revision 1 (Oct 13): Phases 0 and 1, all built](#revision-1-oct-13-phases-0-and-1-all-built)

## Revision 2 (Oct 15): what the owner asked, and what was read

The owner's direction, Oct 15, in four parts:

1. **It will be hosted.** "We will probably host this on a website, so it is not feasible to just do `make app`." The landing page built that morning ends in a "Run it" section whose big line is `make app`; a visitor on a public address does not run anything. Hosting itself was still open (decision N2).
2. **The UI is scattered, and the graphs must be infographics.** "Everything is scattered everywhere. We need to fix the UI, especially the graphs we draw: high-level, concise, precise infographics that are easily understandable. The queries section feels vague and overkill."
3. **Cistern should fix things, not only find them.** "Cistern would find the vulnerabilities and fix them as well, and before the final approve and edit a human would skim through it." Today a fix is applied to Cistern's graph; the system it was imported from is untouched.
4. **Add what is useful now.** "A few more options; see on the web what is useful for us right now."

What was read for each is in [Sources](#sources-read-on-oct-15). The findings that shaped the phases:

| Question | What was found | What it changes |
| --- | --- | --- |
| Where to host | FalkorDB Cloud's free tier is 100 MB, **no persistence, no TLS**, stopped after a day idle and **deleted after seven**; the paid Startup tier is $73 a month. Railway imports a Compose file service by service (one volume per service, no `depends_on`, private hosts at `<service>.railway.internal`). A Hetzner CX23 (2 vCPU, 4 GB) is about €4 to €6 a month. `deploy/` already holds a compose overlay with Caddy for one VM, checked on the laptop. | One VM is the cheap, finished path; Railway is the zero-ops alternative; the free database tier is not fit for a judged demo. Either way the app must retry the database at startup, and a public site must not launch visitors' commands |
| How a graph of attack paths should look | The attack-path literature and the products (Wiz, XM Cyber, BloodHound, Sekoia) agree: show **only open, valid routes**; anchor nodes to the real assets; encode criticality in colour; disclose detail progressively (click a node for its context); filter to the task at hand; pair the picture with a timeline or a list. Static whole-network graphs were found unhelpful in practice | The default picture becomes one figure of sources → agents → actions with only the open paths drawn, titled by a sentence; everything else folds into counts |
| How a fix reaches a real system | **Claude Code** has per-tool permission rules in a settings file: `mcp__<server>__<tool>` names one tool, `mcp__<server>` every tool of a server; rules are evaluated **deny, then ask, then allow**, and an `ask` rule prompts the person on every call even in auto mode, which is exactly Cistern's `gate: human_approval`. A `PreToolUse` hook can return `permissionDecision: "ask"` or `"deny"` with a reason. **Cursor** has no per-tool field in `mcp.json` (servers are toggled whole; tools are asked about by default; allowlists live in an enterprise dashboard). **Claude Desktop** has only `mcpServers`: a server is on or removed. **Docker MCP Gateway** scopes tools per profile (`docker mcp profile tools <profile> --enable/--disable`) and has no approval step. Snyk Agent Scan (the former mcp-scan) finds and does not enforce; gateways enforce | A fix compiles to a concrete change per target: an `ask` or `deny` rule for Claude Code, a server removal for Desktop and Cursor, a profile command for the gateway, a unified diff for anything. The person reads and edits the diff before it is written |
| What the field expects | **OWASP Top 10 for Agentic Applications (2026)** names the classes Cistern finds: ASI01 goal hijack, ASI02 tool misuse, ASI03 identity and privilege abuse, ASI04 agentic supply chain. Scanners hash tool definitions (Cistern does), check descriptions (does), and warn that **scanning a config launches its stdio servers**, so untrusted configs belong in a sandbox. Comparisons list a report, a CI mode and a gateway export as the things buyers ask for | Badges per finding, a brief that exports, a CI exit code, static import as the default, and a gateway profile as the exported "policy that closes everything" |

## Phase 2: a public address

**What the owner said.** It will be hosted; `make app` cannot be the call to action.

**Options, with what was found.** The recommendation is **A**; **B** if the owner wants pushes to deploy themselves.

| | A · one VM with the existing overlay | B · Railway from the Compose file | C · FalkorDB Cloud free tier + an app host | D · Fly.io |
| --- | --- | --- | --- | --- |
| What runs | `docker compose -f docker-compose.yml -f deploy/docker-compose.deploy.yml up` on a Hetzner CX23 (2 vCPU, 4 GB, ~€4–6/month) or similar; Caddy does HTTPS | Two Railway services: `falkordb/falkordb:6.0.2` with one volume, and the app from the Dockerfile; app reaches `falkordb.railway.internal:6379`; Railway gives the domain and TLS | The database on FalkorDB's free tier; the app on Railway or Render | Two Fly apps with volumes, CLI-driven |
| Cost | ~€5–7/month with IPv4 | usage-based, a few dollars a month for two small always-on services | database free, app a few dollars | similar to B |
| What is already done | Everything in `deploy/`: overlay, Caddyfile, uptime check, the steps, checked through the proxy on the laptop | Nothing; the Compose guide maps cleanly | Nothing | Nothing |
| What breaks | Nothing known; a reboot ordering is handled by `restart` and 2.1c | No `depends_on`: the app must retry FalkorDB at start (2.1c); the FalkorDB Browser port goes | **No persistence, no TLS**, 100 MB, instance deleted after 7 idle days; the password crosses the internet in clear | More moving parts than B for the same result |
| Verdict | **Do this.** Thirty minutes once the owner has an account and a host name | The alternative if git-push deploys matter more than the Browser and the €5 | **No** for a judged demo | No reason over B |

**Items.**

| # | Item | Why | Where | How | Size |
| --- | --- | --- | --- | --- | --- |
| 2.1 ✔ | **Hosted mode.** One setting, `CISTERN_PUBLIC=true`, set by the overlay | A public site is not the laptop: visitors must not run commands on it, and must not be able to exhaust it | `cistern/config.py`, `cistern/api/routes.py`, `cistern/ingest/`, `cistern/app.py` | (a) The import endpoint refuses stdio commands and client-config launches; it accepts a pasted config whose servers have a `url`, fetches `tools/list` over HTTPS with a 10 s timeout and a 1 MB cap, or a pasted `tools/list`. (b) A per-IP limit on imports and runs (a token bucket in the session middleware; FalkorDB keeps the counters so a restart does not reset them). (c) **Retry the database at startup**: the lifespan today logs "not reachable" and starts empty; make it retry for 60 s, then keep trying from the janitor, and refuse scans with a clear 503 until it is up. (d) Visitor copies evicted by FalkorDB memory as well as by age: read `INFO memory` in the janitor and drop the oldest copies past a ceiling | M |
| 2.2 ✔ | **The landing page for a hosted product.** The "Run it" section says `make app` | A visitor clicks; the owner runs | `ui/src/landing/Landing.tsx` (`RunIt`, `Footer`) | "Run it" becomes **"Try it"**: the big line is the sentence "Open the app. Four scenarios are loaded.", the accent button opens the app, and a second button, **Paste your config** (lands with 2.1a), opens the import. `make app` stays as one quiet line, "or run it yourself", linking to the README. The footer's copy box shows the public `/mcp` address with "needs a token; self-host for your own", not `make app`. The hero's demo and copy do not change | S |
| 2.3 ✘ not done | **The deploy.** Nothing has run on a server | The address is what is submitted | `deploy/README.md` (the steps), the owner's host and DNS | Follow the steps once; set the four secrets; `make seed` on the server; run `deploy/uptime-check.sh` from a GitHub Actions cron every 15 minutes with a notification on failure; a note in the README with the address. Measure memory with 30 visitor copies before raising `SESSION_MAX` | S, plus the owner's account |
| 2.4 ✔ | **Pre-run audits.** The shared scenarios arrive scanned but untested | The first screen of a stranger should show tested plans, not a button | `cistern/app.py` (`seed_missing`) | After seeding, run the scripted audit to the proposal on each shared scenario (no model spend) and leave the plans in the ledger as "awaiting nod"; a visitor's own run still works on their copy | S |
| 2.5 ✔ | **Spend and health in one place.** The daily ceiling exists; nothing reports it | The owner needs to see what the public site costs | `/api/health`, `cistern/agent/spend.py` | `/api/health` already reports spend and sessions; add a one-line log per run with cost, and the uptime check prints both | S |

**Gate.** The uptime check is green from outside for a day; a person who has never seen Cistern opens the address, reads the support desk, runs an audit on their copy and approves a plan; the landing page's first action is "Open the app"; `make e2e` passes against the public address.

## Phase 3: one screen that explains the system

**What the owner said.** Scattered; the graphs must be high-level, concise, precise infographics; the queries page is vague and overkill.

**What was read.** Attack-path products show only the open routes, anchored to real assets, criticality in colour, detail on click, filtered to the task; whole-network pictures fail in practice. Cistern's Graph page today draws every node on five lanes with four pills, a servers table and an edges table under it, and the nav has six places.

**Items.**

| # | Item | Why | Where | How | Size |
| --- | --- | --- | --- | --- | --- |
| 3.1 ✔ | **The one picture.** A per-scenario infographic that answers "what can reach what, and what is open" | The lane chart shows everything; the literature and the owner want only what matters | `ui/src/graph/` (a new `Overview.tsx` beside `FlowChart.tsx`), one catalog query `overview.summary` | Three columns, **untrusted sources → agents → high-impact or external actions**, with only the **open paths** drawn as ribbons whose width is the number of routes (`evidence.pair_count`); each agent carries its Rule of Two badges; a counts strip above (sources, agents, actions, open findings, cheapest fix cost from `maxFlow`); a **sentence as the title**, generated from the graph ("Two untrusted sources reach one high-impact resource through one agent, in four hops"); internal sources, read-only tools and low-impact resources fold into counts that expand on click. It is the Graph page's default; the lane chart becomes "All nodes" | M |
| 3.2 ✔ | **Three places, not six.** Inbox, Done, Fixes, Graph, Audit, Queries | Scattered | `ui/src/Shell.tsx`, `App.tsx`, `route.ts`, pages | **Inbox** (open and done as tabs, the scorecard under it), **Graph** (3.1 by default; Communities, Most central, Cheapest cut, Servers and the edges table in one "More" drawer), **Audit** (runs, with the Fixes ledger as a tab). The finding page stays. The routes keep their names so links in the README and the e2e tests survive; `fixes` and `queries` redirect | M |
| 3.3 ✔ (no "run it") | **Queries on demand.** The Queries page lists 76 statements | Overkill for a visitor; essential for a judge who asks "is this really the database" | `ui/src/pages/Queries.tsx`, the chart notes, `FindingPage.tsx` | Every chart note and every finding keeps its "which query" links; they open a **drawer** with the Cypher, its one-line gloss and a "run it" that shows the live result on this scenario. The page leaves the nav; the catalogue stays at `docs/QUERIES.md` and `/api/queries` | S |
| 3.4 ✔ | **The finding page as the brief.** | It is the page that is shared | `FindingPage.tsx` | Keep the brief and the path chart; fold the hop table under the chart into a disclosure; add the OWASP badge from 5.1; the approval bar stays docked | S |
| 3.5 ✔ | **One finding as a picture to share.** | The video, the README and a reviewer need a still | `ui/src/graph/Overview.tsx`, a route `GET …/findings/{id}/figure.svg` | The ribbon figure cut to one finding, rendered server-side from the same data so it can be fetched without a browser | S |
| 3.6 ✔ | **One vocabulary.** The landing page says source · agent · action; the app says data source, tool that reads, agent, tool that acts, resource | The landing and the app must read as one product | the copy in both | The app's overview uses the landing's three words, with the five-lane names kept for "All nodes" | S |
| 3.7 ◐ one pass | **The design pass.** | The owner's standing rule: one reference, followed whole, judged in screenshots beside it | all UI | Screenshots of each app page beside Manthan's inbox, workspace, ledger and audit; fix spacing, type and density until they match; the e2e screenshots are the record | M |

**Gate.** A person who has not seen the README explains the support desk's problem from the overview alone, in one sentence; the nav has three places; `make e2e` updated and green; PLAN.md section 13 updated.

## Phase 4: fix the real configuration, with a person reading the diff

**What the owner said.** Cistern finds the vulnerabilities and fixes them; before the final approve a human skims and can edit.

**What exists.** A fix is a change to Cistern's graph, tested in a sandbox copy and applied on approval. The system the scenario was imported from (a Claude Desktop or Cursor config, a Claude Code project, a gateway) is never touched; the person reads the plan and makes the change by hand.

**What was read.** Claude Code is the one client whose config can express every fix Cistern proposes per tool: `permissions.ask` is a gate, `permissions.deny` is a revoke, `mcp__<server>` denies a whole server, and the rules are evaluated deny → ask → allow, so an `ask` rule prompts a person on every call whatever else is allowed. Cursor and Claude Desktop can only remove a server (Cursor asks before every MCP tool by default, which is a gate on everything; per-tool allowlists are an enterprise dashboard setting). Docker MCP Gateway scopes tools per profile with a command and has no approval step. The scanners stop at a report; what enforces is a settings file or a gateway. That is the gap Cistern fills: a tested fix, written as the enforcing change, after a person has read it.

**Items.**

| # | Item | Why | Where | How | Size |
| --- | --- | --- | --- | --- | --- |
| 4.1 ✔ | **Remember the origin.** An import records the command or URL per server, not the client file | A change needs a file to go to | `cistern/ingest/`, the scenario YAML, the `MCPServer` and a new `Origin` node | `origin: {kind: claude-code \| claude-desktop \| cursor \| docker-mcp-gateway \| tools-list, path, hash}` on the scenario, written at import; the hash is of the file as read, so a later write can refuse if the file moved on | S |
| 4.2 ✔ all four targets, and the scenario file | **The change compiler.** A mitigation's `fix_json` is graph language | The person wants the real change | `cistern/mitigation/compile.py` (new), `cistern/graph/catalog.py` (`draft.record`) | One function per origin kind, from the five fixes and `drop_server` to a **Draft**: `{path, before, after, diff, note}`. **Claude Code:** `gate` → add `mcp__<server>__<tool>` to `permissions.ask`; `revoke` → `permissions.deny`; `drop_server` → `mcp__<server>` in `deny`; `quarantine` and `split` have no rule form → a `PreToolUse` hook template that returns `permissionDecision: "ask"` with the reason, plus a note that the split is a design change. **Claude Desktop and Cursor:** `drop_server` and `revoke` → the server removed from `mcpServers` (Cursor: whole server; the note says tools cannot be removed singly in the file); `gate` → "keep the client's approval on; do not allowlist this tool" with the dashboard pointer. **Docker MCP Gateway:** `revoke` → `docker mcp profile tools <profile> --disable <server>.<tool>`; `drop_server` → `profile server remove`; `gate` → the gateway has no approval step, so the deny is emitted and the note says so. **Any origin:** a unified diff and a Markdown brief. The Draft is a node linked to the Mitigation, so FalkorDB holds the verdict and the change together | M; Claude Code first, then Desktop and Cursor, then the gateway |
| 4.3 ✔ (writing is a tick, off by default) | **The review step.** The approval bar approves a plan | The owner wants the person to skim and edit before it is written | `ui/src/ApprovalBar.tsx`, `FindingPage.tsx`, `cistern/api/routes.py` | The bar grows a panel, **Change to your config**: the file path, the diff in an editable text area, and beside it "what this does", which is the sandbox verdict in a sentence. **Approve · Apply** does three things in order: writes the file (a `<file>.cistern.bak` first, then an atomic replace), re-imports from it, rescans, and records a **receipt** on the Draft (hash before and after, who, when). If the rescan still shows the finding, the receipt says so and the finding stays open. **Reject** keeps the draft with the reason. An edited diff is applied as edited; the re-import is what proves it | M |
| 4.4 ✔ | **Audit on arrival.** An import lands as unlabelled nodes and a "Run audit" button | The owner wants Cistern to find and fix, not wait | `cistern/ingest/`, `cistern/agent/loop.py` | After an import and after each label save, the audit runs by itself on the person's scenario: scan, test every candidate in a sandbox, compile the drafts; with a model configured and budget left, the model run; otherwise scripted. The first screen after labelling is "N findings, M fixes drafted; read them". Nothing is written: that is 4.3's click | S |
| 4.5 ✔ | **What a write may touch.** | A tool that edits a person's config is a risk of its own | `compile.py`, the write path | Only the file the origin names; `env` values and secrets copied byte for byte and never shown in the diff; refuse to write if the file's hash differs from the import's (4.1) and offer a re-import; **hosted mode (2.1) never writes**: it offers the diff to download or copy. `apply_fix` the MCP tool applies to the graph only, as now; a file is written by a person's click, or by `python -m cistern.apply --draft <id> --yes` typed by a person. No tool can approve, still | S |
| 4.6 ✔ Claude Code, Desktop and the scenario file, in tests | **Close the loop.** | A gate written to the file must come back as a gate in the graph, or the finding cannot close honestly | `cistern/ingest/` (a reader for `.claude/settings.json` permissions), tests | The Claude Code reader turns `permissions.ask` rules into `CAN_CALL {gate: human_approval}` and `deny` rules into absent grants, so a re-import of a fixed project shows the finding closed by the same queries. A test per origin: fixture config → import → gate → written file contains the rule → re-import → closed. On the laptop: a gate written to a real project's `.claude/settings.json` makes Claude Code prompt on that tool | M |

**Gate.** On the laptop: import a Claude Code project with the filesystem server beside `fetch`, label it, watch the audit draft the `ask` rule, read and edit the diff, approve, see the file change and the finding close on re-import, and see Claude Code prompt for the tool. The receipt is in the graph and in the ledger.

## Phase 5: what the field expects now

Small items, each from something read on Oct 15, each a query, a route or a badge.

| # | Item | From | How | Size |
| --- | --- | --- | --- | --- |
| 5.1 ✔ | **OWASP badges.** Each finding names its class in the OWASP Top 10 for Agentic Applications: injection → ASI01 goal hijack and ASI02 tool misuse; trifecta → ASI02 and ASI03 identity and privilege abuse; drift and poisoned description → ASI04 agentic supply chain | the OWASP list that security teams recognise | A `taxonomy` field on the finding view, a badge on the inbox row and the brief, one line per code in the README | S |
| 5.2 ✔ | **The brief exports.** | reviewers forward a document, not a URL | `GET …/findings/{id}/brief.md` with the paragraph, the evidence, the plans and verdicts, the draft diff (4.2) and the figure (3.5); a "Download" on the finding page | S |
| 5.3 ✔ | **A CI gate.** | a config lives in a repository; scanners offer a CI mode | `python -m cistern.ingest --import <config> --labels <file> --fail-on open` exits 1 with the findings on stdout; a GitHub Actions example in `deploy/ci.yml`; needs no public site | S |
| 5.4 ✔ | **Static import by default.** | the scanners warn that scanning a config launches its stdio servers | The import prefers a pasted or saved `tools/list` and HTTPS `tools/list`; launching a command is a second step that names the command and asks; the hosted site never launches (2.1a) | S |
| 5.5 ✘ cut | **Watch for drift.** | scanners hash definitions and re-check | A timer that re-reads an origin and reopens drift findings; `cistern watch <scenario> --every 1h`. Cut line | S |
| 5.6 ✔ (without the verdict of applying it) | **Export the policy that closes everything.** | gateways enforce; `maxFlow` already finds the cheapest cut | A Docker MCP Gateway profile (the `docker mcp profile tools` commands) and a Claude Code `permissions` block generated from the min cut, downloadable from the Graph page's Cheapest cut view, with the sandbox verdict of applying it | S |

## Order, sizes and gates (revision 2)

The event ends **Oct 18, 11:59 PM IST**; today is Oct 15. The first column is what should be done before that, in order; the rest follows.

| Step | Items | Size | Before Oct 18 | Gate |
| --- | --- | --- | --- | --- |
| Phase 2 | 2.1c, 2.3, 2.2, 2.4, 2.1a, 2.1b, 2.5, 2.1d | one day plus the owner's host | **Yes, first.** Without an address there is nothing to submit | uptime green from outside for a day; a stranger runs an audit on their copy; the landing says "Open the app" |
| Phase 3 | 3.1, 3.2, 3.3, 3.6, 3.4, 3.7, 3.5 | two days | 3.1, 3.2, 3.3 and 3.6 yes; 3.7 as far as time allows; 3.5 after | a newcomer explains the support desk from the overview alone; three nav places; e2e green |
| Phase 4 | 4.1, 4.2 (Claude Code only), 4.3, 4.5, 4.6 (Claude Code only), 4.4, then Desktop and Cursor, then the gateway | two to three days | 4.1 to 4.3 and 4.5 for Claude Code yes, because it is the one demo beat no scanner has; the rest after | the laptop round trip in the gate above |
| Phase 5 | 5.1, 5.3, 5.4, 5.2, 5.6, 5.5 | one day | 5.1 and 5.4 yes (an hour each); the rest after | each a route or a badge with a test |

Cut lines, in order, if time runs short: 5.5, 5.6, 3.5, 4.2's gateway target, 4.4, 2.4, 3.7's last pass. Never cut 2.1a, 2.1c, 2.3, 3.1, 3.2 or 4.3: they are the hosting, the one picture, and the person reading the change.

Every item keeps the three obligations: a catalog query (no Cypher outside `catalog.py`), a test, and a line in the generated query list. Every item in Phase 4 keeps a fourth: nothing is written to a person's file by anything but a person's click or a command they typed.

## Decisions needed from the owner (revision 2)

| # | Decision | Recommendation |
| --- | --- | --- |
| N2 | Where to host, and the host name. **Decided Oct 15: not hosted for the event** | One VM (Hetzner CX23 or the equivalent) with the overlay in `deploy/`, because it is written and checked; Railway if git-push deploys matter more. Not FalkorDB Cloud's free tier: no persistence, no TLS, deleted after seven idle days |
| P5 | Whether the public site accepts imports at all. **Built as recommended** | Yes, static only (pasted config with `url` servers, pasted `tools/list`); never a command. It is the "scan my setup" beat, and 2.1 makes it safe |
| P6 | Which client gets the real-config fix first. **Built: Claude Code first, then Desktop, Cursor, VS Code, the gateway, and the scenario file itself** | Claude Code: the only client whose file can say "ask a person before this one tool", which is Cistern's gate word for word |
| P7 | The model on the public site | Yes, with `LLM_DAILY_BUDGET_USD=5` and three runs per visitor, as the overlay sets; past the ceiling every run is scripted and says so |
| P8 | Whether the Queries page goes entirely or survives as a hidden route. **Built as recommended** | Hidden route plus the drawer; a judge who asks "is this really the database" gets the catalogue in one click, a visitor never sees it |
| P9 | The three names in the nav. **Built: Inbox, Graph, Audit** | Inbox, Graph, Audit |

## What revision 2 does not do

- It does not add a runtime guard. FIDES, CaMeL and the gateways act while the agent runs; Cistern acts on the design, and now writes the design's fix into the file the runtime reads. The README says so.
- It does not add accounts or persistence per visitor beyond the hour a copy lives. The public site is a demo of the product on four scenarios and on a config a visitor pastes.
- It does not reopen the colour, the fonts or the reference. The landing page and the app follow Manthan's system, in iris; Phase 3 brings the app's pages closer to it, not further.
- It does not change the taint rules or the verdict queries. A Draft is a new record beside a Mitigation; what counts as closed is unchanged, and now proved twice: in the sandbox and on re-import.

## Sources read on Oct 15

Hosting: [FalkorDB Cloud free tier](https://docs.falkordb.com/cloud/tiers/free) and [plans](https://www.falkordb.com/plans/) · [Railway: Docker Compose](https://docs.railway.com/guides/docker-compose) · [Railway vs Render vs Fly.io, 2026](https://devtoolpicks.com/blog/railway-vs-render-vs-fly-io-solo-developers-2026) · [Hetzner CX23 pricing](https://costgoat.com/pricing/hetzner) and [plans](https://www.bitdoze.com/md/hetzner-cloud-cost-optimized-plans.md).

Graphs: [Attack path visualization](https://www.deepwatch.com/glossary/attack-path-visualization/) · [Sekoia: attack path visualization](https://docs.sekoia.io/xdr/features/investigate/attack_path_visualization/) · [Improving attack graph visualization (VizSec)](https://www.cs.ksu.edu/~xou/publications/vizsec08.pdf) · [an AWS attack-path visualizer, with a survey of Wiz, XM Cyber and BloodHound](https://haitmg.pl/blog/blast-audit-aws-attack-path-visualizer/).

Fixing the real system: [Claude Code: configure permissions](https://code.claude.com/docs/en/permissions) (rule syntax, deny → ask → allow) · [Claude Code: hooks](https://code.claude.com/docs/en/hooks) (`PreToolUse`, `permissionDecision`) · [Claude Code: settings files](https://code.claude.com/docs/en/settings) · [Cursor: MCP](https://cursor.com/docs/context/mcp) · [Docker MCP Gateway](https://github.com/docker/mcp-gateway) · [Top MCP gateways, 2026](https://www.getmaxim.ai/articles/top-5-mcp-gateways-for-securing-agent-tool-access-in-2026/) · [agentgateway and ToolHive in production](https://mehdihadeli.com/blog/mcp-gateway-authentication-agentgateway).

The field: [Snyk Agent Scan](https://github.com/snyk/agent-scan) · [MCP security tools, 2026](https://www.getmaxim.ai/articles/best-mcp-security-tools-in-2026/) · [MCP-Scan vs Docker MCP Gateway](https://ailearningguides.com/mcp-scan-vs-docker-mcp-gateway-2026/) · [OWASP Top 10 for Agentic Applications, 2026](https://protectt.ai/blog/owasp-top-10-agentic-applications-2026) and [a second summary](https://goteleport.com/blog/owasp-top-10-agentic-applications).

## Revision 1 (Oct 13): Phases 0 and 1, all built

Kept as written. Everything below this line was built on Oct 13.

### Contents of revision 1

- [What the closest projects do](#what-the-closest-projects-do)
- [Phase 0: make the existing code show its work](#phase-0-make-the-existing-code-show-its-work)
- [Phase 1: inputs and references](#phase-1-inputs-and-references)
- [Order, sizes and gates](#order-sizes-and-gates)
- [Decisions needed from the owner](#decisions-needed-from-the-owner)
- [What this plan does not do](#what-this-plan-does-not-do)

### What the closest projects do

Read on Oct 13. None of them has what Cistern has at its centre: a graph of grants with reachability verdicts, fixes proposed from the graph and proved in a sandbox copy before a person approves. What each has that Cistern lacks is in the last column, and Phase 1 is built from that column.

| Project | What it is | How it models the system | What it has that Cistern lacks |
| --- | --- | --- | --- |
| [Invariant toxic flow analysis](https://invariantlabs.ai/blog/toxic-flow-analysis), now Snyk Agent Scan | A scanner of installed MCP servers (`mcp-scan`) that reports "toxic flows": tool sequences that end in a security violation, the lethal trifecta first | A flow graph of possible tool sequences; nodes are tools with trust, sensitivity and sink properties; static config plus runtime traces | **Reads a real install** (Claude Desktop, Cursor) instead of a scenario file. It found the [GitHub MCP exfiltration](https://invariantlabs.ai/blog/mcp-github-vulnerability) that way |
| [Meta, Agents Rule of Two](https://simonw.substack.com/p/new-prompt-injection-papers-agents) | A design rule: an agent holds at most two of **A** untrustworthy input, **B** private data or sensitive systems, **C** state change or external communication, per session; all three means no autonomy | Three properties per agent, a Venn diagram | **A per-agent scorecard** people already recognise. Cistern computes the trifecta (A+B+external C) and the injection (A+C, which Willison notes the rule marks "safe" and is not) but never shows the three properties side by side |
| [FIDES](https://arxiv.org/pdf/2505.23643) (Microsoft) and CaMeL | Runtime information-flow control: integrity and confidentiality labels travel with content through tool calls and a policy is enforced before a sensitive tool runs | Labels on values at runtime | Nothing for the design-time question Cistern asks; it confirms the model (trust and privacy as labels that propagate, quarantine as declassification). Cited in the README as the runtime counterpart |
| MCP scanners: [comparison](https://www.agenticwire.news/article/mcp-security-scanners-comparison), [Trivial Trojans](https://arxiv.org/abs/2507.19880) | `mcp-scan`, MCPhound, MCPShield, Cisco's scanner: check tool descriptions for injected instructions, hash tool definitions between scans to catch a "rug pull", map chains across servers | Lists of tools per server; MCPhound a directed graph of reachable servers | **Drift detection** (a tool whose definition changed since it was approved), **description poisoning checks**, and a **per-server** view of what each server contributes |
| [Promptfoo trifecta testing](https://www.promptfoo.dev/blog/lethal-trifecta-testing/) | Red-teaming: feed injected content to a running agent and check for exfiltration | Dynamic; no graph | A **concrete payload**: the text an attacker would plant. Cistern shows the path and never the text that would ride it |
| The hackathon's own [resources page](https://www.wemakedevs.org/hackathons/falkordb) | Lists the algorithms it wants to see used as agent tools: shortest path, PageRank, centrality, connected components, community detection | | Cistern uses BFS, shortest paths, WCC, betweenness and max flow. **PageRank and community detection** are the two on the list it does not use |

### Phase 0: make the existing code show its work

What is built already computes more than it shows, and the scripted run (the only kind that has ever run) calls four tools where the server offers ten. Each item below is small, touches code that exists, and is done before any of Phase 1.

| # | Item | Why | Where | How | Size |
| --- | --- | --- | --- | --- | --- |
| 0.1 ✔ | **Show betweenness.** `choke.betweenness` runs for `rank_chokepoints(method="betweenness")` and reaches no page | An algorithm the hackathon lists, computed and invisible | `ui/src/pages/GraphPage.tsx`, `cistern/api/routes.py` | A fourth choice beside Everything, Blast zones and Cheapest cut: **Most central**, ringing the five nodes `choke.betweenness` returns, with a note that it is context and feeds no verdict. `GET …/central` | S |
| 0.2 ✔ | **The scripted run uses the graph tools.** It calls `scan`, `find_injection_paths`, `choose_targets`, `baseline_search`, `propose_fix`; never `rank_chokepoints` or `trust_zones` | Without a key the trace is the whole demo of "algorithms as tools", and it shows two of them | `cistern/agent/loop.py` (`_audit`, scripted branch), `cistern/agent/scripted.py` | In Investigate, call `trust_zones` and `rank_chokepoints(method="mincut")` with a `because` each, and let the scripted report quote the cut cost beside the plan's cost ("the cheapest cut costs 1; the plan that passed costs 2, because the cut's revoke breaks the refund workflow") | S |
| 0.3 ✔ | **The ask box answers without a model.** Today it is shut with a note | A dead surface in the demo, and the questions a person asks first are graph questions | `cistern/agent/loop.py` (`_ask`), `cistern/agent/scripted.py`, `ui/src/pages/Audit.tsx` | A small grammar of four questions, matched by pattern, each answered by a catalog query and a template that cites ids: "what can reach `<resource>`" (`algo.bfs` backwards: a new `reach.into`), "what does `<agent>` reach", "is there a path from `<source>` to `<resource>`" (`evidence.pair_paths`), "which workflows need `<tool>`". Anything else: the current note. The box offers the four as examples; the trace shows the query | M |
| 0.4 ✔ | **Say how many paths a finding has.** The scan keeps up to three evidence paths; the page shows "Path 1, Path 2" and nothing about the rest | Completeness is the graph's claim; the page hides it | `cistern/analysis/findings.py`, `cistern/views.py`, `ui/src/pages/FindingPage.tsx` | `evidence.pair_count`: `algo.SPpaths` with `pathCount: 50` and the count only; the brief says "3 of 11 routes shown" (or "50 or more") | S |
| 0.5 ✔ | **Remove `fixes_later`.** Every designed fix is built, so the field is always empty | Residue; it tells a reader there is something unbuilt | `cistern/views.py`, `cistern/api/routes.py`, `ui/src/api.ts`, `FindingPage.tsx`, the API test | Delete it | S |
| 0.6 ✔ | **Honest zones.** "Blast zones · 12" on a 12-node graph says nothing | The pill reads as a feature and is a tautology on three of four scenarios | `GraphPage.tsx` | When there is one zone: "One zone: everything here can affect everything else". Replaced by 1.5 if that lands; done first because it is ten minutes | S |
| 0.7 ✔ | **With a key, the model.** Q17 in PLAN.md: ten audit runs per scenario reading `stop_reason`, `usage` and the proposals; `make agent-eval`; then fix the prompt, the tool descriptions and the budgets from what the runs show | The agent has never run. Everything in Phase 1 that says "the agent" rests on this | `cistern/agent/prompts.py`, `llm.py`, `phases.py` | The first job the day the key arrives, before any Phase 1 item that needs the model | M, blocked on the key |

**Phase 0 gate:** `make e2e` passes with the four new surfaces (central nodes, the scripted trace with six tools, a canned question answered, the path count); PLAN.md section 13 and the README tour updated; with a key, the agent-versus-baseline table in the README filled in. **Met on Oct 13 except the key.** What 0.3 turned out to need: the four questions are answered by three new catalog queries (`reach.into`, `reach.from`, `wf.needing`) and the existing `evidence.pair_paths`; the trace shows each as a step with the query named, and the answer says it was worked out by the query and not by a model.

### Phase 1: inputs and references

Ordered by value for the demo over cost. Each names the project it is taken from, the FalkorDB work it adds, and what the agent does with it.

#### 1.1 Import a real install (from Invariant / mcp-scan) ✔

**What.** Cistern takes its tool graph from scenario files. It should also take it from the systems people actually run. One command, `python -m cistern.ingest --import`, with several **inputs**:

| Input | How it is read | Example |
| --- | --- | --- |
| A Claude Desktop config | `claude_desktop_config.json`: each `mcpServers` entry is launched over stdio with the MCP SDK client (a 20 s timeout per server), `tools/list` is called, and the result is saved as `manifests/<server>.tools.json` with the command it came from | `--import claude-desktop` |
| A Cursor or VS Code config | The same, from `.cursor/mcp.json` or the editor's settings | `--import cursor` |
| One stdio command | Launched the same way | `--import "npx -y @modelcontextprotocol/server-filesystem /tmp"` |
| A streamable-HTTP server | `tools/list` over HTTP, with an optional bearer token from the environment | `--import https://host/mcp` |
| A saved `tools/list` result | Read as a manifest, which is what `manifests/` holds today | `--import path/to/tools.json` |

From the manifests it writes a **draft scenario**, `scenarios/<name>.yaml`, and loads it:

- one agent for the client that holds every tool (`agent:claude-desktop`), because that is what a desktop client is: one agent with every grant, which is the state Meta's rule says not to run unattended;
- one `MCPServer` per server, with the command or URL as its `source_url` and `synthetic: false`;
- each tool's `capability` from its annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`), as the loader does now;
- one data source per server that any tool reads (`src:<server>`), one resource per server that any tool acts on (`res:<server>`), both **unlabelled**: `trust: unknown`, `impact: unknown`, which is a new allowed value that yields no finding and a warning: "nothing here is a finding until you say what is untrusted and what matters".

**Labelling.** The person labels in the UI: a **Label this install** page lists each server with its tools and asks two questions per server (does anyone outside the organisation write what these tools read? how much does what they act on matter, and does it leave the organisation?). Guesses are offered from names (`github`, `fetch`, `brave-search` → untrusted; `filesystem`, `postgres` → private; `fetch`, `slack`, `gmail` → external) and are only guesses until clicked. Saving rewrites the YAML and reloads the graph, and the ordinary scan runs: the person then sees their own install's findings, and the auditor can be run on them.

**FalkorDB.** A graph from a live system, scanned by the same queries; the import is the first time the graph is of something that exists.

**The agent.** It audits the person's own setup. The demo beat "scan my Claude Desktop" is the one Invariant used to find the GitHub MCP exploit.

**Risks and choices.** Launching a server runs it with the person's own environment and credentials, and the command says so before it does. A server that fails to start is reported and skipped. The demo machine has no Claude Desktop; the demo imports Cistern's own server (already a scenario) plus one public reference server, which needs a decision (below). Size **M**. Tests: a fake stdio server in `tests/` with three tools and annotations; the draft it produces; the labelling round-trip; a server that hangs.

#### 1.2 Rule of Two scorecard (from Meta) ✔

**What.** For each agent, three badges: **A** untrusted input reaches it, **B** private data reaches it, **C** it can change state or communicate externally (it reaches any resource; "external" marked separately). One query, `agent.rule_of_two`: `algo.bfs` from every untrusted source and every private source, and from each agent over rules 3 and 5, in one statement that returns one row per agent with three booleans and the workflows the agent runs with their modes.

**Where it shows.** A table on the Inbox's "This scenario" block (agent, A, B, C, autonomous?) and on an agent's read panel on the Graph page. An agent with all three that runs an autonomous workflow is the first row, in red, with the sentence Meta uses: it "should not be permitted to operate autonomously". The brief of a trifecta finding gains one line: "This is Meta's Rule of Two broken: all three".

**FalkorDB.** Three BFS passes per scenario, in the database, cached on the scan record. **The agent.** `rule_of_two` becomes the eleventh MCP tool, offered in Investigate, so the model can read a scorecard before it picks a target. Size **S**. Tests: a unit test per badge; the golden expectation per scenario.

#### 1.3 Manifest drift (from the scanners' rug-pull check) ✔

**What.** Each `MCPServer` node carries `manifest_hash`, the SHA-256 of the canonical JSON of its tools (name, description, input schema, annotations), set at load. A reload or a re-import compares the new hash with the one stored in the graph before the graph is replaced; a changed hash opens a finding of a new kind, **`drift`**, naming each tool whose definition changed and what changed (description, schema, annotations, added, removed). The finding closes only when a person **accepts** it, which is the existing `accepted` status. The point is the one every scanner makes: a tool approved last week is not the tool running today.

**FalkorDB.** The hash and the finding live in the graph with the others, so the finding history is the graph's. **The agent.** A drift finding on a tool that sits on an open path is reported first; the scripted order puts it before injections when its tool is on a path. Size **S**. Tests: load, change a description, reload, see the finding; accept it; reload unchanged, see nothing.

#### 1.4 Poisoned descriptions (from the scanners) ✔

**What.** At load, every tool description is checked for the marks of tool poisoning: instructions addressed to the model ("ignore previous", "do not tell the user", "before calling any other tool"), hidden text (zero-width and bidirectional Unicode, HTML comments, `<important>`-style tags), and the names of other tools or servers (shadowing). A hit sets `poison_flags` on the Tool node and opens a finding of kind **`poisoned_description`** quoting the span, with the tool and the agents that hold it. Cistern already wraps descriptions as untrusted for the model; this is the first time it tells a person.

**FalkorDB.** The flags are node properties and the finding joins the others; a poisoned tool on an open injection path raises that finding's severity to critical. **The agent.** The span is evidence the model can cite; the system prompt already says descriptions may contain instructions. Size **S**. Tests: a manifest with five poisoned descriptions and five clean ones that mention similar words.

#### 1.5 Communities and PageRank (from the hackathon's own list) ✔

**What.** "Blast zones" by WCC is all-or-nothing on three of the four scenarios. Replace it with **communities** from `algo.labelPropagation` over the flow layer (probe its signature on 6.0.2 first, as Q10 did for the others), coloured on the chart, each community marked blast or not by whether it holds an untrusted source and a high-impact resource. Add `algo.pageRank` over the flow layer as **influence** on the read panel ("this tool's output reaches more of the graph than any other"), context only, never a verdict.

**FalkorDB.** Two more of the five algorithms the organisers list, both in the database. Size **S** plus the probe. Tests: the probe, a unit test that communities partition the nodes, the e2e pill.

#### 1.6 Per-server view (from MCPhound's server graph) ✔

**What.** `MCPServer` nodes exist and no page shows them. A **Servers** page: each server, its tools, the agents that hold them, the findings that pass through its tools, and one button, **What if this server were removed**: a new what-if change `drop_server` that revokes every grant to its tools in a sandbox and reports what closes and what breaks. The answer is the question people ask of a scanner report: which server would I pull?

**FalkorDB.** One query for the page (`server.summary`) and one sandbox verdict per question. **The agent.** `drop_server` joins `what_if`'s change kinds, so the model can test it. Size **S/M**. Tests: the summary on `acme_dev` (four servers), the verdict on dropping `srv:http`.

#### 1.7 Attack rehearsal (from Promptfoo) ✔

**What.** For an open injection or trifecta finding, the model writes the text an attacker would plant in the untrusted source so that the agent on the path makes the call at its end: a ticket, an issue, a web page. It is shown in the brief under **What an attacker would plant**, with the path it rides, and is never sent anywhere. The ask box takes "show me the attack" for a finding.

**The agent.** This is a model task from start to end: it reads the path and the tool descriptions and writes the payload; the grounding check keeps every id it names real. Size **M**, blocked on the key and on Phase 0.7 showing the model handles the existing tools well.

### Order, sizes and gates

| Step | Items | Size | Gate |
| --- | --- | --- | --- |
| Phase 0 | 0.6, 0.5, 0.1, 0.4, 0.2, 0.3 in that order; 0.7 the day the key arrives | one day | `make test` and `make e2e` green; the trace of a scripted run shows six tools; PLAN.md section 13 and the README tour updated |
| Phase 1a ✔ | 1.2 scorecard, 1.3 drift, 1.5 communities | one day | Each a query, a finding or a pill, a unit test and an e2e line; the scenario `expect` blocks extended. **Met on Oct 13.** What the probes changed: label propagation runs over the config edges, not the flow layer, where a tool's acting side became a community of its own; `algo.pageRank` takes `(null, 'FLOWS_TO')` on 6.0.2, not a config map; communities colour the rings and a blast zone stays a WCC fact, because on `acme_dev` no community holds both an untrusted source and a high-impact resource |
| Phase 1b ✔ | 1.1 import, 1.4 poisoning | one to two days | A real install (Cistern's own server and the reference server chosen below) imported, labelled, scanned and audited end to end in the browser. **Met on Oct 13**: `@modelcontextprotocol/server-filesystem` imported over stdio with 14 tools; Cistern's own server is the import the tests use, so they need no network. The label form lives on the Inbox, not on a page of its own |
| Phase 1c ✔ | 1.6 servers page, 1.7 rehearsal | half a day plus the key | 1.6 is a section under the chart on the Graph page, with `drop_server` as a what-if change. 1.7 is a block on the finding page that asks an ask run for the text an attacker would plant; the first answer came back grounded, with each part of the text tied to the hop it rides. It was answered by `claude-opus-4-8`: the request's server-side fallback took over, which the run records |

Cut lines, in order, if time runs short: 1.7, 1.6, 1.4, then 1.1's editor configs (keep the single-command and saved-JSON inputs). Never cut 1.2, 1.3 or 1.5: each is one query and shows an algorithm the organisers named.

Every item carries the same three obligations the rest of the code has: a catalog query (no Cypher outside `catalog.py`), a test, and a line in the generated query list.

### Decisions needed from the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| P1 | Which real MCP server the demo imports beside Cistern's own | `@modelcontextprotocol/server-filesystem` on a scratch directory: public, runs with `npx`, has `readOnlyHint` annotations, and reads something private, which gives the import something to find once `fetch` or `github` is beside it |
| P2 | Whether labelling an import happens in the UI (1.1 as written) or on the command line | The UI: it is the surface a judge sees, and the labels are the one thing the person must decide |
| P3 | The name of the three-badge view | "Rule of Two", with Meta credited in the README; the term is theirs |
| P4 | Whether the ask box's four canned questions stay once a model is configured | Keep them as the examples the box offers; the model answers anything else |

### What this plan does not do

- It does not bring back anything struck on Oct 13: the CDC pipeline, the classifier, ACL users, tracing, the property tests, a second MCP server (PLAN.md D40, D42, D44).
- It does not add a runtime guard. FIDES and CaMeL act while the agent runs; Cistern acts before, on the design. The README says so.
- It does not deploy anything or record the video; both still wait on decisions N2 and the owner.
- It does not change the taint rules or the verdict queries. Every new finding kind (`drift`, `poisoned_description`) is additional evidence, not a change to what an injection or a trifecta is.
