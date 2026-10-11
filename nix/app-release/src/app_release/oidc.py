"""Verification of the GitHub Actions OIDC token that authorizes an SSH request."""

import json
import re
import ssl
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from jwt.algorithms import RSAAlgorithm

from app_release.config import UnitConfig
from app_release.context import Claims
from app_release.errors import FailedError, RejectedError
from app_release.fsutil import atomic_write_text

JWKS_MAX_AGE_SECONDS = 3600
JWKS_MAX_BYTES = 1024 * 1024
JWKS_TIMEOUT_SECONDS = 15
LEEWAY_SECONDS = 60
ALGORITHM = "RS256"
EVENTS = {
    "release": frozenset({"push", "workflow_dispatch"}),
    "rollback": frozenset({"workflow_dispatch"}),
    "status": frozenset({"push", "workflow_dispatch"}),
}
SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
RUN_ID_PATTERN = re.compile(r"[0-9]{1,19}")
RUN_ATTEMPT_PATTERN = re.compile(r"[1-9][0-9]{0,8}")

Fetch = Callable[[str], bytes]


def fetch_url(ca_file: str | None) -> Fetch:
    """A fetcher for https:// (and file:// in tests) with a size limit and a timeout."""
    context = ssl.create_default_context(cafile=ca_file)

    def fetch(url: str) -> bytes:
        if not url.startswith(("https://", "file://")):
            message = f"refusing to fetch the JWKS from {url}: only https:// is allowed"
            raise FailedError(message)
        try:
            with urllib.request.urlopen(  # noqa: S310 - the scheme is checked above
                url, timeout=JWKS_TIMEOUT_SECONDS, context=context
            ) as response:
                data = cast("bytes", response.read(JWKS_MAX_BYTES + 1))
        except (OSError, ValueError) as error:
            message = f"cannot fetch the JWKS from {url}: {error}"
            raise FailedError(message) from None
        if len(data) > JWKS_MAX_BYTES:
            message = f"the JWKS at {url} is larger than {JWKS_MAX_BYTES} bytes"
            raise FailedError(message)
        return data

    return fetch


@dataclass
class JwksCache:
    path: Path
    url: str
    fetch: Fetch
    epoch: Callable[[], float]

    def _read(self) -> dict[str, object] | None:
        try:
            cached: object = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return None
        if not isinstance(cached, dict):
            return None
        data = cast("dict[str, object]", cached)
        fetched_at = data.get("fetchedAt")
        if data.get("url") != self.url or not isinstance(fetched_at, (int, float)):
            return None
        if not 0 <= self.epoch() - fetched_at < JWKS_MAX_AGE_SECONDS:
            return None
        jwks = data.get("jwks")
        return cast("dict[str, object]", jwks) if isinstance(jwks, dict) else None

    def _refetch(self) -> dict[str, object]:
        raw = self.fetch(self.url)
        try:
            parsed: object = json.loads(raw)
        except ValueError as error:
            message = f"the JWKS at {self.url} is not JSON: {error}"
            raise FailedError(message) from None
        if not isinstance(parsed, dict) or not isinstance(parsed.get("keys"), list):
            message = f"the JWKS at {self.url} has no keys list"
            raise FailedError(message)
        jwks = cast("dict[str, object]", parsed)
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            atomic_write_text(
                self.path,
                json.dumps({"url": self.url, "fetchedAt": self.epoch(), "jwks": jwks}),
                mode=0o600,
            )
        except OSError:
            pass  # The cache only saves a fetch; verification works without it.
        return jwks

    def key(self, kid: str) -> RSAPublicKey:
        """The public key for `kid`, refetching the JWKS once when the kid is unknown."""
        cached = self._read()
        if cached is not None:
            found = _find_key(cached, kid)
            if found is not None:
                return found
        found = _find_key(self._refetch(), kid)
        if found is None:
            message = f"the token's signing key {kid!r} is not in the JWKS"
            raise RejectedError(message)
        return found


def _find_key(jwks: dict[str, object], kid: str) -> RSAPublicKey | None:
    keys = jwks.get("keys")
    for entry in keys if isinstance(keys, list) else []:
        if isinstance(entry, dict) and entry.get("kid") == kid and entry.get("kty") == "RSA":
            try:
                key = RSAAlgorithm.from_jwk(json.dumps(entry))
            except (jwt.InvalidKeyError, ValueError, TypeError):
                return None
            return key if isinstance(key, RSAPublicKey) else None
    return None


def _claim(claims: dict[str, object], name: str) -> str:
    value = claims.get(name)
    if not isinstance(value, str) or value == "":
        message = f"the token has no {name} claim"
        raise RejectedError(message)
    return value


@dataclass(frozen=True)
class Verified:
    claims: Claims
    jti: str
    expires_at: int


def verify(token: str, unit: UnitConfig, operation: str, jwks: JwksCache) -> Verified:
    """Verify the token for `operation` on `unit`."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError as error:
        message = f"the token is malformed: {error}"
        raise RejectedError(message) from None
    if header.get("alg") != ALGORITHM:
        message = f"the token must be signed with {ALGORITHM}"
        raise RejectedError(message)
    kid = header.get("kid")
    if not isinstance(kid, str) or kid == "":
        message = "the token has no key id"
        raise RejectedError(message)
    key = jwks.key(kid)
    try:
        decoded = jwt.decode(
            token,
            key=key,
            algorithms=[ALGORITHM],
            audience=unit.oidc.audience,
            issuer=unit.oidc.issuer,
            leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "nbf", "iss", "aud", "jti"]},
        )
    except jwt.InvalidTokenError as error:
        message = f"the token is not valid: {error}"
        raise RejectedError(message) from None
    claims = cast("dict[str, object]", decoded)
    _check_request_claims(claims, unit, operation)
    run_id = _claim(claims, "run_id")
    if RUN_ID_PATTERN.fullmatch(run_id) is None:
        message = f"the token's run_id {run_id!r} is not a number"
        raise RejectedError(message)
    run_attempt = _claim(claims, "run_attempt")
    if RUN_ATTEMPT_PATTERN.fullmatch(run_attempt) is None:
        message = f"the token's run_attempt {run_attempt!r} is not a positive integer"
        raise RejectedError(message)
    sha = _claim(claims, "sha")
    if SHA_PATTERN.fullmatch(sha) is None:
        message = "the token's sha claim is not a commit hash"
        raise RejectedError(message)
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        message = "the token's exp claim is not a number"
        raise RejectedError(message)
    return Verified(
        claims=Claims(
            sha=sha,
            run_id=int(run_id),
            run_attempt=int(run_attempt),
            workflow_ref=_claim(claims, "workflow_ref"),
            actor=_claim(claims, "actor"),
            event_name=_claim(claims, "event_name"),
        ),
        jti=_claim(claims, "jti"),
        expires_at=int(exp),
    )


def _check_request_claims(claims: dict[str, object], unit: UnitConfig, operation: str) -> None:
    repository = _claim(claims, "repository")
    if repository != unit.repository:
        message = f"the token is for repository {repository}, not {unit.repository}"
        raise RejectedError(message)
    ref = _claim(claims, "ref")
    if ref != unit.ref:
        message = f"the token is for ref {ref}, not {unit.ref}"
        raise RejectedError(message)
    event_name = _claim(claims, "event_name")
    if event_name not in EVENTS[operation]:
        message = f"{operation} is not allowed from a {event_name} event"
        raise RejectedError(message)
