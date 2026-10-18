// One chart, two renderers: DeVries's own (React Flow, laid out by ELK) and FalkorDB's canvas. The switch
// sits over the chart and remembers the choice per kind of page, so the Explorer and a finding's Path step
// each keep their own until the visitor changes it. FalkorDB's canvas is loaded the first time it is asked for.

import { lazy, Suspense, useEffect, useState } from "react";
import { Loading } from "../ui";
import { Flow, type FlowProps } from "./Flow";

const GraphCanvas = lazy(() => import("./GraphCanvas").then((m) => ({ default: m.GraphCanvas })));

export type Renderer = "devries" | "falkordb";
/** Which kind of page the choice is kept for. */
export type RendererScope = "explorer" | "finding";

export function useRenderer(scope: RendererScope): [Renderer, (r: Renderer) => void] {
  const key = `devries.renderer.${scope}`;
  const [renderer, set] = useState<Renderer>(() => {
    try { return (localStorage.getItem(key) as Renderer) || "devries"; } catch { return "devries"; }
  });
  useEffect(() => { try { localStorage.setItem(key, renderer); } catch { /* a private window */ } }, [key, renderer]);
  return [renderer, set];
}

export function RendererSwitch({ value, onChange, layout, onLayout }: { value: Renderer; onChange: (r: Renderer) => void; layout?: "force" | "tree"; onLayout?: (l: "force" | "tree") => void }) {
  return (
    <div className="renderers">
      <span className="control-group">
        <span className="control">Drawn by</span>
        <div className="pills" role="tablist" aria-label="Renderer">
          <button role="tab" aria-selected={value === "devries"} className={value === "devries" ? "on" : ""} onClick={() => onChange("devries")}>DeVries</button>
          <button role="tab" aria-selected={value === "falkordb"} className={value === "falkordb" ? "on" : ""} onClick={() => onChange("falkordb")}>FalkorDB canvas</button>
        </div>
      </span>
      {value === "falkordb" && onLayout && (
        <span className="control-group">
          <span className="control">Layout</span>
          <div className="pills" role="tablist" aria-label="Canvas layout">
            <button role="tab" aria-selected={layout === "force"} className={layout === "force" ? "on" : ""} onClick={() => onLayout("force")}>Force</button>
            <button role="tab" aria-selected={layout === "tree"} className={layout === "tree" ? "on" : ""} onClick={() => onLayout("tree")}>Tree</button>
          </div>
        </span>
      )}
    </div>
  );
}

/** The chart, drawn by whichever renderer is chosen; the switch is rendered by the page so it can sit with the page's other controls. */
export function Chart({ renderer, layout = "tree", ...props }: FlowProps & { renderer: Renderer; layout?: "force" | "tree" }) {
  if (renderer === "falkordb") {
    return (
      <Suspense fallback={<div className="chart canvas-chart"><Loading label="Loading FalkorDB's canvas" /></div>}>
        <GraphCanvas graph={props.graph} names={props.names} focus={props.focus} only={props.only} layout={layout} picked={props.picked} onPick={props.onPick} height={props.height ?? props.heightRange?.[1] ?? (props.only ? 260 : 460)} />
      </Suspense>
    );
  }
  return <Flow {...props} />;
}
