"""Errors that cross a boundary (MCP tool, API) carry a code the caller can act on."""


class DeVriesError(Exception):
    code = "error"
    retryable = False

    def __init__(self, message: str, **details):
        super().__init__(message)
        self.message = message
        self.details = details

    def to_dict(self) -> dict:
        return {"error": {"code": self.code, "message": self.message, "retryable": self.retryable, **self.details}}


class UnknownQuery(DeVriesError):
    code = "unknown_query"


class ForbiddenWrite(DeVriesError):
    code = "forbidden_write"


class UnknownScenario(DeVriesError):
    code = "unknown_scenario"


class NotFound(DeVriesError):
    code = "not_found"


class InvalidScenario(DeVriesError):
    code = "invalid_scenario"


class QueryTimeout(DeVriesError):
    code = "timeout"
    retryable = True


class CanaryFailed(DeVriesError):
    code = "canary_failed"


class NotAvailable(DeVriesError):
    code = "not_available"


class InvalidFix(DeVriesError):
    code = "invalid_fix"


class FixFailed(DeVriesError):
    """The plan did not pass verification; the verdict travels with the error."""
    code = "fix_failed"
