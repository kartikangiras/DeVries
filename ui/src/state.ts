// Everything the app holds, and the actions that change it. One hook, used once, at the top.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, api, openEvents,
  type CatalogQuery, type Findings, type Graph, type Health, type ImportAnswer, type Layer, type Mitigation, type Overview, type Run, type RunWithSteps, type Scenario, type Scorecard, type Session, type StreamEvent,
} from "./api";
import { go } from "./route";
import { scenarioName } from "./text";

/** Steps of one run from two sources (a fetch and the stream), each step once, in order. */
function mergeSteps(a: RunWithSteps["steps"], b: RunWithSteps["steps"]) {
  return [...new Map([...a, ...b].map((step) => [step.n, step])).values()].sort((x, y) => x.n - y.n);
}

export function useDeVries(scenario: string | null) {
  const [session, setSession] = useState<Session | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [graphs, setGraphs] = useState<Partial<Record<Layer, Graph>>>({});
  const [findings, setFindings] = useState<Findings | null>(null);
  const [mitigations, setMitigations] = useState<Record<string, Mitigation>>({});
  const [configHash, setConfigHash] = useState<string | null>(null);
  const [run, setRun] = useState<RunWithSteps | null>(null);
  const [runList, setRunList] = useState<Run[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [catalog, setCatalog] = useState<CatalogQuery[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  /** Which scenario the loaded state belongs to. Between a switch and its load the pages see nothing, not the old one. */
  const [owner, setOwner] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const wantConfig = useRef(false);
  const live = useRef({ scenario, runId: run?.id ?? null });
  live.current = { scenario, runId: run?.id ?? null };

  const fail = useCallback((error: unknown) => {
    setProblem(error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.");
  }, []);

  // ---- loading

  const loadShell = useCallback(async () => {
    const [info, list, state] = await Promise.all([api.session(), api.scenarios(), api.health()]);
    setSession(info);
    setScenarios(list);
    setHealth(state);
    return list;
  }, []);

  const loadScenario = useCallback(async (name: string) => {
    const [flow, config, found, plans, list, cards, picture] = await Promise.all([
      api.graph(name, "flow"),
      wantConfig.current ? api.graph(name, "config") : Promise.resolve(undefined),
      api.findings(name),
      api.mitigations(name),
      api.runs(name),
      api.scorecard(name),
      api.overview(name).catch(() => null),
    ]);
    if (live.current.scenario !== name) return; // the visitor moved on while this was loading
    setOwner(name);
    setGraphs({ flow, config }); // a config layer that was not refetched is dropped, not left stale
    setScorecard(cards);
    setOverview(picture);
    setFindings(found);
    setMitigations(Object.fromEntries(plans.mitigations.map((m) => [m.id, m])));
    setConfigHash(plans.config_hash);
    setRunList(list);
  }, []);

  const fetching = useRef<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      const now = live.current;
      loadShell().catch(fail);
      if (now.scenario) loadScenario(now.scenario).catch(fail);
    }, 120);
  }, [fail, loadScenario, loadShell]);

  // One request first, alone: it takes the session cookie. Everything else, the stream included, comes after.
  useEffect(() => {
    let close = () => {};
    let boot: string | null = null;
    api.session()
      .then(() => loadShell())
      .then(() => {
        setReady(true);
        close = openEvents(onEvent, setConnected);
        api.queries().then(setCatalog).catch(() => {});
      })
      .catch(fail);

    function onEvent(event: StreamEvent) {
      if (event.type === "hello") {
        if (boot && boot !== event.boot) refreshSoon(); // the server restarted: what we hold may be stale
        boot = event.boot ?? null;
        return;
      }
      if (event.scenario !== live.current.scenario) {
        if (event.type === "scan.finished") loadShell().catch(fail); // another scenario's count changed
        return;
      }
      const data = event.data ?? {};
      switch (event.type) {
        case "agent.run":
          setRun((old) => (old && old.id === data.id ? { ...old, ...data, steps: old.steps } : old && data.status !== "running" ? old : { ...data, steps: [] }));
          setRunList((old) => (old.some((r) => r.id === data.id) ? old.map((r) => (r.id === data.id ? data : r)) : [data, ...old]));
          if (data.status !== "running") refreshSoon(); // waiting, done or failed: the plans it tested are stored now
          break;
        case "agent.step":
          if (live.current.runId !== data.run_id && fetching.current !== data.run_id) {
            // a step of a run this page has not seen start: fetch the run, then keep merging the stream into it
            fetching.current = data.run_id;
            api.run(data.run_id)
              .then((fetched) => setRun((old) => (old && old.id === fetched.id ? { ...fetched, steps: mergeSteps(fetched.steps, old.steps) } : old ?? fetched)))
              .catch(() => {});
          }
          setRun((old) => (old && old.id === data.run_id ? { ...old, steps: mergeSteps(old.steps, [data]) } : old));
          break;
        case "mitigation.proposed":
          setMitigations((old) => ({ ...old, [data.id]: data }));
          break;
        case "scan.finished":
          setScannedAt(event.at ?? Date.now());
          refreshSoon();
          break;
        case "finding.opened":
        case "finding.closed":
        case "finding.accepted":
        case "mitigation.approved":
        case "mitigation.rejected":
        case "mitigation.applied":
        case "draft.written":
          refreshSoon();
          break;
      }
    }
    return () => close();
  }, [fail, loadShell, refreshSoon]);

  // A different scenario: drop what belonged to the old one, then load.
  useEffect(() => {
    if (!ready || !scenario) return;
    setOwner(null);
    setGraphs({});
    setFindings(null);
    setRun(null);
    setRunList([]);
    setMitigations({});
    setConfigHash(null);
    setScannedAt(null);
    setScorecard(null);
    setOverview(null);
    loadScenario(scenario).catch(fail);
    api.runs(scenario)
      .then((list) => (list.length ? api.run(list[0].id) : null))
      .then((latest) => {
        if (latest && live.current.scenario === scenario) setRun((now) => now ?? latest);
      })
      .catch(() => {});
  }, [ready, scenario, loadScenario, fail]);

  // ---- actions

  const act = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
      refreshSoon();
    }
  }, [fail, refreshSoon]);

  const ask = useCallback((question: string) => {
    if (!scenario) return;
    act(async () => {
      const started = await api.ask(scenario, question);
      setRun({ ...started, steps: [] });
      api.run(started.id).then((full) => setRun((old) => (old && old.id === full.id ? { ...full, steps: mergeSteps(full.steps, old.steps) } : old))).catch(() => {});
    });
  }, [act, scenario]);

  const startAudit = useCallback(() => {
    if (!scenario) return;
    act(async () => {
      const started = await api.startAudit(scenario);
      setRun((old) => (old && old.id === started.id ? old : { ...started, steps: [] }));
    });
  }, [act, scenario]);

  /** Approve a plan. The audit run waiting on it applies it; with no run waiting, this applies it. With `write`, the
   *  change is then written to the file the scenario came from, which only a person can ask for. */
  const approve = useCallback((id: string, approver: string, write?: { after: string | null } | null) => {
    if (!scenario) return;
    act(async () => {
      const answer = await api.approve(scenario, id, approver);
      if (!answer.applies.startsWith("the audit run")) await api.apply(scenario, id);
      if (write) await api.writeDraft(scenario, id, approver, write.after);
    });
  }, [act, scenario]);

  /** Import a config or a tools/list, then go to the scenario it made. Returns what the server said. */
  const importConfig = useCallback(async (body: Parameters<typeof api.importConfig>[0]): Promise<ImportAnswer | null> => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api.importConfig(body);
      await loadShell();
      go(answer.scenario);
      return answer;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      setBusy(false);
    }
  }, [fail, loadShell]);

  const setLabels = useCallback((data_sources: Record<string, string>, resources: Record<string, { impact: string; external: boolean }>) => {
    if (scenario) act(() => api.setLabels(scenario, data_sources, resources));
  }, [act, scenario]);

  const acceptFinding = useCallback((id: string, approver: string) => {
    if (scenario) act(() => api.acceptFinding(scenario, id, approver));
  }, [act, scenario]);

  const reject = useCallback((id: string, approver: string, reason: string) => {
    if (scenario) act(() => api.reject(scenario, id, approver, reason));
  }, [act, scenario]);

  const reset = useCallback(() => {
    act(async () => {
      await api.reset();
      setRun(null);
    });
  }, [act]);

  const showRun = useCallback((id: string) => {
    if (live.current.runId !== id) api.run(id).then(setRun).catch(fail);
  }, [fail]);

  /** The config layer is only fetched once a page asks for it; from then on it is kept fresh with the rest. */
  const needConfig = useCallback(() => {
    if (wantConfig.current || !scenario) return;
    wantConfig.current = true;
    api.graph(scenario, "config")
      .then((config) => setGraphs((old) => (old.flow?.scenario === config.scenario ? { ...old, config } : old)))
      .catch(fail);
  }, [fail, scenario]);

  // ---- what the pages read

  // a render between a scenario switch and its load must not show, or fetch for, the scenario just left
  const fresh = owner === scenario;
  const flow = fresh ? graphs.flow : undefined;
  const names = useMemo(
    () => ({ ...(findings?.names ?? {}), ...Object.fromEntries((flow?.nodes ?? []).map((n) => [n.data.id, n.data.name ?? n.data.id])), ...Object.fromEntries((flow?.workflows ?? []).map((w) => [w.id, w.name])) }),
    [findings, flow],
  );
  const plans = useMemo(() => (fresh ? Object.values(mitigations).sort((a, b) => a.created_at - b.created_at) : []), [mitigations, fresh]);
  const openIds = useMemo(() => new Set((fresh ? findings?.findings ?? [] : []).filter((f) => f.status === "open").map((f) => f.id)), [findings, fresh]);
  const current = scenarios.find((s) => s.id === scenario) ?? null;
  /** A scenario's name as people see it: its title if its file gives one, else a name made from its id. */
  const titleOf = useCallback((id: string) => {
    const title = scenarios.find((s) => s.id === id)?.title;
    return title && title !== id ? title : scenarioName(id);
  }, [scenarios]);

  return {
    ready, connected, busy, problem, dismiss: () => setProblem(null),
    session, health, scenarios, current, titleOf, catalog, scannedAt, scorecard: fresh ? scorecard : null, overview: fresh ? overview : null,
    flow, config: fresh ? graphs.config : undefined, needConfig,
    findings: fresh ? findings : null, openIds, names, mitigations: fresh ? mitigations : {}, plans, configHash: fresh ? configHash : null,
    run: fresh ? run : null, runList: fresh ? runList : [], showRun,
    startAudit, ask, approve, acceptFinding, setLabels, reject, reset, importConfig,
  };
}

export type DeVries = ReturnType<typeof useDeVries>;
