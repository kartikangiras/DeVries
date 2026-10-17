// One page, one answer: a page asks the API for what only it shows, and asks again when what it depends on moves.

import { useEffect, useState, type DependencyList } from "react";

export type Fetched<T> = { data: T | null; error: string | null; loading: boolean };

/** Load `load()` when `deps` change; an answer that arrives after the deps moved on is dropped. `load` may be null to wait. */
export function useFetch<T>(load: (() => Promise<T>) | null, deps: DependencyList): Fetched<T> {
  const [state, setState] = useState<Fetched<T>>({ data: null, error: null, loading: !!load });
  useEffect(() => {
    if (!load) return;
    let wanted = true;
    setState((old) => ({ ...old, loading: true, error: null }));
    load()
      .then((data) => wanted && setState({ data, error: null, loading: false }))
      .catch((e) => wanted && setState({ data: null, error: e instanceof Error ? e.message : "The request failed.", loading: false }));
    return () => {
      wanted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
