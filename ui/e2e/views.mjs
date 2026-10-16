// The screens beyond the gate: the overview as a sankey, the whole-graph chart on both renderers (hover
// line, click to read, layers, the cheapest cut and its policy, communities, the edges as a table), the
// servers page, the what-if page, the queries drawer, the scenario switch, a deep link, a plan that is
// rejected and the split that is approved in its place, DeVries's audit of itself, the two fixes of
// acme_dev from the ledger, the ask box, the import page, and narrower screens. Needs the app running.
//
//   node e2e/views.mjs [app url]                    screenshots land in e2e/shots/
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8000";
const shots = fileURLToPath(new URL("./shots", import.meta.url));
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const problems = [];
const withModel = (await (await fetch(`${base}/api/session`)).json()).model?.configured === true;
const out = {};
const origin = new URL(base).origin;
const need = (ok, what) => { if (!ok) problems.push(what); };

async function open(width, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${width} console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${width} pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  page.on("request", (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.origin !== origin) problems.push("request to another origin: " + u.origin); });
  return { context, page };
}
const text = (page, selector) => page.locator(selector).first().innerText().then((t) => t.replace(/\s+/g, " ").trim());
const shot = async (page, name, opts = {}) => { await page.mouse.move(700, 3); await page.waitForTimeout(350); await page.screenshot({ path: `${shots}/${name}.png`, ...opts }); };
const tab = (page, name) => page.getByRole("tab", { name });
const place = (page, name) => page.locator(".nav-row", { hasText: name });
const stepTo = (page, name) => page.locator(".workflow-step", { hasText: name }).click();

{
  const { context, page } = await open(1440);

  // the overview: the one sentence, the open paths as sankey ribbons between the three columns, the counts
  await page.goto(`${base}/#/acme_support/graph`);
  await page.waitForSelector(".sankey svg .ov-ribbon", { state: "attached" });
  out.overviewTitle = await text(page, ".page-head h1");
  out.ribbons = await page.locator(".sankey .ov-ribbon").count();
  out.counts = await page.locator(".ov-counts div").allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
  need(/^One untrusted source reaches one high-impact resource through one agent, in 4 hops\./.test(out.overviewTitle), "the overview should open on its sentence: " + out.overviewTitle);
  need(out.ribbons === 2, `the support overview should draw one finding as two ribbon segments, got ${out.ribbons}`);
  need(out.counts.some((c) => /^1 open findings$/i.test(c)) && out.counts.some((c) => /^1 cheapest cut$/i.test(c)), "the counts should give the open findings and the cheapest cut: " + out.counts);
  {
    const hit = await page.locator(".sankey .ov-ribbon .hit").first().boundingBox();
    await page.mouse.move(hit.x + hit.width * 0.3, hit.y + hit.height / 2, { steps: 3 });
    await page.waitForTimeout(250);
  }
  out.overRibbon = await text(page, ".sankey .chart-over");
  need(/Customer tickets reaches Payments API through Support bot in four hops/.test(out.overRibbon) && /click to open/.test(out.overRibbon), "hovering a ribbon did not read the finding: " + out.overRibbon);
  await shot(page, "views-graph-overview");

  // every node, as cards in lanes: what is under the pointer is named, a clicked card is read out beside the chart
  await tab(page, "All nodes").click();
  await tab(page, "DeVries").click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  out.lanes = await page.locator(".chart .lane").allTextContents();
  need(out.lanes.length === 5, `the support graph should have five lanes, got ${out.lanes}`);
  await shot(page, "views-graph-flow");
  await page.locator('.fcard[data-id="agent:support-bot"]').hover();
  out.overNode = await text(page, ".chart-over");
  need(/Support bot agent:support-bot/.test(out.overNode) && /untrusted text reaches it/.test(out.overNode), "hovering a card did not name it under the chart: " + out.overNode);
  // an arc is a thin curve under a wide invisible stroke; the pointer event is sent to it rather than aimed at it
  await page.locator('.wire[data-hop="agent:support-bot>tool:payments.issue_refund"] .react-flow__edge-interaction').dispatchEvent("mouseover");
  await page.waitForTimeout(250);
  out.overEdge = await text(page, ".chart-over");
  need(/^rule 3: Support bot can call issue_refund/.test(out.overEdge), "hovering an arc did not say what it stands for: " + out.overEdge);
  await page.locator('.fcard[data-id="agent:support-bot"]').click();
  await page.waitForSelector(".read.picked");
  out.read = (await text(page, ".read.picked")).slice(0, 220);
  need(/findings through it/i.test(await text(page, ".read.picked")), "clicking a card did not fill the panel with what it is");
  need((await page.locator(".read .card a").count()) === 1, "the panel should link to the finding through the card");
  await shot(page, "views-graph-picked");

  // the same graph on FalkorDB's canvas, force and tree
  await tab(page, "FalkorDB canvas").click();
  await page.waitForSelector("falkordb-canvas");
  await page.waitForTimeout(1500);
  need(/FalkorDB's canvas/.test(await text(page, ".canvas-chart .chart-over")), "the canvas renderer should say what it is");
  await tab(page, "Tree").click();
  await page.waitForTimeout(1200);
  await shot(page, "views-graph-canvas");
  await tab(page, "DeVries").click();

  // one step further in: the config layer and its edges as a table
  await tab(page, "More").click();
  await tab(page, "Config").click();
  await page.locator(".figure .fold.source summary").click();                   // the source note is folded under the chart
  await page.waitForFunction(() => /Config edges are what a person set up/.test(document.querySelector(".figure .fold.source .chart-note")?.textContent ?? ""));
  await page.locator("details.as-table summary").click();
  out.configTable = { rows: await page.locator("details.as-table tbody tr").count() };
  need(out.configTable.rows === 11, "the config edges as a table should have 11 rows, got " + out.configTable.rows);
  await shot(page, "views-graph-config");
  await tab(page, "Flow").click();

  // the cheapest cut, by max flow: marked on the chart, spelled out under it as a guide and not a verdict, and as rules
  await tab(page, "Cheapest cut").click();
  await page.waitForSelector(".cut-block .cut-list li");
  await page.waitForSelector(".chart .cut-mark", { timeout: 60000 });
  out.cut = await text(page, ".cut-block");
  out.cutMarks = await page.locator(".chart .wire.cut").evaluateAll((wires) => wires.map((w) => w.getAttribute("data-hop")));
  need(/Cheapest cut: cost 1\./.test(out.cut) && /Support bot calls get_ticket/.test(out.cut), "the cheapest cut should be named: " + out.cut);
  need(out.cutMarks.join() === "tool:helpdesk.get_ticket>agent:support-bot", "the cut should be marked on the hop it is: " + out.cutMarks);
  await page.locator(".policy summary").click();
  out.policy = await page.locator(".policy pre").first().innerText();
  need(/"deny":\s*\[\s*"mcp__helpdesk__get_ticket"/.test(out.policy), "the cut as a Claude Code rule should deny the one tool: " + out.policy);
  await shot(page, "views-graph-cut");

  // the most central nodes, by betweenness: ranked on the chart, listed under it
  await tab(page, "Most central").click();
  await page.waitForSelector(".central-note li");
  out.central = await page.locator(".chart .fcard.central").evaluateAll((cards) => cards.map((d) => d.getAttribute("data-id")));
  need(out.central.includes("agent:support-bot") && out.central.length <= 5, "the support bot should be among the most central nodes: " + out.central);
  need(/algo\.betweenness/.test(await text(page, ".central-note")), "the note should name the algorithm");
  await shot(page, "views-graph-central");
  await tab(page, /Communities/).click();
  need(/one zone, and a blast zone/.test(await text(page, ".figure .chart-note")), "a one-zone graph should say so in words");
  await tab(page, "Everything").click();

  // blast zones: acme_exec has no high-impact resource, so nothing is in one
  await page.goto(`${base}/#/acme_exec/graph`);
  await page.waitForSelector(".sankey svg", { state: "attached" });
  await tab(page, "More").click();
  await page.waitForSelector('.chart .fcard[data-id="agent:exec-assistant"]', { timeout: 60000 }); // not the chart of the scenario just left
  out.execLanes = await page.locator(".chart .lane").allTextContents();
  need(out.execLanes.some((l) => /delegates/i.test(l)), "a delegate should stand in a lane of its own: " + out.execLanes);
  await tab(page, /Communities/).click();
  out.execCommunities = await page.locator(".chart-key .k-c0, .chart-key .k-c1, .chart-key .k-c2, .chart-key .k-c3, .chart-key .k-c4, .chart-key .k-c5").count();
  need(out.execCommunities >= 2 && (await page.locator(".chart .fcard.c0").count()) >= 1, "communities should be coloured on the cards and listed in the key: " + out.execCommunities);
  need(/none a blast zone/.test(await text(page, ".figure .chart-note")), "acme_exec has no high-impact resource, so no zone is a blast zone");
  await shot(page, "views-graph-exec-zones");

  // the servers page: each server, and what a sandbox says removing it would do
  await page.goto(`${base}/#/acme_dev/servers`);
  await page.waitForSelector(".servers .table tbody tr");
  out.servers = await page.locator(".servers .table tbody tr").count();
  need(out.servers >= 3, `the dev team should list its servers, got ${out.servers}`);
  await page.locator(".servers .table tbody tr", { hasText: "http" }).getByRole("button", { name: "test removing it" }).click();
  await page.waitForFunction(() => /closes \d+/.test(document.querySelector(".servers")?.textContent ?? ""), null, { timeout: 60000 });
  out.withoutHttp = (await page.locator(".servers .table tbody tr", { hasText: "http" }).innerText()).replace(/\s+/g, " ");
  need(/closes 5, opens 0, breaks 0/.test(out.withoutHttp), "removing the HTTP server should close five findings and break nothing: " + out.withoutHttp);
  await shot(page, "views-servers");

  // the queries, in a drawer over the page: all of them, the Cypher of one, the find box, and Escape to close it
  await page.goto(`${base}/#/acme_exec/queries/zones.wcc`);
  await page.waitForSelector(".drawer .cypher");
  out.queries = await page.locator(".catalog-group a").count();
  out.cypher = (await text(page, ".cypher")).slice(0, 60);
  const published = (await (await page.request.get(`${base}/api/queries`)).json()).queries.length;
  need(out.queries === published && published > 50, `the catalogue lists ${out.queries} of the ${published} queries the API publishes`);
  need(/algo\.WCC/.test(out.cypher) && (await page.locator(".cypher .c-fn").count()) >= 1, "the Cypher of zones.wcc should show its algorithm");
  await page.getByLabel("Find a query").fill("fix.");
  out.found = await page.locator(".catalog-group a").allInnerTexts();
  need(out.found.filter((q) => q.startsWith("fix.")).length === 5, "the find box should find the five fixes: " + out.found);
  await page.locator(".catalog-group a", { hasText: "fix.gate_call" }).click();
  await page.waitForFunction(() => document.querySelector(".query-head h1")?.textContent === "fix.gate_call");
  need(/Guarded/.test(await text(page, ".catalog .rail")), "a fix query should say it is guarded");
  need((await place(page, "Queries").getAttribute("class")).includes("on"), "the Queries row should light while the drawer is open");
  await shot(page, "views-queries");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".case");                                        // a deep link's drawer lies over the inbox
  await page.waitForSelector(".drawer", { state: "detached" });
  need((await page.locator(".drawer").count()) === 0 && /#\/acme_exec$/.test(await page.evaluate(() => location.hash)), "Escape should close the drawer onto the page under it: " + await page.evaluate(() => location.hash));

  // the scenario switch with its way to an import, and a deep link straight to a finding
  await page.locator(".switch-button").click();
  out.scenarios = await page.locator(".switch-menu li:not(.switch-import) .switch-name").allInnerTexts();
  const listed = (await (await page.request.get(`${base}/api/scenarios`)).json()).scenarios.length;
  need(out.scenarios.length === listed && out.scenarios.includes("DeVries itself"), `the switch should list all ${listed} scenarios by their titles: ` + out.scenarios);
  need((await page.locator(".switch-menu .switch-import").count()) === 1, "the switch should offer an import of your own config");
  await page.locator(".switch-menu button", { hasText: "Acme support" }).click();
  await page.waitForFunction(() => location.hash === "#/acme_support");
  await page.waitForSelector(".case");
  out.switched = await text(page, ".switch-name");
  await page.goto(`${base}/#/acme_support/finding/fnd%3Adce0910d42`);
  await page.waitForSelector(".brief-title");
  out.deepLink = await text(page, ".brief-title");
  need(/Customer tickets can reach Payments API/.test(out.deepLink), "the deep link did not open the finding: " + out.deepLink);
  need(/ASI01/.test(await text(page, ".strip .owasp")), "the finding strip should carry the OWASP class");
  await page.goto(`${base}/#/acme_support/finding/fnd%3Anot-a-finding`);
  await page.waitForSelector(".empty");
  need(/No finding/.test(await text(page, ".empty")), "an unknown finding should say so");

  // a plan a person rejects: nothing changes, the finding is open again and the ledger remembers
  await page.goto(`${base}/#/acme_support`);
  await page.waitForSelector(".case .phase.t-amber", { timeout: 240000 });
  await page.locator(".case").first().click();
  await page.waitForSelector(".brief-title");
  await stepTo(page, "Fix");                                                      // a plan waits for a person on the fix step and nowhere else
  await page.waitForSelector(".approval");
  await page.getByLabel("Your name").fill("Kartik");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByLabel("Why not").fill("refunds must stay automatic");
  await page.getByRole("button", { name: "Reject the fix" }).click();
  if (withModel) {
    // the gate is turned down and nothing has changed; the model tested only what it needed, so no other plan waits
    await page.waitForFunction(() => !document.querySelector(".approval") && document.querySelector(".strip .phase")?.textContent === "Open", null, { timeout: 240000 });
    await stepTo(page, "Options");
    out.rejected = await text(page, ".tested .verdict.pass");
    need(/rejected by Kartik: refunds must stay automatic/.test(out.rejected), "the rejected plan should say who rejected it and why: " + out.rejected);
    await stepTo(page, "Summary");
    await page.waitForSelector(".chart .fcard", { timeout: 60000 });
    need((await page.locator(".chart .wire.gated").count()) === 0, "a rejected plan must not change the graph");
    await shot(page, "views-rejected");
  } else {
    // the gate is turned down and nothing has changed; the other plan that passed, a split, is offered in its place
    await page.waitForFunction(() => /Split Support bot/.test(document.querySelector(".approval .approval-change")?.textContent ?? ""), null, { timeout: 240000 });
    await stepTo(page, "Options");
    out.rejected = await text(page, ".tested .verdict.pass");
    need(/rejected by Kartik: refunds must stay automatic/.test(out.rejected), "the rejected plan should say who rejected it and why: " + out.rejected);
    await stepTo(page, "Summary");
    await page.waitForSelector(".chart .fcard", { timeout: 60000 });
    need((await page.locator(".chart .wire.gated").count()) === 0, "a rejected plan must not change the graph");
    await shot(page, "views-rejected");
    // the split keeps refunds automatic: approved, the reading moves behind a reader whose results are quarantined
    await stepTo(page, "Fix");
    await page.getByLabel("Your name").fill("Kartik");
    await page.getByRole("button", { name: "Approve · Apply" }).click();
    await page.waitForFunction(() => document.querySelector(".strip .phase")?.textContent === "Mitigated", null, { timeout: 240000 });
    await stepTo(page, "Summary");
    await page.waitForSelector('.chart .fcard[data-id="agent:support-bot.reader"]', { timeout: 60000 });
    await page.waitForSelector(".chart .wire.gated", { state: "attached", timeout: 60000 });   // the arcs are drawn a frame after the cards
    out.split = await page.locator(".chart .wire.gated").evaluateAll((wires) => wires.map((w) => w.getAttribute("data-hop")));
    need(out.split.join() === "agent:support-bot.reader>agent:support-bot", "after the split the one blocked hop should be what the reader returns: " + out.split);
    need(await page.locator('.fcard.hot[data-id="agent:support-bot.reader"]').count() === 1 && await page.locator('.fcard.plain[data-id="agent:support-bot"]').count() === 1,
      "untrusted text should reach the reader and stop short of the agent that issues refunds");
    await shot(page, "views-split-applied");
  }
  await page.getByRole("button", { name: "Reset" }).click();
  await page.waitForFunction(() => document.querySelector(".session-name")?.textContent === "Shared scenario", null, { timeout: 240000 });

  // DeVries audited by DeVries: nothing open, and the one hop that would open something is gated
  await page.goto(`${base}/#/devries_self`);
  await page.waitForFunction(() => document.querySelector(".page-head h1")?.textContent === "Nothing open.");
  await page.goto(`${base}/#/devries_self/graph`);
  await page.waitForSelector(".sankey", { state: "attached" });
  need(/Nothing is drawn because nothing is open/.test(await text(page, ".sankey .chart-over")), "with nothing open the overview should say so");
  await tab(page, "All nodes").click();
  await tab(page, "DeVries").click();
  await page.waitForSelector('.chart .fcard[data-id="agent:auditor"]', { timeout: 60000 });
  out.selfGated = await page.locator(".chart .wire.gated").evaluateAll((wires) => wires.map((w) => w.getAttribute("data-hop")));
  need(out.selfGated.join() === "agent:auditor>tool:devries.apply_fix", "the auditor's own apply_fix should be the one gated hop: " + out.selfGated);
  need(await page.locator('.fcard.hot[data-id="agent:auditor"]').count() === 1 && await page.locator('.fcard.plain[data-id="res:agent-config"]').count() === 1,
    "untrusted text should reach the auditor and stop short of the agent configuration");
  await shot(page, "views-self-graph");

  // acme_dev takes two fixes, each approved from the ledger, with the sandbox preview and a what-if on the way
  await page.goto(`${base}/#/acme_dev`);
  await page.waitForSelector(".case .phase.t-amber", { timeout: 240000 });
  out.devOpen = await page.locator(".case.status-open").count();
  await page.goto(`${base}/#/acme_dev/graph`);
  await page.waitForSelector(".sankey svg .ov-ribbon", { state: "attached" });
  out.devRibbons = new Set(await page.locator(".sankey .ov-ribbon").evaluateAll((gs) => gs.map((g) => g.getAttribute("data-finding")))).size;
  out.devWorst = await page.locator(".sankey .ov-node.agent.worst").count();
  need(out.devRibbons === out.devOpen, `the dev overview should draw one ribbon per open finding: ${out.devRibbons} of ${out.devOpen}`);
  need(out.devWorst >= 1, "an agent that holds all three properties and runs unattended should be marked");
  await shot(page, "views-dev-overview");
  await page.goto(`${base}/#/acme_dev/whatif`);
  await page.waitForSelector(".whatif-line");
  await page.locator(".whatif-line select").nth(0).selectOption("agent:release-bot");
  await page.locator(".whatif-line select").nth(1).selectOption("tool:http.request");
  await page.getByRole("button", { name: "Test in a sandbox" }).click();
  await page.waitForSelector(".whatif-answer");
  out.whatIf = await text(page, ".whatif-verdict");
  need(/it would open one finding, close no findings and break no workflows/.test(out.whatIf), "the what-if line answered: " + out.whatIf);
  need((await page.locator(".whatif-answer .card").count()) === 1 && /Release bot holds untrusted input/.test(await text(page, ".whatif-answer .card")),
    "the finding a what-if would open should be listed with its path");
  await shot(page, "views-dev-whatif");

  await place(page, "Ledger").click();
  await page.waitForSelector(".after .chart .fcard", { timeout: 240000 });     // the preview is laid out on DeVries's chart, whatever else re-renders
  await page.waitForSelector(".after .chart .wire.gated", { state: "attached", timeout: 240000 });
  out.ledgerCards = await page.locator(".after .chart .fcard").count();
  need(out.ledgerCards >= 3, `the ledger preview should draw the plan's path as cards, got ${out.ledgerCards}`);
  out.devFirst = await text(page, ".approval .approval-change");
  need(/Require human approval before Coder calls push/.test(out.devFirst), "the plan on offer should be the one the run proposed: " + out.devFirst);
  need((await page.locator(".after .chart .wire.gated").getAttribute("data-hop")) === "agent:coder>tool:git.push", "the preview should show the push as gated");
  need(/sandbox/.test(await text(page, ".after .chart-note")), "the preview should say it was read from a sandbox");
  await page.getByLabel("Your name").fill("Kartik");
  await page.getByRole("button", { name: "Approve · Apply" }).click();
  await page.waitForFunction(() => /Revoke request from Coder/.test(document.querySelector(".approval .approval-change")?.textContent ?? ""), null, { timeout: 240000 });
  out.devSecond = await text(page, ".approval .approval-numbers");
  need(/resolves 3 · introduces 0 · breaks 0/.test(out.devSecond), "the second plan should close all three trifectas: " + out.devSecond);
  await page.getByRole("button", { name: "Approve · Apply" }).click();
  await page.waitForFunction(() => !document.querySelector(".approval"), null, { timeout: 240000 });
  await place(page, "Open").click();
  await page.waitForFunction(() => document.querySelector(".page-head h1")?.textContent === "Nothing open.", null, { timeout: 240000 });
  await place(page, "Closed").click();
  await page.waitForSelector(".case.status-mitigated");
  out.devDone = await page.locator(".case.status-mitigated").count();
  need(out.devDone === out.devOpen && out.devOpen === 7, `two fixes should close all seven findings of acme_dev: ${out.devDone} of ${out.devOpen}`);

  // the ask box: a model answers questions; without one the graph answers four kinds by itself
  await place(page, "Runs").click();
  await page.waitForSelector(".ask");
  const model = (await (await page.request.get(`${base}/api/session`)).json()).model;
  out.ask = await text(page, ".ask-note");
  if (!model.configured) {
    need(await page.locator(".ask input").isEnabled() && /four kinds of question/.test(out.ask), "with no model the ask box should be open and say what it can answer");
    out.askExamples = await page.locator(".ask-examples button").allInnerTexts();
    need(out.askExamples.length === 4 && /^What can reach /.test(out.askExamples[0]), "the box should offer four example questions: " + out.askExamples);
    await page.locator(".ask-examples button").first().click();
    await page.waitForFunction(() => /Worked out by reach\.into/.test(document.querySelector(".report")?.textContent ?? ""), null, { timeout: 240000 });
    out.askAnswer = await text(page, ".report .report-text");
    need(/thing\(s\) can reach /.test(out.askAnswer) && /Worked out by reach\.into \(algo\.bfs\), not by a model/.test(out.askAnswer),
      "a canned question should be answered from the graph, citing the query: " + out.askAnswer);
    need((await page.locator(".trace-row", { hasText: "reach.into" }).count()) === 1, "the trace should show the query the answer came from");
  } else {
    need(await page.locator(".ask input").isEnabled(), "with a model the ask box should be open");
  }
  await shot(page, "views-dev-audit");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.waitForFunction(() => document.querySelector(".session-name")?.textContent === "Shared scenario", null, { timeout: 240000 });

  // the import page: what it takes, in words, and that bad JSON is refused before anything is sent
  await page.goto(`${base}/#/acme_dev/import`);
  await page.waitForSelector(".import textarea");
  out.importTitle = await text(page, ".page-head h1");
  need(/Audit your own config/.test(out.importTitle), "the import page should say what it is for");
  await page.locator(".import textarea").fill("{not json");
  await page.getByRole("button", { name: "Import and audit" }).click();
  need(/not JSON/.test(await text(page, ".whatif-error")), "bad JSON should be refused on the page");
  await shot(page, "views-import");
  await context.close();
}

// narrower screens: the rail drops under the brief, then the sidebar becomes a strip; nothing scrolls sideways
for (const width of [1100, 420]) {
  const { context, page } = await open(width);
  for (const [name, hash, ready] of [["inbox", "#/acme_exec", ".case"], ["finding", "#/acme_exec/finding/fnd%3A97fb560344", ".chart .fcard"], ["graph", "#/acme_exec/graph", ".sankey svg"], ["queries", "#/acme_exec/queries", ".cypher"], ["import", "#/acme_exec/import", ".import textarea"], ["servers", "#/acme_exec/servers", ".servers"]]) {
    await page.goto(`${base}/${hash}`);
    await page.waitForSelector(ready, { timeout: 60000, state: ready === ".sankey svg" ? "attached" : "visible" });
    const o = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
    need(o.scrollW <= o.clientW, `the ${name} page scrolls sideways at ${width} px: ${o.scrollW} > ${o.clientW}`);
    await shot(page, `views-${width}-${name}`);
  }
  await context.close();
}

console.log(JSON.stringify({ out, problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
