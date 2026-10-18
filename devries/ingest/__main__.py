"""python -m devries.ingest [scenario.yaml ...] [--strict] [--missing-only]
python -m devries.ingest --import SOURCE [--name NAME] [--label ID=VALUE ...]

Loads scenario files into FalkorDB (every file in scenarios/ by default), scans
each, and reports where the scan disagrees with the file's `expect` block.

--import takes the tools of a real install: `claude-desktop`, `cursor` or `vscode`
(their config files), a JSON config with an `mcpServers` block, one stdio command
in quotes, a streamable-HTTP URL, or a saved tools/list file. Each stdio server is
launched with a small, named environment (PATH, HOME, the locale, the toolchain
variables; never this app's own secrets), so still only import what you would run.
--no-launch reads the tools/list files an earlier import saved instead, for CI.
The draft it writes has every label `unknown`; label it (here with --label, or in
the UI) before anything is a finding.
"""

import argparse
import asyncio
import sys
from pathlib import Path

import redis.exceptions as rex

from devries.analysis import canary
from devries.config import get_settings
from devries.errors import DeVriesError
from devries.graph import keys
from devries.graph.client import GraphClient, unreachable
from devries.ingest.scenario_loader import load_scenario, read_scenario


async def main(paths: list[Path], strict: bool, missing_only: bool, fail_on: str | None = None) -> int:
    try:
        client = GraphClient()
    except (rex.RedisError, OSError) as e:
        print(unreachable(e))
        return 2
    failed = False
    try:
        check = await canary.ensure(client)
        print(f"canary: {check.detail} ({check.ms} ms)")
        existing = set(await client.list_graphs()) if missing_only else set()
        for path in paths:
            try:
                if missing_only and keys.scenario_key(read_scenario(path).spec.scenario) in existing:
                    print(f"{path.name}: already loaded, skipped")
                    continue
                report = await load_scenario(client, path)
            except DeVriesError as e:
                print(f"{path.name}: FAILED: {e.message}")
                failed = True
                continue
            counts = report.scan.findings
            print(f"{report.scenario}: {sum(report.nodes.values())} nodes, {sum(report.edges.values())} config edges, "
                  f"{sum(f.kind == 'injection' for f in counts)} injection and "
                  f"{sum(f.kind == 'trifecta' for f in counts)} trifecta findings in {report.scan.duration_ms} ms")
            for finding in counts:
                print(f"  {finding.id} {finding.kind}: {' -> '.join(finding.path_ids)}")
            for fid in report.drift:
                print(f"  {fid} drift: a manifest changed since the last load")
            for fid in report.poisoned:
                print(f"  {fid} poisoned_description: a tool description reads as an instruction to the model")
            for problem in report.mismatches:
                print(f"  MISMATCH: {problem}")
            failed = failed or (strict and bool(report.mismatches))
            if fail_on:                                   # a CI gate: exit 1 when a finding of that standing is open
                open_ = [f for f in counts if f.status == "open"]
                if open_:
                    print(f"  FAIL: {len(open_)} open finding(s), and --fail-on {fail_on} was asked for")
                    failed = True
    except DeVriesError as e:
        print(f"FAILED: {e.message}")
        failed = True
    except (rex.RedisError, OSError) as e:
        print(f"FAILED: {unreachable(e)}")
        failed = True
    finally:
        await client.close()
    return 1 if failed else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m devries.ingest", description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--strict", action="store_true", help="exit 1 if a scan disagrees with its expect block")
    parser.add_argument("--missing-only", action="store_true", help="skip scenarios whose graph already exists")
    parser.add_argument("--fail-on", choices=["open"], help="exit 1 if any finding is open after the scan: a gate for CI")
    parser.add_argument("--import", dest="source", help="a client name, a config file, a command, a URL or a tools/list file")
    parser.add_argument("--no-launch", action="store_true",
                        help="with --import: never launch a stdio server; read the tools/list a previous import saved under manifests/, or skip it (for CI)")
    parser.add_argument("--name", help="the scenario name to write (default: import_<client>)")
    parser.add_argument("--label", action="append", default=[], metavar="ID=VALUE",
                        help="a label for the draft: src:<server>=untrusted|internal|private, res:<server>=high|medium|low, res:<server>.external=true|false")
    args = parser.parse_args()
    if args.source:
        from devries.ingest.importer import import_install

        labels = dict(item.split("=", 1) for item in args.label if "=" in item)
        root = get_settings().scenarios_dir.parent
        print(f"importing {args.source}: " + ("no server is launched; saved tools/list files are read" if args.no_launch
                                                   else "each stdio server is launched with a small, named environment"))
        try:
            result = asyncio.run(import_install(args.source, root, args.name, labels, launch=not args.no_launch))
        except DeVriesError as e:
            print(f"FAILED: {e.message}")
            sys.exit(1)
        for reason in result.skipped:
            print(f"  skipped: {reason}")
        print(f"  wrote {result.scenario_path} and {len(result.manifests)} manifest(s): {result.tools} tools from {', '.join(result.servers)}")
        args.paths = [result.scenario_path]
    files = args.paths or sorted(get_settings().scenarios_dir.glob("*.yaml"))
    if not files:
        print("no scenario files found")
        sys.exit(1)
    sys.exit(asyncio.run(main(files, args.strict, args.missing_only, args.fail_on)))
