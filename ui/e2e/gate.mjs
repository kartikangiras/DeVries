// The gate: the one loop a judge will try, driven in a real browser against the running app. On two scenarios:
// the open findings with a plan already waiting, the finding's five steps (Summary, Rule, Path, Fix, Options:
// the chart on Path only, the approval on Fix only), an approval with a name, the finding closing on the rescan,
// Activity recording the decision, Posture showing the drop, the explorer's tables, the method page, the nav, and Reset. Needs the app
// running; start it without a model key so the run costs nothing.
//
//   node e2e/gate.mjs [app url]                     exits 1 on any failed check; screenshots land in e2e/shots/
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8000";
const shots = fileURLToPath(new URL("./shots", import.meta.url));
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const problems = [];
const withModel = (await (await fetch(`${base}/api/session`)).json()).model?.configured === true;

const origin = new URL(base).origin;
page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
page.on("requestfailed", (r) => { if (!r.url().includes("/api/events")) problems.push("requestfailed: " + r.url()); });
page.on("response", (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
// nothing leaves the machine: no font host, no analytics, no CDN
page.on("request", (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.origin !== origin) problems.push("request to another origin: " + u.origin); });

const texts = (selector) => page.locator(selector).allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
const first = async (selector) => (await texts(selector))[0] ?? "";
const need = (ok, what) => { if (!ok) problems.push(what); };
const shot = async (name) => { await page.mouse.move(700, 3); await page.waitForTimeout(350); await page.screenshot({ path: `${shots}/${name}.png` }); };
const place = (name) => page.locator(".nav-row", { hasText: name });
const step = (name) => page.locator(".workflow-step", { has: page.locator(".workflow-label", { hasText: new RegExp(`^${name}$`) }) });
/** The hops are folded under the chart, open by default; a visitor may have closed one, so make sure every fold is open. */
const unfold = async () => { await page.waitForSelector(".hops-fold", { state: "attached" }); for (const fold of await page.locator(".hops-fold").all()) if (!(await fold.evaluate((d) => d.open))) await fold.locator("summary").click(); };

const out = {};
for (const [scenario, fix, cut] of [["acme_support", "gate one call", "set gate = human_approval"], ["acme_exec", "quarantine one delegation", "set gate = quarantine"]]) {
  const r = (out[scenario] = {});

  // the posture is the home: the sentence, the figures, every block filled
  await page.goto(`${base}/#/${scenario}`);
  await page.waitForSelector(".figures dd", { timeout: 240000 });
  await page.waitForSelector(".riskflow .river", { state: "attached", timeout: 60000 });   // the picture arrives with the scenario, the figures with the posture
  r.posture = await first(".page-head h1");
  r.postureFigures = await texts(".figures dd");
  r.scansBefore = await page.locator(".scans .scan").count();
  need(r.postureFigures.length === 5, `${scenario}: the posture should open on five figures, got ${r.postureFigures}`);
  need((await page.locator(".bars li").count()) >= 2, `${scenario}: the posture should draw the blast radius and the exposure as bars`);
  need((await page.locator(".chokes li").count()) >= 1, `${scenario}: the posture should rank the choke points`);
  // the Rule of Two is open by default, above the history; its cards are there without a click
  await page.waitForSelector(".tally-card");
  need(await page.locator(".posture-tally").evaluate((d) => d.open), `${scenario}: the Rule of Two should be open by default`);
  need((await page.locator(".bars-key").count()) === 2, `${scenario}: each bar chart should carry a key`);
  await page.locator(".posture-owasp summary").click();
  await page.waitForSelector(".owasp-code");
  need((await page.locator(".owasp-code").count()) === 10, `${scenario}: the posture should list the ten OWASP classes under its fold`);
  need((await page.locator(".cut-line").count()) === 1, `${scenario}: the posture should say the cheapest cut in one line`);
  need((await page.locator(".riskflow .river").count()) >= 1 && (await page.locator(".riskflow .rcard").count()) >= 3, `${scenario}: the posture should draw the open paths between cards`);
  need((await page.locator(".riskflow .river .token").count()) >= 1, `${scenario}: the open paths should carry tokens`);
  await shot(`${scenario}-0-posture`);

  await place("Open").click();
  await page.waitForSelector(".case");
  // the audit ran at start: the row is already waiting for a person, with the recommendation as a figure
  await page.waitForSelector(".case .phase.t-amber", { timeout: 240000 });
  await page.waitForSelector(".case .transform-to");
  r.title = await first(".page-head h1");
  r.openBefore = await page.locator(".case.status-open").count();
  r.inboxCount = await place("Open").locator(".nav-count").innerText();
  r.session = await first(".session");
  // the badge speaks for the newest run: the start-up pass is scripted, so a configured model is only "ready"
  need(withModel ? /Model ready|Model · /.test(r.session) : /Scripted · no model/.test(r.session), `${scenario}: the model pill should say what drove the newest run: ${r.session}`);
  r.recommended = await first(".case .transform-to");
  r.next = await first(".case .case-next");
  need(/ open\.$/.test(r.title), `${scenario}: the list does not say how many findings are open: ${r.title}`);
  need(Number(r.inboxCount) === r.openBefore && r.openBefore > 0, `${scenario}: the inbox count and its rows disagree`);
  need(r.recommended === fix, `${scenario}: expected the plan "${fix}", got "${r.recommended}"`);
  need(/approve the fix/.test(r.next), `${scenario}: the row should say the next step is a person's approval: ${r.next}`);
  need((await page.getByRole("button", { name: "Run audit" }).count()) === 0, `${scenario}: a second audit should not be on offer while one waits`);
  need((await place("Open").locator(".nav-count.alert").count()) === 1, `${scenario}: the inbox count should say something waits for a person`);
  await shot(`${scenario}-1-inbox`);

  // step 1, the summary: the brief, the path in words, the figures; no chart, nothing about a fix yet
  await page.locator(".case").first().click();
  await page.waitForSelector(".brief-title");
  await page.waitForSelector(".path-words");
  r.finding = await first(".brief-title");
  r.tldr = await first(".tldr p");
  r.words = await texts(".path-words li");
  r.summaryFigures = await texts(".figures dd");
  r.takeaway = await first(".takeaway");
  r.workflow = await texts(".workflow-step .workflow-label");
  need(r.workflow.join() === "Summary,Rule,Path,Fix,Options", `${scenario}: the finding should be worked through in five steps, got ${r.workflow}`);
  need(r.words.length >= 1 && r.words.every((w) => /→/.test(w)), `${scenario}: the summary should give the path in words: ${r.words}`);
  need(r.summaryFigures.length >= 5, `${scenario}: the summary should carry its figures, got ${r.summaryFigures}`);
  need((await page.locator(".chart").count()) === 0, `${scenario}: the chart belongs to the path step, not the summary`);
  need((await page.locator(".approval").count()) === 0, `${scenario}: the approval belongs to the fix step, not the summary`);
  r.cited = await page.locator(".tldr sup.ref").count();
  need(r.cited >= 4, `${scenario}: the brief cites ${r.cited} pieces of evidence`);
  need(/brief as Markdown/.test(r.takeaway) && /OWASP ASI0\d/.test(r.takeaway), `${scenario}: the rail should offer the brief and name the OWASP class: ${r.takeaway}`);
  const brief = await page.request.get(`${base}/api/scenarios/${scenario}/findings/${await page.evaluate(() => location.hash.split("/")[3])}/brief.md`);
  need(brief.ok() && /^# /.test(await brief.text()), `${scenario}: the brief should download as Markdown`);
  r.state = await first(".strip .phase");
  need(r.state === "AWAITING APPROVAL", `${scenario}: the finding should be awaiting a person, got ${r.state}`);
  await shot(`${scenario}-2-summary`);
  // a footnote opens the path with that card lit
  await page.locator(".tldr sup.ref").first().click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  need(/\/path$/.test(await page.evaluate(() => location.hash)), `${scenario}: a footnote should open the path step: ${await page.evaluate(() => location.hash)}`);
  need((await page.locator(".evidence li.lit").count()) === 1, `${scenario}: a footnote marker did not mark its evidence row`);
  need((await page.locator(".chart .fcard.picked").count()) === 1, `${scenario}: a footnote marker did not mark its card on the chart`);

  // step 2, the rule: which rule fired and what satisfies each of its needs; the analysis; no chart
  await step("Rule").click();
  await page.waitForSelector(".rule-needs li");
  r.rule = await first(".brief-title");
  r.needs = await texts(".rule-needs li");
  r.analysis = await texts(".analysis-rows li");
  need(/^Check [12]/.test(r.rule), `${scenario}: the rule step should name the check: ${r.rule}`);
  need(r.needs.length === 4, `${scenario}: the rule has four needs, got ${r.needs.length}`);
  if (scenario === "acme_exec") {
    r.grid = await texts(".rot-row[data-agent] .rot-agent");
    need(r.grid.length >= 1 && r.grid.every((a) => /of three|all three/.test(a)), `${scenario}: the Rule of Two grid should count each agent's properties: ${r.grid}`);
  }
  need(r.analysis.length >= 2 && r.analysis.some((a) => /OWASP/.test(a)), `${scenario}: the analysis should name the OWASP class: ${r.analysis}`);
  need((await page.locator(".chart").count()) === 0 && (await page.locator(".approval").count()) === 0, `${scenario}: the rule step draws nothing and decides nothing`);
  await shot(`${scenario}-2b-rule`);

  // step 3, the path: the one chart on both renderers, the hops with their rules, the queries, the way into the explorer
  await step("Path").click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  r.cards = await page.locator(".chart .fcard").count();
  r.evidence = await page.locator(".evidence li").count();
  need(r.evidence === r.cards && r.cards >= 5, `${scenario}: the chart draws ${r.cards} cards and the rail cites ${r.evidence}`);
  await unfold();
  await page.waitForSelector(".hops li");
  r.hops = await texts(".hops li");
  r.restsOn = await texts(".rests-on li");
  need(r.hops.every((h) => /(cut by|cannot be cut|no fix yet|blocked by)/.test(h)), `${scenario}: a hop row does not say whether it can be cut`);
  need(r.restsOn.length === 2 && r.restsOn.every((q) => /algo\./.test(q)), `${scenario}: the queries a finding rests on should name their algorithm`);
  need(/explorer\/fnd/.test(await page.locator(".chart-link").getAttribute("href")), `${scenario}: the path should open in the explorer with itself lit`);
  need((await page.locator(".fold.source").count()) === 0, `${scenario}: the path step should not explain itself; the method page does`);
  await page.getByRole("tab", { name: "FalkorDB canvas" }).click();
  await page.waitForSelector("falkordb-canvas");
  await page.waitForTimeout(1200);
  need(/FalkorDB's canvas/.test(await first(".canvas-chart .chart-over")), `${scenario}: the canvas renderer should say what it is`);
  await shot(`${scenario}-2c-path-canvas`);
  await page.getByRole("tab", { name: "DeVries" }).click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  await shot(`${scenario}-2d-path`);

  // step 4, the fix: the verdict in figures, the change, the path after as the sandbox reads it, and the one decision
  await step("Fix").click();
  await page.waitForSelector(".approval");
  await page.waitForSelector(".drafted .patch");
  await page.waitForSelector(".hops-after li.changed", { timeout: 60000 });
  r.figures = await texts(".figures dd");
  need(r.figures.length >= 4, `${scenario}: the fix should be summed up in figures, got ${r.figures}`);
  need(/^[A-Z]/.test(await first(".brief-title")), `${scenario}: the fix step's title should start with a capital: ${await first(".brief-title")}`);
  r.change = await first(".approval .approval-change");
  r.numbers = await first(".approval .approval-numbers");
  r.patch = await texts(".drafted .patch");
  r.after = await texts(".hops-after li.changed .now");
  need(r.patch.length >= 1 && r.patch[0].includes(cut), `${scenario}: the drafted change does not show the literal change`);
  need(/resolves \d+ · introduces 0 · breaks 0/.test(r.numbers), `${scenario}: the approval bar does not carry the sandbox verdict`);
  need(r.after.some((t) => /gated|quarantined|gone/.test(t)), `${scenario}: the path after should say what the plan does to a hop: ${r.after}`);
  need(/sandbox/.test(await first(".path-after .chart-note")), `${scenario}: the path after should say it was read from a sandbox`);
  need((await page.locator(".chart").count()) === 0, `${scenario}: the fix step reads the path as hops, it does not draw it again`);
  await page.locator(".approval-see").click();
  await page.waitForSelector(".approval-draft .draft-diff");
  r.draftPath = await first(".approval-draft .draft-path");
  r.draftAdds = await texts(".approval-draft .draft-diff .add");
  need(r.draftPath.endsWith(`${scenario}.yaml`), `${scenario}: the draft should be a change to the scenario file, got ${r.draftPath}`);
  need(r.draftAdds.some((l) => l.includes(cut.replace("set gate = ", "gate: "))), `${scenario}: the diff should add the gate: ${r.draftAdds}`);
  need(!(await page.locator(".draft-write input[type=checkbox]").isChecked()), `${scenario}: writing the file must be opt-in`);
  need(/Approve · Apply$/.test(await first(".approval .approve")), `${scenario}: with the box unticked the button must not say Write`);
  await shot(`${scenario}-3-fix`);
  await page.locator(".approval-see").click();

  // step 5, the options: every plan that was tried as one chart, with its verdict; any of them can be read on the fix step
  await step("Options").click();
  await page.waitForSelector(".tested .verdict");
  need((await page.locator(".tested .verdict .bar").count()) === (await page.locator(".tested .verdict").count()), `${scenario}: every plan should carry its cost as a bar`);
  need((await page.locator(".tested .verdict .cell.closed").count()) >= 1, `${scenario}: the plan chart should show which plan closes this finding`);
  r.failed = await texts(".tested .verdict.fail");
  r.passed = await texts(".tested .verdict.pass");
  need(r.passed.length >= 1 && (withModel || r.failed.length >= 2), `${scenario}: expected rejected and passing verdict rows, got ${r.failed.length} and ${r.passed.length}`);
  need(r.failed.every((v) => /(breaks|leaves open)/.test(v)), `${scenario}: a rejected plan does not say why`);
  need((await page.locator(".approval").count()) === 0 && (await page.locator(".chart").count()) === 0, `${scenario}: the options step decides nothing and draws nothing`);
  if (r.failed.length) {
    await page.locator(".tested .verdict.fail .verdict-why .link").first().click();
    await page.waitForSelector(".reading-other");
    need(/failed its sandbox/.test(await first(".brief-title")), `${scenario}: reading a failed plan should say so on the fix step`);
    need((await page.locator(".approval").count()) === 1, `${scenario}: the decision on the recommended plan stays while another is read`);
    await page.locator(".reading-other .link").click();
  }
  await shot(`${scenario}-4-options`);

  await step("Fix").click();
  await page.waitForSelector(".approval");
  await page.getByLabel("Your name").fill("Kartik");
  await page.getByRole("button", { name: "Approve · Apply" }).click();
  await page.waitForSelector(".applied", { timeout: 240000 });
  r.stateAfter = await first(".strip .phase");
  r.applied = await texts(".applied .fired li");
  need(r.stateAfter === "MITIGATED", `${scenario}: the finding should be mitigated, got ${r.stateAfter}`);
  need(r.applied.length >= 3 && /Approved by Kartik/.test(r.applied[0]), `${scenario}: what happened after Approve is not listed`);
  need((await page.locator(".approval").count()) === 0, `${scenario}: the approval bar should leave once a person has decided`);
  need(/Your sandbox copy/.test(await first(".session-name")), `${scenario}: approving should have made a sandbox copy for this session`);
  await step("Summary").click();
  await page.waitForSelector(".tldr p");
  need(/no longer holds/.test(await first(".tldr p")), `${scenario}: the brief of a closed finding should say it no longer holds`);
  await step("Path").click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  await page.waitForSelector(".chart .wire.gated", { state: "attached", timeout: 60000 }).catch(() => problems.push(`${scenario}: the chart does not show the hop as blocked`));
  await unfold();
  await page.waitForSelector(".hops li.blocked");
  r.blockedHop = await first(".hops li.blocked");
  await shot(`${scenario}-5-applied`);

  // nothing open: the list says so, and the finding is under Closed
  await place("Open").click();
  await page.waitForFunction(() => document.querySelector(".page-head h1")?.textContent === "Nothing open.", null, { timeout: 240000 });
  need((await page.getByRole("button", { name: "Run audit" }).count()) === 0, `${scenario}: with nothing open there is nothing to audit`);
  await place("Closed").click();
  await page.waitForSelector(".case.status-mitigated");
  r.mitigated = await page.locator(".case.status-mitigated").count();
  need(r.mitigated >= 1, `${scenario}: the closed finding is not listed under Closed`);

  // the posture after the fix: one more scan, so the history (drawn once there are two scans) shows the drop, nothing exposed
  await place("Posture").click();
  await page.waitForSelector(".figures dd", { timeout: 240000 });
  await page.waitForFunction((before) => document.querySelectorAll(".scans .scan").length > before, r.scansBefore, { timeout: 240000 });
  r.scansAfter = await texts(".scans .scan .scan-n");
  r.postureAfter = await texts(".figures dd");
  need(r.scansAfter[r.scansAfter.length - 1] === "0", `${scenario}: the latest scan should show nothing open: ${r.scansAfter}`);
  need(r.postureAfter[0] === "0", `${scenario}: the posture should count no open finding after the fix: ${r.postureAfter}`);
  await shot(`${scenario}-6-posture-after`);

  // activity: the scan, the run, the plans, the decision and the application, in order; the run opens to its trace and its report cites its steps
  await place("Activity").click();
  await page.waitForSelector(".activity-row", { timeout: 240000 });
  await page.waitForSelector(".activity-row.kind-applied", { timeout: 240000 });
  r.kinds = [...new Set((await page.locator(".activity-row .activity-kind").allInnerTexts()).map((k) => k.trim().toLowerCase()))];   // innerText carries the uppercase the style gives it
  r.decision = await first(".activity-row.kind-decision");
  need(["scan", "run", "proposed", "decision", "applied"].every((k) => r.kinds.includes(k)) && (withModel || r.kinds.includes("tested")), `${scenario}: activity should hold every kind of line, got ${r.kinds}`);
  need(/Kartik/.test(r.decision) && /APPROVED/.test(r.decision), `${scenario}: the decision line should name who decided: ${r.decision}`);
  need(/fix$/.test(await page.locator(".activity-row.kind-decision a").first().getAttribute("href")), `${scenario}: a decision should link to its finding's fix step`);
  if ((await page.locator(".activity-trace").count()) === 0) await page.locator(".kind-run .link-plain").first().click();   // the latest run opens by itself
  await page.waitForSelector(".activity-trace .report", { timeout: 60000 });
  r.report = await first(".report .report-text");
  const markers = await texts(".report-text sup.ref");
  const rows = await page.locator(".report-cites li").count();
  r.citations = { markers: markers.length, rows };
  need(markers.length > 0 && rows > 0, `${scenario}: the report carries no citations`);
  need(markers.every((m) => Number(m.replace(/\D/g, "")) <= rows), `${scenario}: a citation marker has no row`);
  await page.locator(".report-text sup.ref").first().click();
  need((await page.locator(".trace-row.lit").count()) === 1, `${scenario}: a citation did not mark the step it came from`);
  need((await page.locator(".trace-row .verdict").count()) >= (withModel ? 1 : 3), `${scenario}: the trace folds the sandbox verdicts away`);
  await shot(`${scenario}-7-activity`);

  // the explorer's tables: every kind of thing, a row each, and the servers with their test
  await place("Explorer").click();
  await page.getByRole("tab", { name: "Tables" }).click();
  await page.waitForSelector(".inventory .table tbody tr", { timeout: 60000 });
  r.inventory = await page.locator(".inventory .table tbody tr").count();
  need(r.inventory >= 1, `${scenario}: the tables should list the agents`);
  await page.getByRole("tab", { name: /Servers/ }).click();
  await page.waitForSelector(".servers .table tbody tr", { timeout: 60000 });
  need((await page.locator(".servers .table tbody tr").count()) >= 1, `${scenario}: the tables should list the servers`);
  await shot(`${scenario}-8-tables`);
  // the method page: the rules with their statements, and the catalog
  await place("Method").click();
  await page.waitForSelector(".method-block .statement .cypher", { timeout: 60000 });
  need((await page.locator(".method-block").count()) >= 4, `${scenario}: the method page should open on the rules`);
  await page.getByRole("tab", { name: /^Queries/ }).click();
  await page.waitForSelector(".catalog .cypher", { timeout: 60000 });
  need((await page.locator(".catalog-group a").count()) > 50, `${scenario}: the method page should list the whole catalog`);
  await shot(`${scenario}-9-method`);
}

// the nav, in its three groups
out.nav = await texts(".nav-row .nav-label");
out.groups = await texts(".nav-group-label");
need(out.nav.join() === "Posture,Open,Closed,Explorer,Method,Activity,Import", `the nav should hold seven places, got ${out.nav}`);
need(out.groups.join().toLowerCase() === "findings,system,record", `the nav should be in three groups, got ${out.groups}`);

// Reset gives the shared scenarios back
await page.getByRole("button", { name: "Reset" }).click();
await page.waitForFunction(() => document.querySelector(".session-name")?.textContent === "Shared scenario", null, { timeout: 240000 });
await place("Open").click();
await page.waitForSelector(".case.status-open");
out.afterReset = await first(".page-head h1");

console.log(JSON.stringify({ out, problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
