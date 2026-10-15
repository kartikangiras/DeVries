"""python -m devries.apply --scenario NAME --mitigation mit:... [--yes] [--as WHO]

Write a tested plan to the configuration it came from, from the command line. Without --yes it
prints the draft (the diff and the note) and stops. With --yes it writes the file, keeps a backup
beside it, reads the scenario again and rescans it. The one way other than the UI's Approve that
a file is changed, and it is a person typing it: no tool reaches this.
"""

import argparse
import asyncio
import sys

from devries.config import get_settings
from devries.errors import DeVriesError
from devries.graph import keys
from devries.graph.client import GraphClient
from devries.mitigation import write as write_mod


async def main(scenario: str, mitigation_id: str, yes: bool, who: str) -> int:
    client = GraphClient()
    try:
        key = keys.scenario_key(scenario)
        if not await client.exists(key):
            print(f"no scenario {scenario!r} is loaded")
            return 1
        path = write_mod.scenario_file(scenario)
        names = {row["id"]: row["name"] or row["id"] for row in await client.run("node.names", key)}
        draft = await write_mod.draft_for(client, key, path, mitigation_id, names)
        print(f"{mitigation_id} as a change to {draft.kind}" + (f" at {draft.path}" if draft.path else ""))
        print(draft.diff or draft.after or "(no change the target can express)")
        print(f"note: {draft.note}")
        if not yes:
            print("Nothing was written. Add --yes to write it.")
            return 0
        receipt = await write_mod.write(client, key, key, path, mitigation_id, names, who, root=path.parent.parent if path else None)
        write_mod.announce(key, mitigation_id, receipt)
        print(f"written to {receipt.path} (backup at {receipt.backup}); closed: {', '.join(receipt.closed) or 'nothing'}; "
              f"open now: {', '.join(receipt.open_after) or 'nothing'}")
        return 0
    except DeVriesError as e:
        print(f"FAILED: {e.message}")
        return 1
    finally:
        await client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m devries.apply", description=__doc__)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--mitigation", required=True, help="the plan's id, mit:...")
    parser.add_argument("--yes", action="store_true", help="write the file; without it the draft is only printed")
    parser.add_argument("--as", dest="who", default="the command line", help="who is writing it, for the receipt")
    args = parser.parse_args()
    if get_settings().devries_public:
        print("this is a public site; nothing is written to files here")
        sys.exit(1)
    sys.exit(asyncio.run(main(args.scenario, args.mitigation, args.yes, args.who)))
