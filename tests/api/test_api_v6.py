"""The second review round at the API: a Host the app does not serve is refused, every answer carries security
headers, and a visitor's question is listed to that visitor only."""

import asyncio

from test_api import base, visitor  # noqa: F401 - `base` is the app fixture


async def test_a_host_the_app_does_not_serve_is_refused(base):
    async with visitor(base) as http:
        await http.get("/api/session")
        spoof = {"Host": "evil.example:8000", "Origin": "http://evil.example:8000"}
        refused = await http.post("/api/scenarios/acme_support/mitigations/search", json={}, headers=spoof)
        assert refused.status_code == 403 and refused.json()["error"]["code"] == "cross_site"
        assert "ALLOWED_HOSTS" in refused.json()["error"]["message"]
        # reads are not changes
        assert (await http.get("/api/scenarios/acme_support/findings", headers={"Host": "evil.example:8000"})).status_code == 200


async def test_every_answer_carries_security_headers(base):
    async with visitor(base) as http:
        for path in ("/api/health", "/api/scenarios", "/api/scenarios/acme_support/findings"):
            answer = await http.get(path)
            assert answer.headers["x-content-type-options"] == "nosniff", path
            assert answer.headers["x-frame-options"] == "DENY", path
            assert "default-src 'self'" in answer.headers["content-security-policy"], path


async def test_a_question_is_listed_to_its_asker_only(base):
    async with visitor(base) as http, visitor(base) as other:
        await http.get("/api/session")
        await other.get("/api/session")
        started = (await http.post("/api/agent/ask", json={"scenario": "acme_support",
                                                           "question": "Which agent can reach the payments API?"})).json()["run"]
        for _ in range(200):
            run = (await http.get(f"/api/agent/runs/{started['id']}")).json()["run"]
            if run["status"] in ("done", "failed"):
                break
            await asyncio.sleep(0.1)
        mine = (await http.get("/api/scenarios/acme_support/runs")).json()["runs"]
        theirs = (await other.get("/api/scenarios/acme_support/runs")).json()["runs"]
        assert any(r["id"] == started["id"] for r in mine)
        assert not any(r["id"] == started["id"] for r in theirs)
        assert (await other.get(f"/api/agent/runs/{started['id']}")).status_code == 404
        # an audit run is everyone's record
        assert all(r["kind"] == "audit" for r in theirs)
