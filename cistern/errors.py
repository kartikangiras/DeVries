"""Errors that cross a boundary (MCP tool, API) carry a code the caller can act on."""


class CisternError(Exception):
    code = "error"
    retryable = False

    def __init__(self, message: str, **details):
        super().__init__(message)
        self.message = message
        self.details = details

    def to_dict(self) -> dict:
        return {"error": {"code": self.code, "message": self.message, "retryable": self.retryable, **self.details}}


class UnknownQuery(CisternError):
    code = "unknown_query"


class ForbiddenWrite(CisternError):
    code = "forbidden_write"


class UnknownScenario(CisternError):
    code = "unknown_scenario"


class NotFound(CisternError):
    code = "not_found"


class InvalidScenario(CisternError):
    code = "invalid_scenario"


class QueryTimeout(CisternError):
    code = "timeout"
    retryable = True


class CanaryFailed(CisternError):
    code = "canary_failed"


class NotAvailable(CisternError):
    code = "not_available"


class InvalidFix(CisternError):
    code = "invalid_fix"


class FixFailed(CisternError):
    """The plan did not pass verification; the verdict travels with the error."""
    code = "fix_failed"
