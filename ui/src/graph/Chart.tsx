// One chart, two renderers: DeVries's own (React Flow, laid out by ELK) and FalkorDB's canvas. The switch
// sits over the chart and remembers the choice for the session, so every chart on every page shows the
// same way until the visitor changes it.

import { useEffect, useState } from "react";
import { Flow, type FlowProps } from "./Flow";
import { GraphCanvas } from "./GraphCanvas";

export type Renderer = "devries" | "falkordb";
const KEY = "devries.renderer";

export function useRenderer(): [Renderer, (r: Renderer) => void] {
  const [renderer, set] = useState<Renderer>(() => {
    try { return (localStorage.getItem(KEY) as Renderer) || "devries"; } catch { return "devries"; }
  });
  useEffect(() => { try { localStorage.setItem(KEY, renderer); } catch { /* a private window */ } }, [renderer]);
  return [renderer, set];
}

export function RendererSwitch({ value, onChange, layout, onLayout }: { value: Renderer; onChange: (r: Renderer) => void; layout?: "force" | "tree"; onLayout?: (l: "force" | "tree") => void }) {
  return (
    <div className="renderers">
      <span className="control">Drawn by</span>
      <div className="pills" role="tablist" aria-label="Renderer">
        <button role="tab" aria-selected={value === "devries"} className={value === "devries" ? "on" : ""} onClick={() => onChange("devries")}>DeVries</button>
        <button role="tab" aria-selected={value === "falkordb"} className={value === "falkordb" ? "on" : ""} onClick={() => onChange("falkordb")}>FalkorDB canvas</button>
      </div>
      {value === "falkordb" && onLayout && (
        <>
          <span className="control">Layout</span>
          <div className="pills" role="tablist" aria-label="Canvas layout">
            <button role="tab" aria-selected={layout === "force"} className={layout === "force" ? "on" : ""} onClick={() => onLayout("force")}>Force</button>
            <button role="tab" aria-selected={layout === "tree"} className={layout === "tree" ? "on" : ""} onClick={() => onLayout("tree")}>Tree</button>
          </div>
        </>
      )}
    </div>
  );
}

/** The chart, drawn by whichever renderer is chosen; the switch is rendered by the page so it can sit with the page's other controls. */
export function Chart({ renderer, layout = "force", ...props }: FlowProps & { renderer: Renderer; layout?: "force" | "tree" }) {
  if (renderer === "falkordb") {
    return <GraphCanvas graph={props.graph} names={props.names} focus={props.focus} only={props.only} layout={layout} picked={props.picked} onPick={props.onPick} height={props.height ?? 460} />;
  }
  return <Flow {...props} />;
}
