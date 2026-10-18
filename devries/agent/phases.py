"""Which tools each phase offers the model, and the budgets a run works inside.

Tool definitions come from the MCP server's `tools/list`. The only things the
agent hard-codes are the names below and one local pseudo-tool, `choose_targets`,
which lets the model end the investigation with a structured decision and never
reaches the server. What a phase offers is guidance for the model, not a
security boundary: the server enforces its own rules whatever a client sends.
"""

from typing import Any

from devries.agent.llm import ToolSpec

INVESTIGATE = ["trust_zones", "rule_of_two", "find_injection_paths", "find_trifecta_agents", "rank_chokepoints"]
MITIGATE = ["rank_chokepoints", "simulate_mitigation", "what_if", "propose_fix"]
# Ask runs answer a visitor's question. No tool here writes anything outside a sandbox.
ASK = ["list_scenarios", "trust_zones", "rule_of_two", "find_injection_paths", "find_trifecta_agents", "rank_chokepoints",
       "simulate_mitigation", "what_if"]

MAX_STEPS_PER_PHASE = 8          # model steps
MAX_STEPS_PER_RUN = 40
MAX_SIMULATIONS_PER_TARGET = 8
MAX_ROUNDS = 5                   # scan -> ... -> apply, repeated while findings remain

BECAUSE = {
    "type": "string",
    "description": "One sentence naming, by id, the earlier result in this conversation that makes this the next call: "
                   "a finding (fnd:…), a node (agent:…, tool:…, src:…, res:…) or a plan (mit:…), exactly as a tool returned it.",
}

CHOOSE_TARGETS = ToolSpec(
    name="choose_targets",
    description=("End the investigation: name the finding or findings to fix first. Choose ids that a tool returned. "
                 "Group findings only when one fix is likely to close them together."),
    input_schema={
        "type": "object",
        "properties": {
            "finding_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 3},
            "because": {"type": "string", "description": "Why these first, citing what the tools returned."},
        },
        "required": ["finding_ids", "because"],
    },
)


def _inline(node: Any, defs: dict[str, Any], is_properties: bool = False) -> Any:
    """Resolve $ref against $defs and drop schema noise, so a definition stands on its own."""
    if isinstance(node, list):
        return [_inline(item, defs) for item in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        return _inline(defs[node["$ref"].rsplit("/", 1)[1]], defs)
    out = {}
    for key, value in node.items():
        if not is_properties and key in ("$defs", "title", "discriminator"):
            continue                                      # `title` and `discriminator` here are annotations, not fields
        out[key] = _inline(value, defs, is_properties=(key == "properties" and not is_properties))
    return out


def tool_spec(name: str, description: str, input_schema: dict[str, Any]) -> ToolSpec:
    """An MCP tool as a definition for the model: self-contained, plus the required `because`."""
    schema = _inline(input_schema, input_schema.get("$defs", {}))
    schema["properties"] = {**schema.get("properties", {}), "because": BECAUSE}
    schema["required"] = [*schema.get("required", []), "because"]
    return ToolSpec(name=name, description=" ".join((description or "").split()), input_schema=schema)
