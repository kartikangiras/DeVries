"""A tiny MCP server over stdio for the tests: one tool that reads, one that acts. The importer launches it
the way it would launch any server a client config names."""

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

mcp = MCPServer("notes", instructions="Two tools, for a test.")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def read_note(id: str) -> str:
    """Read a note by its id."""
    return f"note {id}"


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
def send_note(text: str) -> str:
    """Send a note somewhere outside."""
    return "sent"


if __name__ == "__main__":
    mcp.run()
