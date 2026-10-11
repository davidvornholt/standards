"""Health probes and consumer hook commands."""

import http.client
import os
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from app_release.runner import Runner

HTTP_TIMEOUT_SECONDS = 5
HTTP_OK_RANGE = range(200, 400)


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    output: str


class Prober(Protocol):
    def http(self, port: int, path: str) -> str | None: ...
    def command(
        self, command: str, env: Mapping[str, str], timeout: float | None
    ) -> CommandResult: ...


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(  # noqa: PLR0913 - overrides the urllib signature
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: http.client.HTTPMessage,
        newurl: str,
    ) -> None:
        del req, fp, code, msg, headers, newurl


class SystemProber:
    def __init__(self, bash: str, runner: Runner) -> None:
        self.bash = bash
        self.runner = runner
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def http(self, port: int, path: str) -> str | None:
        """None when the endpoint answers 2xx or 3xx, otherwise the reason."""
        url = f"http://127.0.0.1:{port}{path}"
        try:
            with self.opener.open(url, timeout=HTTP_TIMEOUT_SECONDS) as response:
                status = int(response.status)
        except urllib.error.HTTPError as error:
            status = error.code
        except (OSError, http.client.HTTPException) as error:
            return f"GET {url}: {error}"
        return None if status in HTTP_OK_RANGE else f"GET {url}: HTTP {status}"

    def command(self, command: str, env: Mapping[str, str], timeout: float | None) -> CommandResult:
        result = self.runner([self.bash, "-c", command], timeout=timeout, env={**os.environ, **env})
        output = (result.stdout + result.stderr).strip()
        return CommandResult(result.returncode, output)
