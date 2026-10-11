"""Exit codes and the errors that map to them."""

from enum import IntEnum


class ExitCode(IntEnum):
    OK = 0
    FAILED = 1
    REJECTED = 2
    CRITICAL = 3
    LOCK_TIMEOUT = 4


class AppReleaseError(Exception):
    """An expected failure with the exit code the operation reports."""

    exit_code: ExitCode = ExitCode.FAILED

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class FailedError(AppReleaseError):
    """The operation failed and the previous version is serving."""

    exit_code = ExitCode.FAILED


class RejectedError(AppReleaseError):
    """The request was rejected before anything changed."""

    exit_code = ExitCode.REJECTED


class CriticalError(AppReleaseError):
    """The operation failed and the previous version could not be restored."""

    exit_code = ExitCode.CRITICAL


class LockTimeoutError(AppReleaseError):
    """Another operation held the unit lock longer than the wait timeout."""

    exit_code = ExitCode.LOCK_TIMEOUT
