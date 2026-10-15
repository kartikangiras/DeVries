// The Day 2 gate, from the browser: on each scenario the audit the app ran at start has found the
// finding, tested fixes in sandbox graphs and proposed a verified one; after Approve the finding
// closes. The finding is worked through in its three steps: the problem, the fix, the options.
// Drives the built UI in the Chrome installed on this machine, headless. Needs the app running.
//
//   node e2e/gate.mjs [app url]                     screenshots land in e2e/shots/
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
// the page asks no third party for anything: fonts, scripts and styles all come from the app
page.on("request", (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.origin !== origin) problems.push("request to another origin: " + u.origin); });

const texts = (selector) => page.locator(selector).allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
const first = async (selector) => (await texts(selector))[0] ?? "";
const need = (ok, what) => { if (!ok) problems.push(what); };
const shot = async (name) => { await page.mouse.move(700, 3); await page.waitForTimeout(350); await page.screenshot({ path: `${shots}/${name}.png` }); };
const place = (name) => page.locator(".nav-row", { hasText: name });
const step = (name) => page.locator(".workflow-step", { hasText: name });
// the hop tables are folded under the chart; a trifecta has one per path
const unfold = async () => { await page.waitForSelector(".hops-fold", { state: "attached" }); for (const fold of await page.locator(".hops-fold").all()) if (!(await fold.evaluate((d) => d.open))) await fold.locator("summary").click(); };

const out = {};
for (const [scenario, fix, cut] of [["acme_support", "gate one call", "set gate = human_approval"], ["acme_exec", "quarantine one delegation", "set gate = quarantine"]]) {
  const r = (out[scenario] = {});
  await page.goto(`${base}/#/${scenario}`);
  await page.waitForSelector(".case");
  // the audit ran at start: the row is already waiting for a person, with the recommendation as a figure
  await page.waitForSelector(".case .phase.t-amber", { timeout: 240000 });
  await page.waitForSelector(".case .transform-to");
  r.title = await first(".page-head h1");
  r.openBefore = await page.locator(".case.status-open").count();
  r.inboxCount = await place("Inbox").locator(".nav-count").innerText();
  r.session = await first(".session");
  r.recommended = await first(".case .transform-to");
  r.next = await first(".case .case-next");
  need(/on your desk/.test(r.title), `${scenario}: the inbox does not say what is on the desk`);
  need(Number(r.inboxCount) === r.openBefore && r.openBefore > 0, `${scenario}: the inbox count and its rows disagree`);
  need(r.recommended === fix, `${scenario}: expected the plan "${fix}", got "${r.recommended}"`);
  need(/approve mit:/.test(r.next), `${scenario}: the row should say the next step is a person's approval`);
  need((await page.getByRole("button", { name: "Run audit" }).count()) === 0, `${scenario}: a second audit should not be on offer while one waits`);
  need((await place("Inbox").locator(".nav-count.alert").count()) === 1, `${scenario}: the inbox count should say something waits for a person`);
  need((await page.locator(".case .owasp").count()) === r.openBefore, `${scenario}: each open row should carry its OWASP class`);
  await shot(`${scenario}-1-inbox`);

  // step 1, the problem: the brief, the path on Cistern's chart, the evidence it cites, the hops, the analysis
  await page.locator(".case").first().click();
  await page.waitForSelector(".brief-title");
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  await page.waitForSelector(".approval");
  await unfold();
  await page.waitForSelector(".hops li");
  r.finding = await first(".brief-title");
  r.tldr = await first(".tldr p");
  r.hops = await texts(".hops li");
  r.cards = await page.locator(".chart .fcard").count();
  r.evidence = await page.locator(".evidence li").count();
  r.restsOn = await texts(".rests-on li");
  r.takeaway = await first(".takeaway");
  r.analysis = await texts(".analysis-rows li");
  r.workflow = await texts(".workflow-step .workflow-label");
  need(r.workflow.join() === "Problem,Fix,Options,Trace", `${scenario}: the finding should be worked through in three steps and a trace, got ${r.workflow}`);
  need(r.hops.every((h) => /(cut by|cannot be cut|no fix yet|blocked by)/.test(h)), `${scenario}: a hop row does not say whether it can be cut`);
  need(r.evidence === r.cards && r.cards >= 5, `${scenario}: the chart draws ${r.cards} cards and the rail cites ${r.evidence}`);
  r.cited = await page.locator(".tldr sup.ref").count();
  need(r.cited >= 4 && r.cited <= r.evidence, `${scenario}: the brief cites ${r.cited} of ${r.evidence} pieces of evidence`);
  need(r.restsOn.length === 2 && r.restsOn.every((q) => /algo\./.test(q)), `${scenario}: the queries a finding rests on should name their algorithm`);
  need(/Source: the flow layer/.test(await first(".chart-note")), `${scenario}: the chart has no source note`);
  need(/brief as Markdown/.test(r.takeaway) && /OWASP ASI0\d/.test(r.takeaway), `${scenario}: the rail should offer the brief and name the OWASP class: ${r.takeaway}`);
  need(r.analysis.length >= 2 && r.analysis.some((a) => /Rule of Two/.test(a)) && r.analysis.some((a) => /OWASP/.test(a)), `${scenario}: the analysis should read the agents against the Rule of Two and name the OWASP class: ${r.analysis}`);
  const brief = await page.request.get(`${base}/api/scenarios/${scenario}/findings/${await page.evaluate(() => location.hash.split("/").pop())}/brief.md`);
  need(brief.ok() && /^# /.test(await brief.text()), `${scenario}: the brief should download as Markdown`);
  await page.locator(".tldr sup.ref").first().click();
  need((await page.locator(".evidence li.lit").count()) === 1, `${scenario}: a footnote marker did not mark its evidence row`);
  need((await page.locator(".chart .fcard.picked").count()) === 1, `${scenario}: a footnote marker did not mark its card on the chart`);
  await page.waitForSelector(".chart .cut-mark", { timeout: 60000 }).catch(() => problems.push(`${scenario}: the chart does not mark where the fix cuts`));
  // the same path on FalkorDB's canvas, then back
  await page.getByRole("tab", { name: "FalkorDB canvas" }).click();
  await page.waitForSelector("falkordb-canvas");
  await page.waitForTimeout(1200);
  need(/FalkorDB's canvas/.test(await first(".canvas-chart .chart-over")), `${scenario}: the canvas renderer should say what it is`);
  await shot(`${scenario}-2-finding-canvas`);
  await page.getByRole("tab", { name: "Cistern" }).click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  await shot(`${scenario}-2-finding`);

  r.state = await first(".strip .phase");
  need(r.state === "AWAITING NOD", `${scenario}: the finding should be awaiting a person, got ${r.state}`);

  // step 2, the fix: the drafted change, the preview with the plan applied, the change to the file in the bar
  await step("Fix").click();
  await page.waitForSelector(".drafted .patch");
  await page.waitForSelector(".after .chart .wire.gated", { state: "attached", timeout: 60000 });
  r.change = await first(".approval .approval-change");
  r.numbers = await first(".approval .approval-numbers");
  r.patch = await texts(".drafted .patch");
  r.provenance = await first(".drafted .provenance");
  need(r.patch.length >= 1 && r.patch[0].includes(cut), `${scenario}: the drafted change does not show the literal change`);
  need(/resolves \d+ · introduces 0 · breaks 0/.test(r.numbers), `${scenario}: the approval bar does not carry the sandbox verdict`);
  need(/sandbox/.test(await first(".after .chart-note")), `${scenario}: the preview should say it was read from a sandbox`);
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

  // step 3, the options: every plan that was tried, with its verdict; the what-if line; the cut as rules
  await step("Options").click();
  await page.waitForSelector(".tested .verdict");
  await page.waitForSelector(".cut-block", { timeout: 60000 });
  await page.waitForSelector(".servers", { timeout: 60000 });
  r.failed = await texts(".tested .verdict.fail");
  r.passed = await texts(".tested .verdict.pass");
  // a scripted run tries every candidate cheapest first, so revokes fail before the gate passes; a model may go straight to the plan that passes
  need(r.passed.length >= 1 && (withModel || r.failed.length >= 2), `${scenario}: expected rejected and passing verdict rows, got ${r.failed.length} and ${r.passed.length}`);
  need(r.failed.every((v) => /(breaks|leaves open)/.test(v)), `${scenario}: a rejected plan does not say why`);
  need((await page.locator(".whatif-line").count()) === 1 && (await page.locator(".cut-block").count()) === 1 && (await page.locator(".servers").count()) === 1, `${scenario}: the options should hold the what-if line, the cut and the servers`);
  await shot(`${scenario}-4-options`);

  // the trace behind the brief: every step, who decided it, and the verdicts unfolded
  await step("Trace").click();
  await page.waitForSelector(".trace-row");
  r.driver = await first(".run-driver");
  r.steps = await page.locator(".trace-row").count();
  need(r.steps >= 6, `${scenario}: the trace shows ${r.steps} steps`);
  need((await page.locator(".trace-row .verdict").count()) >= (withModel ? 1 : 3), `${scenario}: the trace folds the sandbox verdicts away`);
  await step("Fix").click();

  await page.getByLabel("Your name").fill("Kartik");
  await page.getByRole("button", { name: "Approve · Apply" }).click();
  await page.waitForSelector(".applied", { timeout: 240000 });
  r.stateAfter = await first(".strip .phase");
  r.applied = await texts(".applied .fired li");
  need(r.stateAfter === "MITIGATED", `${scenario}: the finding should be mitigated, got ${r.stateAfter}`);
  need(r.applied.length >= 3 && /Approved by Kartik/.test(r.applied[0]), `${scenario}: what happened after Approve is not listed`);
  need((await page.locator(".approval").count()) === 0, `${scenario}: the approval bar should leave once a person has decided`);
  need(/Your sandbox copy/.test(await first(".session-name")), `${scenario}: approving should have made a sandbox copy for this session`);
  await step("Problem").click();
  await page.waitForSelector(".chart .fcard", { timeout: 60000 });
  await unfold();
  await page.waitForSelector(".hops li.blocked");
  r.blockedHop = await first(".hops li.blocked");
  need((await page.locator(".chart .wire.gated").count()) >= 1, `${scenario}: the chart does not show the hop as blocked`);
  need(/no longer holds/.test(await first(".tldr p")), `${scenario}: the brief of a closed finding should say it no longer holds`);
  await shot(`${scenario}-5-applied`);

  // nothing open: the inbox says so, and the finding is under Done
  await place("Inbox").click();
  await page.waitForFunction(() => document.querySelector(".page-head h1")?.textContent === "Inbox zero.", null, { timeout: 240000 });
  need((await page.getByRole("button", { name: "Run audit" }).count()) === 0, `${scenario}: with nothing open there is nothing to audit`);
  await shot(`${scenario}-6-inbox-zero`);
  await place("Done").click();
  await page.waitForSelector(".case.status-mitigated");
  r.mitigated = await page.locator(".case.status-mitigated").count();
  need(r.mitigated >= 1, `${scenario}: the closed finding is not listed under Done`);

  // the audit log: the run's report cites the steps its ids came from
  await place("Runs").click();
  await page.waitForSelector(".report");
  r.report = await first(".report .report-text");
  r.byline = await first(".report .byline");
  const markers = await texts(".report-text sup.ref");
  const rows = await page.locator(".report-cites li").count();
  r.citations = { markers: markers.length, rows };
  need(markers.length > 0 && rows > 0, `${scenario}: the report carries no citations`);
  need(markers.every((m) => Number(m.replace(/\D/g, "")) <= rows), `${scenario}: a citation marker has no row`);
  await page.locator(".report-text sup.ref").first().click();
  need((await page.locator(".trace-row.lit").count()) === 1, `${scenario}: a citation did not mark the step it came from`);
  await shot(`${scenario}-7-audit`);

  // the ledger: every plan that was tested, the applied one among them
  await place("Ledger").click();
  await page.waitForSelector(".ledger .table tbody tr");
  r.ledger = await texts(".ledger .table tbody tr");
  need(r.ledger.some((row) => /APPLIED/.test(row)) && (withModel || r.ledger.some((row) => /FAILED/.test(row))), `${scenario}: the ledger should hold the applied plan and the ones that failed`);
  await shot(`${scenario}-8-fixes`);
}

// the nav, in its four groups
out.nav = await texts(".nav-row .nav-label");
out.groups = await texts(".nav-group-label");
need(out.nav.join() === "Inbox,Done,Ledger,What if,Graph,Servers,Queries,Runs,Import", `the nav should hold nine places, got ${out.nav}`);
need(out.groups.join().toLowerCase() === "findings,fixes,system,audit", `the nav should be in four groups, got ${out.groups}`);

// Reset gives the shared scenarios back
await page.getByRole("button", { name: "Reset" }).click();
await page.waitForFunction(() => document.querySelector(".session-name")?.textContent === "Shared scenario", null, { timeout: 240000 });
await place("Inbox").click();
await page.waitForSelector(".case.status-open");
out.afterReset = await first(".page-head h1");

console.log(JSON.stringify({ out, problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
