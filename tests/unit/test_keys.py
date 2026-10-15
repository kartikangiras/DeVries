import pytest

from cistern.errors import UnknownScenario
from cistern.graph import keys

SESSION = "A1b2C3d4E5f6G7h8I9j0K1"


def test_scenario_and_session_references_resolve():
    assert keys.resolve("acme_support") == "scn:acme_support"
    assert keys.resolve(f"acme_support@{SESSION}") == f"ses:{SESSION}:acme_support"
    assert keys.kind("scn:acme_support") == "working"
    assert keys.kind(f"ses:{SESSION}:acme_support") == "working"
    assert keys.scenario_of(f"ses:{SESSION}:acme_support") == "acme_support"


def test_sandbox_keys_carry_their_age():
    key = keys.sandbox_key()
    assert keys.kind(key) == "sandbox"
    assert 0 <= keys.sandbox_age_ms(key) < 5_000
    assert keys.sandbox_age_ms("sbx:1700000000000:abcdef", now_ms=1700000600000) == 600_000


@pytest.mark.parametrize("ref", [
    "", "Acme", "acme support", "acme;drop", "../etc", "scn:acme", "acme@short", "acme@" + "x" * 80,
    "acme@bad session!!!!!!!", "1starts_with_digit", "a" * 60,
])
def test_bad_references_are_rejected(ref):
    with pytest.raises(UnknownScenario):
        keys.resolve(ref)


@pytest.mark.parametrize("key", ["sbx:1:abcdef", "sbx:1700000000000:ABCDEF", "scn:", "ses::acme", "graph", "scn:a:b"])
def test_bad_keys_have_no_kind(key):
    with pytest.raises(UnknownScenario):
        keys.kind(key)
