// The screens beyond the gate: the posture's picture and its cut as rules, the explorer on both renderers
// (hover line, click to read, the layers, the lenses, the edges as a table), its tables with the servers and
// their test, the method page and its queries, the scenario switch, a deep link, a plan that is rejected and the split
// that is approved in its place, DeVries's audit of itself, the two fixes of acme_dev approved from their
// findings, a what-if asked in the explorer's reader, the ask box, the import page, and narrower screens.
// Needs the app running.
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
const stepTo = (page, name) => page.locator(".workflow-step", { has: page.locator(".workflow-label", { hasText: new RegExp(`^${name}$`) }) }).click();

{
  const { context, page } = await open(1440);

  // the landing: its counts are the server's, its demo plays by itself, and it does not claim there is nothing to install
  await page.goto(`${base}/#/`);
  await page.waitForSelector(".l-band-n");
  const listedScenarios = (await (await page.request.get(`${base}/api/scenarios`)).json()).scenarios.length;
  const publishedQueries = (await (await page.request.get(`${base}/api/queries`)).json()).queries.length;
  await page.waitForFunction((n) => [...document.querySelectorAll(".l-band")].some((b) => /Scenarios/.test(b.textContent ?? "") && (b.textContent ?? "").includes(String(n))), listedScenarios, { timeout: 10000 }).catch(() => {});
  out.bands = await page.locator(".l-band").allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
  need(out.bands.some((b) => b.startsWith(`Scenarios ${listedScenarios}`)) && out.bands.some((b) => b.startsWith(`Queries ${publishedQueries}`)), `the landing's counts should be the server's (${listedScenarios} scenarios, ${publishedQueries} queries): ` + out.bands);
  need(/one command, runs locally/.test(await text(page, ".l-price-unit")), "the landing should say it runs locally, not that there is nothing to install");
  need((await page.locator(".ld").count()) === 1 && (await page.locator(".ld-play").count()) === 0, "the hero demo should play by itself, with no tap-to-play poster");
  need(/method\/queries$/.test(await page.locator(".l-enterprise-link").getAttribute("href")), "the landing's query link should land on the method page's queries");

  // the posture: the one sentence, the open paths as a live flow between cards, the figures, the cut as rules
  await page.goto(`${base}/#/acme_support`);
  await page.waitForSelector(".riskflow .river", { state: "attached", timeout: 240000 });
  out.postureTitle = await text(page, ".page-head h1");
  out.ribbons = await page.locator(".riskflow .river").count();
  out.figures = await page.locator(".figures div").allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
  // the title is the sentence's first clause; a second clause, when there is one, opens the meta line
  need(/^One untrusted source reaches one high-impact resource/.test(out.postureTitle) && out.postureTitle.split(" ").length <= 16, "the posture should open on one short clause: " + out.postureTitle);
  need(out.ribbons === 2, `the support posture should draw one finding as two hops, got ${out.ribbons}`);
  out.cards = await page.locator(".riskflow .rcard").allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
  need(out.cards.length === 3 && out.cards.some((c) => /UNTRUSTED SOURCE Customer tickets/.test(c)) && out.cards.some((c) => /HIGH-IMPACT ACTION Payments API/.test(c)), "the flow should draw the source, the agent and the action as cards: " + out.cards);
  need(out.figures.some((c) => /^1 open finding$/i.test(c)) && out.figures.some((c) => /^2 cheapest cut, cost$/i.test(c)), "the figures should give the open findings and the cheapest cut: " + out.figures);
  await page.locator(".riskflow .river .react-flow__edge-interaction").first().dispatchEvent("mouseover");
  await page.waitForFunction(() => /click to open/.test(document.querySelector(".riskflow .chart-over")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  out.overRibbon = await text(page, ".riskflow .chart-over");
  need(/Customer tickets reaches Payments API through Support bot in four hops/.test(out.overRibbon) && /click to open/.test(out.overRibbon), "hovering a ribbon did not read the finding: " + out.overRibbon);
  await page.waitForSelector(".cut-line");
  out.cut = await text(page, ".cut-line");
  need(/Cheapest cut: cost 2\./.test(out.cut) && /Support bot can call issue_refund/.test(out.cut) && /by gating the call/.test(out.cut) && !/revoking/.test(out.cut),
       "the cheapest cut should be named on the posture, priced as the gate the sandbox passes: " + out.cut);
  await page.locator(".policy summary").click();
  out.policy = await page.locator(".policy pre").first().innerText();
  need(/"ask":\s*\[\s*"mcp__payments__issue_refund"/.test(out.policy), "the cut as a Claude Code rule should ask before the one tool: " + out.policy);
  await page.waitForSelector(".tally-card");                                     // the Rule of Two is open by default
  out.tally = await page.locator(".tally-card").allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
  need(out.tally.length === 1 && /Support bot/.test(out.tally[0]) && /two of three/.test(out.tally[0]), "the tally should give the support bot two of three: " + out.tally);
  out.blast = await text(page, ".posture-blast .bars li");
  need(/Customer tickets/.test(out.blast) && /one high-impact/.test(out.blast), "the blast radius should name the one untrusted source and what it reaches: " + out.blast);
  await shot(page, "views-posture");
  // the cut as one plan: the sandbox refuses it here, because the refund workflow needs the grant it would revoke
  await page.getByRole("button", { name: "Propose it as one plan" }).click();
  await page.waitForSelector(".cut-line .whatif-error, .cut-line a", { timeout: 60000 });
  out.proposeCut = await text(page, ".cut-line");
  need(/Passed in a sandbox/.test(out.proposeCut) && /read it on the fix step/.test(out.proposeCut), "proposing the cut should pass the sandbox and point at the fix step: " + out.proposeCut);

  // the explorer: every node, as cards in lanes, the open paths lit; what is under the pointer is named, a clicked card is read out beside the chart
  await page.goto(`${base}/#/acme_support/graph`);
  await tab(page, "DeVries").click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  out.explorerTitle = await text(page, ".page-head h1");
  need(/one open path lit/.test(out.explorerTitle), "the explorer should say how many open paths are lit: " + out.explorerTitle);
  out.lanes = await page.locator(".chart .lane").allTextContents();
  need(out.lanes.length === 5, `the support graph should have five lanes, got ${out.lanes}`);
  need((await page.locator(".chart .wire.traced").count()) >= 4, "the open path should be lit over the whole system");
  await shot(page, "views-explorer");
  await page.locator('.fcard[data-id="agent:support-bot"]').hover();
  out.overNode = await text(page, ".chart-over");
  need(/Support bot agent:support-bot/.test(out.overNode) && /untrusted text reaches it/.test(out.overNode), "hovering a card did not name it under the chart: " + out.overNode);
  // an arc is a thin curve under a wide invisible stroke; the pointer event is sent to it rather than aimed at it
  await page.locator('.wire[data-hop="agent:support-bot>tool:payments.issue_refund"] .react-flow__edge-interaction').dispatchEvent("mouseover");
  await page.waitForFunction(() => /^rule 3/.test(document.querySelector(".chart-over")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  out.overEdge = await text(page, ".chart-over");
  need(/^rule 3: Support bot can call issue_refund/.test(out.overEdge), "hovering an arc did not say what it stands for: " + out.overEdge);
  await page.locator('.fcard[data-id="agent:support-bot"]').click();
  await page.waitForSelector(".read.picked");
  need(/graph\/agent%3Asupport-bot$/.test(await page.evaluate(() => location.hash)), "a picked card should be in the address: " + await page.evaluate(() => location.hash));
  out.read = (await text(page, ".read.picked")).slice(0, 220);
  need(/findings through it/i.test(await text(page, ".read.picked")), "clicking a card did not fill the panel with what it is");
  need((await page.locator(".read .card a").count()) === 1, "the panel should link to the finding through the card");
  need((await page.locator(".read .badge.on").count()) === 2, "the reader should give the agent its two Rule of Two letters");
  // a change tested from the reader: one more grant for this agent, answered from a sandbox
  await page.locator(".read .whatif-line select").nth(1).selectOption("tool:payments.issue_refund");
  need((await page.locator(".read .whatif-line select").nth(0).inputValue()) === "agent:support-bot", "the reader's what-if should be pre-filled with the picked agent");
  await shot(page, "views-explorer-picked");

  // the same graph on FalkorDB's canvas, force and tree
  await tab(page, "FalkorDB canvas").click();
  await page.waitForSelector("falkordb-canvas");
  await page.waitForTimeout(1500);
  need(/FalkorDB's canvas/.test(await text(page, ".canvas-chart .chart-over")), "the canvas renderer should say what it is");
  await tab(page, "Tree").click();
  await page.waitForTimeout(1200);
  await shot(page, "views-explorer-canvas");
  // the renderer is remembered per kind of page: the Explorer on the canvas leaves a finding's Path step on DeVries's chart
  await page.goto(`${base}/#/acme_support/finding/fnd%3Adce0910d42/path`);
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  need((await page.locator("falkordb-canvas").count()) === 0, "the Path step should not inherit the Explorer's renderer");
  await page.goto(`${base}/#/acme_support/graph`);
  await page.waitForSelector("falkordb-canvas", { timeout: 60000 });
  await tab(page, "DeVries").click();

  // the config layer and its edges as a table
  await tab(page, "Config").click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  need((await page.locator(".fold.source").count()) === 0 && /What a person set up/.test(await text(page, ".page-head")), "the config layer should say what it is in one line and not explain itself");
  await page.locator("details.as-table summary").click();
  out.configTable = { rows: await page.locator("details.as-table tbody tr").count() };
  need(out.configTable.rows === 11, "the config edges as a table should have 11 rows, got " + out.configTable.rows);
  await shot(page, "views-explorer-config");
  await tab(page, "Flow").click();

  // the cheapest cut lens marks the hop; the hops themselves are on the posture
  await tab(page, "Cheapest cut").click();
  await page.waitForSelector(".chart .cut-mark", { timeout: 60000 });
  out.cutMarks = await page.locator(".chart .wire.cut").evaluateAll((wires) => wires.map((w) => w.getAttribute("data-hop")));
  need(out.cutMarks.join() === "agent:support-bot>tool:payments.issue_refund", "the cut should be marked on the hop it is: " + out.cutMarks);
  await shot(page, "views-explorer-cut");

  // the most central nodes, by betweenness: ranked on the chart, listed under it
  await tab(page, "Most central").click();
  await page.waitForSelector(".central-note li");
  out.central = await page.locator(".chart .fcard.central").evaluateAll((cards) => cards.map((d) => d.getAttribute("data-id")));
  need(out.central.includes("agent:support-bot") && out.central.length <= 5, "the support bot should be among the most central nodes: " + out.central);
  need((await page.locator(".central-note li").count()) === out.central.length && !/algo\./.test(await text(page, ".central-note")), "the note should list the central nodes and leave the method to the Method page");
  await shot(page, "views-explorer-central");
  await tab(page, /Communities/).click();
  need(/one zone, and a blast zone/.test(await text(page, ".figure .chart-note")), "a one-zone graph should say so in words");

  // blast zones: acme_exec has no high-impact resource, so nothing is in one
  await page.goto(`${base}/#/acme_exec/graph`);
  await page.waitForSelector('.chart .fcard[data-id="agent:exec-assistant"]', { timeout: 60000 }); // not the chart of the scenario just left
  out.execLanes = await page.locator(".chart .lane").allTextContents();
  need(out.execLanes.some((l) => /delegates/i.test(l)), "a delegate should stand in a lane of its own: " + out.execLanes);
  await tab(page, /Communities/).click();
  out.execCommunities = await page.locator(".chart-key .k-c0, .chart-key .k-c1, .chart-key .k-c2, .chart-key .k-c3, .chart-key .k-c4, .chart-key .k-c5").count();
  need(out.execCommunities >= 2 && (await page.locator(".chart .fcard.c0").count()) >= 1, "communities should be coloured on the cards and listed in the key: " + out.execCommunities);
  need(/none a blast zone/.test(await text(page, ".figure .chart-note")), "acme_exec has no high-impact resource, so no zone is a blast zone");
  await shot(page, "views-explorer-exec-zones");
  // a finding's path, lit from its page
  await page.goto(`${base}/#/acme_exec/graph/fnd%3A97fb560344`);
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  await page.waitForSelector(".figure .chart-note", { timeout: 60000 });
  need(/Lit: the path of Executive assistant/.test(await page.locator(".figure .chart-note").allInnerTexts().then((all) => all.join(" "))), "a finding's id in the address should light its path");
  await page.waitForSelector(".chart .wire.traced", { state: "attached", timeout: 60000 });   // the arcs are drawn a frame after the cards
  need((await page.locator(".chart .wire.traced").count()) >= 3, "the lit finding's hops should be traced on the chart");

  // the explorer's tables: every kind of thing, and the servers with what a sandbox says removing one would do
  await page.goto(`${base}/#/acme_dev/graph/tables`);
  await page.waitForSelector(".inventory .table tbody tr", { timeout: 60000 });
  out.inventoryTabs = await page.locator(".tabs [role=tab]").allInnerTexts();
  need(/^Agents\s*4$/.test(out.inventoryTabs[0] ?? ""), "the agents tab should count the dev team's four agents: " + out.inventoryTabs);
  need((await tab(page, /Tables/).getAttribute("class")).includes("on") && (await place(page, "Explorer").getAttribute("class")).includes("on"), "the tables should be a view of the Explorer");
  out.agentRow = await text(page, ".inventory .table tbody tr");
  need(/A · B · C/.test(out.agentRow) && /all three/.test(out.agentRow), "the first agent row should carry its three letters: " + out.agentRow);
  for (const kind of ["Tools", "Sources", "Resources"]) {
    await tab(page, new RegExp(kind)).click();
    await page.waitForSelector(".inventory .table tbody tr");
    need((await page.locator(".inventory .table tbody tr").count()) >= 1, `the inventory's ${kind} tab should list rows`);
  }
  await tab(page, /Servers/).click();
  await page.waitForSelector(".servers .table tbody tr");
  out.servers = await page.locator(".servers .table tbody tr").count();
  need(out.servers >= 3, `the dev team should list its servers, got ${out.servers}`);
  await page.locator(".servers .table tbody tr", { hasText: "http" }).getByRole("button", { name: "test removing it" }).click();
  await page.waitForFunction(() => /closes \d+/.test(document.querySelector(".servers")?.textContent ?? ""), null, { timeout: 60000 });
  out.withoutHttp = (await page.locator(".servers .table tbody tr", { hasText: "http" }).innerText()).replace(/\s+/g, " ");
  need(/closes 5, opens 0, breaks 0/.test(out.withoutHttp), "removing the HTTP server should close five findings and break nothing: " + out.withoutHttp);
  await shot(page, "views-inventory-servers");
  await tab(page, /Tools/).click();
  await page.locator(".inventory .table tbody tr").first().click();
  await page.waitForSelector(".read.picked");
  need(/graph\/tool%3A/.test(await page.evaluate(() => location.hash)), "an inventory row should open the thing in the explorer: " + await page.evaluate(() => location.hash));

  // the method page: the rules with their statements, then every query: the Cypher of one, where it is used, the find box
  await page.goto(`${base}/#/acme_exec/method`);
  await page.waitForSelector(".method-block .statement .cypher", { timeout: 60000 });
  out.methodBlocks = await page.locator(".method-block").count();
  need(out.methodBlocks >= 4, `the method page should open on the rules, got ${out.methodBlocks} blocks`);
  for (const [section, ready, rows] of [["Flow layer", ".method-table", 7], ["Fixes and verdicts", ".method-table", 5], ["Analytics", ".method-list", 10]]) {
    await tab(page, new RegExp(`^${section}`)).click();
    await page.waitForSelector(ready);
    await page.waitForFunction((n) => document.querySelectorAll(".method-table tbody tr").length === n, rows, { timeout: 10000 }).catch(() => {});
    need((await page.locator(".method-block").count()) >= 2, `the ${section} section should hold its blocks`);
    need((await page.locator(".method-table tbody tr").count()) === rows, `the ${section} section's table should have ${rows} rows`);
  }
  await shot(page, "views-method");
  await page.goto(`${base}/#/acme_exec/method/queries/zones.wcc`);
  await page.waitForSelector(".catalog .cypher");
  out.queries = await page.locator(".catalog-group a").count();
  out.cypher = (await text(page, ".cypher")).slice(0, 60);
  const published = (await (await page.request.get(`${base}/api/queries`)).json()).queries.length;
  need(out.queries === published && published > 50, `the catalogue lists ${out.queries} of the ${published} queries the API publishes`);
  need(/algo\.WCC/.test(out.cypher) && (await page.locator(".cypher .c-fn").count()) >= 1, "the Cypher of zones.wcc should show its algorithm");
  need(/Explorer/.test(await text(page, ".catalog .rail")), "a query should say where on screen its answer shows");
  await page.getByLabel("Find a query").fill("fix.");
  out.found = await page.locator(".catalog-group a").allInnerTexts();
  need(out.found.filter((q) => q.startsWith("fix.")).length === 5, "the find box should find the five fixes: " + out.found);
  await page.locator(".catalog-group a", { hasText: "fix.gate_call" }).click();
  await page.waitForFunction(() => document.querySelector(".query-head h1")?.textContent === "fix.gate_call");
  need(/Guarded/.test(await text(page, ".catalog .rail")), "a fix query should say it is guarded");
  need((await place(page, "Method").getAttribute("class")).includes("on"), "the Method row should light on the queries");
  need(/method\/queries\/fix\.gate_call$/.test(await page.evaluate(() => location.hash)), "a query should have its own address: " + await page.evaluate(() => location.hash));
  await shot(page, "views-queries");
  await page.goto(`${base}/#/acme_exec/queries/zones.wcc`);                      // the old address lands on the method page
  await page.waitForFunction(() => location.hash === "#/acme_exec/method/queries/zones.wcc", null, { timeout: 60000 });

  // the scenario switch with its way to an import, and a deep link straight to a finding's step
  await page.locator(".switch-button").click();
  out.scenarios = await page.locator(".switch-menu li:not(.switch-import) .switch-name").allInnerTexts();
  const listed = (await (await page.request.get(`${base}/api/scenarios`)).json()).scenarios.length;
  need(out.scenarios.length === listed && out.scenarios.includes("DeVries itself"), `the switch should list all ${listed} scenarios by their titles: ` + out.scenarios);
  need((await page.locator(".switch-menu .switch-import").count()) === 1, "the switch should offer an import of your own config");
  await page.locator(".switch-menu button", { hasText: "Acme support" }).click();
  await page.waitForFunction(() => location.hash === "#/acme_support");
  await page.waitForSelector(".figures dd", { timeout: 60000 });
  out.switched = await text(page, ".switch-name");
  await page.goto(`${base}/#/acme_support/finding/fnd%3Adce0910d42/rule`);
  await page.waitForSelector(".rule-needs li");
  out.deepLink = await text(page, ".brief-title");
  need(/^Rule 1/.test(out.deepLink), "the deep link did not open the finding on its rule step: " + out.deepLink);
  need(/ASI01/.test(await text(page, ".strip .owasp")), "the finding strip should carry the OWASP class");
  await page.goto(`${base}/#/acme_support/finding/fnd%3Anot-a-finding`);
  await page.waitForSelector(".empty");
  need(/No finding/.test(await text(page, ".empty")), "an unknown finding should say so");
  // an older address lands where its content now lives
  await page.goto(`${base}/#/acme_support/whatif`);
  await page.waitForFunction(() => location.hash === "#/acme_support/graph", null, { timeout: 60000 });
  await page.goto(`${base}/#/acme_support/servers`);
  await page.waitForFunction(() => location.hash === "#/acme_support/graph/tables/servers", null, { timeout: 60000 });
  await page.goto(`${base}/#/acme_support/inventory/tools`);
  await page.waitForFunction(() => location.hash === "#/acme_support/graph/tables/tools", null, { timeout: 60000 });

  // a plan a person rejects: nothing changes, the finding is open again and the options remember
  await page.goto(`${base}/#/acme_support/inbox`);
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
    await stepTo(page, "Path");
    await page.waitForSelector(".chart .fcard", { timeout: 60000 });
    need((await page.locator(".chart .wire.gated").count()) === 0, "a rejected plan must not change the graph");
    await shot(page, "views-rejected");
  } else {
    // the gate is turned down and nothing has changed; the other plan that passed, a split, is offered in its place
    await page.waitForFunction(() => /Split Support bot/.test(document.querySelector(".approval .approval-change")?.textContent ?? ""), null, { timeout: 240000 });
    await stepTo(page, "Options");
    out.rejected = await text(page, ".tested .verdict.pass");
    need(/rejected by Kartik: refunds must stay automatic/.test(out.rejected), "the rejected plan should say who rejected it and why: " + out.rejected);
    await stepTo(page, "Path");
    await page.waitForSelector(".chart .fcard", { timeout: 60000 });
    need((await page.locator(".chart .wire.gated").count()) === 0, "a rejected plan must not change the graph");
    await shot(page, "views-rejected");
    // the split keeps refunds automatic: approved, the reading moves behind a reader whose results are quarantined
    await stepTo(page, "Fix");
    await page.getByLabel("Your name").fill("Kartik");
    await page.getByRole("button", { name: "Approve · Apply" }).click();
    await page.waitForFunction(() => document.querySelector(".strip .phase")?.textContent === "Mitigated", null, { timeout: 240000 });
    await stepTo(page, "Path");
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
  await page.goto(`${base}/#/devries_self/inbox`);
  await page.waitForFunction(() => document.querySelector(".page-head h1")?.textContent === "Nothing open.");
  await page.goto(`${base}/#/devries_self`);
  await page.waitForSelector(".riskflow", { state: "attached", timeout: 60000 });
  need(/Nothing is drawn because nothing is open/.test(await text(page, ".riskflow .chart-over")), "with nothing open the posture's picture should say so");
  need(/Nothing untrusted reaches/.test(await text(page, ".page-head h1")), "with nothing open the posture should say so in its sentence");
  await page.goto(`${base}/#/devries_self/graph`);
  await tab(page, "DeVries").click();
  await page.waitForSelector('.chart .fcard[data-id="agent:auditor"]', { timeout: 60000 });
  out.selfGated = await page.locator(".chart .wire.gated").evaluateAll((wires) => wires.map((w) => w.getAttribute("data-hop")));
  need(out.selfGated.join() === "agent:auditor>tool:devries.apply_fix", "the auditor's own apply_fix should be the one gated hop: " + out.selfGated);
  need(await page.locator('.fcard.hot[data-id="agent:auditor"]').count() === 1 && await page.locator('.fcard.plain[data-id="res:agent-config"]').count() === 1,
    "untrusted text should reach the auditor and stop short of the agent configuration");
  await shot(page, "views-self-explorer");

  // acme_dev takes two fixes, each approved from its finding, with a what-if asked in the explorer on the way
  await page.goto(`${base}/#/acme_dev/inbox`);
  await page.waitForSelector(".case .phase.t-amber", { timeout: 240000 });
  out.devOpen = await page.locator(".case.status-open").count();
  await page.goto(`${base}/#/acme_dev`);
  await page.waitForSelector(".riskflow .river", { state: "attached", timeout: 60000 });
  out.devRibbons = new Set(await page.locator(".riskflow .river").evaluateAll((gs) => gs.map((g) => g.getAttribute("data-finding")))).size;
  out.devWorst = await page.locator(".riskflow .rcard.worst").count();
  need(out.devRibbons === out.devOpen, `the dev posture should draw every open finding as a path: ${out.devRibbons} of ${out.devOpen}`);
  need(out.devWorst >= 1, "an agent that holds all three properties and runs unattended should be marked");
  // one scan is a note, not a one-bar chart; the history is drawn once there are two
  need((await page.locator(".scans .scan").count()) >= 2 || /One scan so far/.test(await text(page, ".posture-scans-note")), "with one scan the posture should say the history starts with the next");
  await shot(page, "views-dev-posture");
  await page.goto(`${base}/#/acme_dev/graph/agent%3Arelease-bot`);
  await page.waitForSelector(".read.picked .whatif-line", { timeout: 60000 });
  await page.locator(".read .whatif-line select").nth(1).selectOption("tool:http.request");
  await page.getByRole("button", { name: "Test in a sandbox" }).click();
  await page.waitForSelector(".whatif-answer", { timeout: 60000 });
  out.whatIf = await text(page, ".whatif-verdict");
  need(/it would open one finding, close no findings and break no workflows/.test(out.whatIf), "the what-if in the reader answered: " + out.whatIf);
  need((await page.locator(".whatif-answer .card").count()) === 1 && /Release bot holds untrusted input/.test(await text(page, ".whatif-answer .card")),
    "the finding a what-if would open should be listed with its path");
  await shot(page, "views-dev-whatif");

  for (const round of [1, 2]) {
    await page.goto(`${base}/#/acme_dev/inbox`);
    await page.waitForSelector(".case .phase.t-amber", { timeout: 240000 });
    await page.locator(".case", { has: page.locator(".phase.t-amber") }).first().click();
    await page.waitForSelector(".brief-title");
    await stepTo(page, "Fix");
    await page.waitForSelector(".approval", { timeout: 60000 });
    out[`devPlan${round}`] = await text(page, ".approval .approval-change");
    if (round === 1) need(/Require human approval before Coder calls push/.test(out.devPlan1), "the plan on offer should be the one the run proposed: " + out.devPlan1);
    if (round === 2) need(/Revoke request from Coder/.test(out.devPlan2) && /resolves 3 · introduces 0 · breaks 0/.test(await text(page, ".approval .approval-numbers")), "the second plan should close all three trifectas: " + out.devPlan2);
    await page.getByLabel("Your name").fill("Kartik");
    await page.getByRole("button", { name: "Approve · Apply" }).click();
    await page.waitForFunction(() => document.querySelector(".strip .phase")?.textContent === "Mitigated", null, { timeout: 240000 });
  }
  await place(page, "Open").click();
  await page.waitForFunction(() => document.querySelector(".page-head h1")?.textContent === "Nothing open.", null, { timeout: 240000 });
  await place(page, "Closed").click();
  await page.waitForSelector(".case.status-mitigated");
  out.devDone = await page.locator(".case.status-mitigated").count();
  need(out.devDone === out.devOpen && out.devOpen === 7, `two fixes should close all seven findings of acme_dev: ${out.devDone} of ${out.devOpen}`);
  await place(page, "Posture").click();
  await page.waitForFunction(() => document.querySelectorAll(".scans .scan").length >= 3, null, { timeout: 240000 });
  out.devScans = await page.locator(".scans .scan .scan-n").allInnerTexts();
  need(out.devScans[out.devScans.length - 1] === "0" && out.devScans[0] === "7", "the posture's history should show the drop from seven to none: " + out.devScans);
  await shot(page, "views-dev-posture-after");

  // the ask box on Activity: a model answers questions; without one the graph answers four kinds by itself
  await place(page, "Activity").click();
  await page.waitForSelector(".ask");
  await page.waitForSelector(".activity-row.kind-applied", { timeout: 60000 });
  need((await page.locator(".activity-row.kind-decision").count()) === 2, "activity should hold the two decisions");
  const model = (await (await page.request.get(`${base}/api/session`)).json()).model;
  out.ask = await text(page, ".ask-note");
  if (!model.configured) {
    need(await page.locator(".ask input").isEnabled() && /four kinds of question/.test(out.ask), "with no model the ask box should be open and say what it can answer");
    out.askExamples = await page.locator(".ask-examples button").allInnerTexts();
    need(out.askExamples.length === 4 && /^What can reach /.test(out.askExamples[0]), "the box should offer four example questions: " + out.askExamples);
    await page.locator(".ask-examples button").first().click();
    // the question's run opens by itself as it is answered; if it has not within a while, say what the page holds and open it by hand
    const answered = () => page.waitForFunction(() => [...document.querySelectorAll(".activity-trace .report")].some((r) => /Worked out by reach\.into/.test(r.textContent ?? "")), null, { timeout: 30000 });
    await answered().catch(async () => {
      out.askDebug = {
        rows: (await page.locator(".activity-row").allInnerTexts()).slice(0, 4).map((t) => t.replace(/\s+/g, " ").slice(0, 120)),
        open: await page.locator(".activity-row.open").count(), traces: await page.locator(".activity-trace").count(), reports: await page.locator(".activity-trace .report").count(),
        runs: (await (await page.request.get(`${base}/api/scenarios/acme_dev/runs`)).json()).runs.map((r) => `${r.id}:${r.kind}:${r.status}`),
      };
      problems.push("the question's run did not open by itself: " + JSON.stringify(out.askDebug));
      await page.locator(".activity-row.kind-run .link-plain").first().click();
      await answered().catch(async () => {
        out.askDebugAfterClick = { rows: (await page.locator(".activity-row").allInnerTexts()).slice(0, 3).map((t) => t.replace(/\s+/g, " ").slice(0, 160)), reports: await page.locator(".activity-trace .report").allInnerTexts() };
        problems.push("the question's run did not answer after opening it by hand: " + JSON.stringify(out.askDebugAfterClick));
      });
    });
    out.askAnswer = (await page.locator(".report .report-text").count()) ? await text(page, ".report .report-text") : "";
    need(/thing\(s\) can reach /.test(out.askAnswer) && /Worked out by reach\.into \(algo\.bfs\), not by a model/.test(out.askAnswer),
      "a canned question should be answered from the graph, citing the query: " + out.askAnswer);
    need((await page.locator(".trace-row", { hasText: "reach.into" }).count()) === 1, "the trace should show the query the answer came from");
  } else {
    need(await page.locator(".ask input").isEnabled(), "with a model the ask box should be open");
  }
  await shot(page, "views-dev-activity");
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

// the catalogue stays beside the sidebar at the width where the old drawer used to slide under it
{
  const { context, page } = await open(1180, 800);
  await page.goto(`${base}/#/acme_exec/method/queries`);
  await page.waitForSelector(".cypher");
  const list = await page.locator(".catalog-list").boundingBox();
  const side = await page.locator(".side").boundingBox();
  need(list && side && list.x >= side.x + side.width - 1, `at 1180 px the catalogue should start right of the sidebar: ${list?.x} vs ${side?.x + side?.width}`);
  await shot(page, "views-1180-queries");
  await context.close();
}

// narrower screens: the rail drops under the brief, then the sidebar becomes a strip; nothing scrolls sideways
for (const width of [1100, 420]) {
  const { context, page } = await open(width);
  for (const [name, hash, ready] of [["posture", "#/acme_exec", ".figures dd"], ["inbox", "#/acme_exec/inbox", ".case"], ["finding", "#/acme_exec/finding/fnd%3A97fb560344", ".path-words"], ["path", "#/acme_exec/finding/fnd%3A97fb560344/path", ".chart .fcard"], ["explorer", "#/acme_exec/graph", ".chart .fcard"], ["tables", "#/acme_exec/graph/tables", ".inventory"], ["activity", "#/acme_exec/audit", ".activity-row"], ["method", "#/acme_exec/method", ".method-block"], ["queries", "#/acme_exec/method/queries", ".cypher"], ["import", "#/acme_exec/import", ".import textarea"]]) {
    await page.goto(`${base}/${hash}`);
    await page.waitForSelector(ready, { timeout: 60000 });
    const o = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
    need(o.scrollW <= o.clientW, `the ${name} page scrolls sideways at ${width} px: ${o.scrollW} > ${o.clientW}`);
    if (name === "finding") {
      // all five steps on screen, and the status word in view however long the strip is
      const steps = await page.locator(".workflow-step").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
      need(steps.length === 5 && steps.every(([l, r]) => l >= 0 && r <= o.clientW + 1), `at ${width} px all five steps should be on screen: ${JSON.stringify(steps)}`);
      const phase = await page.locator(".strip .phase").boundingBox();
      need(!!phase && phase.x + phase.width <= o.clientW + 1, `at ${width} px the finding's status word should stay on screen`);
    }
    await shot(page, `views-${width}-${name}`);
  }
  await context.close();
}

console.log(JSON.stringify({ out, problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
