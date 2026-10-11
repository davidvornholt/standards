import json
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import IO
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from app_release.config import UnitConfig, parse_unit
from app_release.errors import FailedError, RejectedError
from app_release.oidc import JwksCache, fetch_url, verify
from app_release.replay import remember
from tests.fakes import SHA_B, app_json, unit_json

ISSUER = "https://token.actions.githubusercontent.com"


def new_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def jwk(key: rsa.RSAPrivateKey, kid: str) -> dict[str, object]:
    data: dict[str, object] = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    return {**data, "kid": kid, "alg": "RS256", "use": "sig"}


class OidcTest(unittest.TestCase):
    key: rsa.RSAPrivateKey
    other_key: rsa.RSAPrivateKey

    @classmethod
    def setUpClass(cls) -> None:
        cls.key = new_key()
        cls.other_key = new_key()

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)
        self.jwks_file = self.path / "jwks.json"
        self.write_jwks({"keys": [jwk(self.key, "k1")]})
        data = unit_json({"web": app_json("web", ports=(8001, 8002))})
        oidc = data["oidc"]
        assert isinstance(oidc, dict)
        oidc["jwksUrl"] = self.jwks_file.as_uri()
        self.unit: UnitConfig = parse_unit(data)
        self.fetches = 0
        self.now = time.time()

    def write_jwks(self, jwks: dict[str, object]) -> None:
        self.jwks_file.write_text(json.dumps(jwks))

    def cache(self) -> JwksCache:
        fetch = fetch_url(None)

        def counting(url: str) -> bytes:
            self.fetches += 1
            return fetch(url)

        return JwksCache(
            path=self.path / "cache" / "jwks.json",
            url=self.unit.oidc.jwks_url,
            fetch=counting,
            epoch=lambda: self.now,
        )

    def token(
        self,
        key: rsa.RSAPrivateKey | None = None,
        kid: str = "k1",
        algorithm: str = "RS256",
        **overrides: object,
    ) -> str:
        now = int(time.time())
        claims: dict[str, object] = {
            "iss": ISSUER,
            "aud": "app-release",
            "exp": now + 300,
            "nbf": now - 5,
            "iat": now - 5,
            "jti": "jti-1",
            "repository": "owner/shop",
            "ref": "refs/heads/main",
            "event_name": "push",
            "run_id": "1234",
            "run_attempt": "1",
            "sha": SHA_B,
            "workflow_ref": "owner/shop/.github/workflows/publish.yml@refs/heads/main",
            "actor": "octocat",
        }
        claims.update(overrides)
        claims = {name: value for name, value in claims.items() if value is not None}
        headers = {"kid": kid}
        if algorithm == "HS256":
            secret = "secret-secret-secret-secret-secret"
            return jwt.encode(claims, secret, algorithm=algorithm, headers=headers)
        return jwt.encode(claims, key or self.key, algorithm=algorithm, headers=headers)

    def test_valid_token_yields_the_claims(self) -> None:
        verified = verify(self.token(), self.unit, "release", self.cache())
        self.assertEqual(verified.claims.run_id, 1234)
        self.assertEqual(verified.claims.run_attempt, 1)
        self.assertEqual(verified.claims.sha, SHA_B)
        self.assertEqual(verified.claims.actor, "octocat")
        self.assertEqual(verified.jti, "jti-1")

    def assert_rejected(self, token: str, operation: str = "release", fragment: str = "") -> None:
        with self.assertRaises(RejectedError) as raised:
            verify(token, self.unit, operation, self.cache())
        self.assertIn(fragment, raised.exception.message)

    def test_wrong_repository_is_rejected(self) -> None:
        self.assert_rejected(self.token(repository="owner/other"), fragment="repository")

    def test_repository_is_case_sensitive(self) -> None:
        self.assert_rejected(self.token(repository="Owner/Shop"), fragment="repository")

    def test_wrong_ref_is_rejected(self) -> None:
        self.assert_rejected(self.token(ref="refs/heads/feature"), fragment="ref")

    def test_wrong_audience_is_rejected(self) -> None:
        self.assert_rejected(self.token(aud="sigstore"), fragment="not valid")

    def test_wrong_issuer_is_rejected(self) -> None:
        self.assert_rejected(self.token(iss="https://example.com"), fragment="not valid")

    def test_expired_token_is_rejected(self) -> None:
        past = int(time.time()) - 600
        self.assert_rejected(
            self.token(exp=past, iat=past - 300, nbf=past - 300), fragment="expired"
        )

    def test_expiry_has_sixty_seconds_leeway(self) -> None:
        recent = int(time.time()) - 30
        verify(self.token(exp=recent), self.unit, "release", self.cache())

    def test_future_token_is_rejected(self) -> None:
        future = int(time.time()) + 600
        self.assert_rejected(self.token(nbf=future, iat=future), fragment="not valid")

    def test_missing_jti_is_rejected(self) -> None:
        self.assert_rejected(self.token(jti=None), fragment="jti")

    def test_other_signing_key_is_rejected(self) -> None:
        self.assert_rejected(self.token(key=self.other_key), fragment="not valid")

    def test_symmetric_algorithm_is_rejected(self) -> None:
        self.assert_rejected(self.token(algorithm="HS256"), fragment="RS256")

    def test_rollback_needs_workflow_dispatch(self) -> None:
        self.assert_rejected(self.token(), operation="rollback", fragment="push")
        verify(self.token(event_name="workflow_dispatch"), self.unit, "rollback", self.cache())

    def test_pull_request_events_are_rejected(self) -> None:
        self.assert_rejected(self.token(event_name="pull_request"), fragment="pull_request")

    def test_run_attempt_must_be_a_positive_integer(self) -> None:
        self.assert_rejected(self.token(run_attempt="0"), fragment="run_attempt")
        self.assert_rejected(self.token(run_attempt="-1"), fragment="run_attempt")

    def test_jwks_is_cached_for_an_hour(self) -> None:
        cache = self.cache()
        verify(self.token(), self.unit, "release", cache)
        verify(self.token(), self.unit, "release", cache)
        self.assertEqual(self.fetches, 1)
        self.now += 3601
        verify(self.token(), self.unit, "release", cache)
        self.assertEqual(self.fetches, 2)

    def test_unknown_kid_refetches_once(self) -> None:
        cache = self.cache()
        verify(self.token(), self.unit, "release", cache)
        self.write_jwks({"keys": [jwk(self.key, "k1"), jwk(self.other_key, "k2")]})
        verify(self.token(key=self.other_key, kid="k2"), self.unit, "release", cache)
        self.assertEqual(self.fetches, 2)
        with self.assertRaises(RejectedError):
            verify(self.token(kid="k3"), self.unit, "release", cache)
        self.assertEqual(self.fetches, 3)

    def test_unreachable_jwks_fails(self) -> None:
        self.jwks_file.unlink()
        with self.assertRaises(FailedError):
            verify(self.token(), self.unit, "release", self.cache())

    def test_plain_http_jwks_is_refused(self) -> None:
        with self.assertRaises(FailedError):
            fetch_url(None)("http://example.com/jwks")


class ReplayTest(unittest.TestCase):
    def test_duplicate_is_rejected_before_the_first_marker_is_written(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            seen = Path(directory) / "seen-jti"
            created = threading.Event()
            resume = threading.Event()
            original_fdopen = os.fdopen

            def pause_writer(descriptor: int, mode: str) -> IO[str]:
                file = original_fdopen(descriptor, mode)
                if not created.is_set():
                    created.set()
                    if not resume.wait(10):
                        file.close()
                        message = "the duplicate request did not finish"
                        raise AssertionError(message)
                return file

            with (
                patch("app_release.replay.os.fdopen", side_effect=pause_writer),
                ThreadPoolExecutor(max_workers=1) as executor,
            ):
                first = executor.submit(remember, seen, "jti-1", 2000, now=1000)
                try:
                    self.assertTrue(created.wait(10))
                    self.assertEqual(next(seen.iterdir()).read_bytes(), b"")
                    with self.assertRaises(RejectedError):
                        remember(seen, "jti-1", 2000, now=1000)
                finally:
                    resume.set()
                first.result(timeout=10)
            self.assertEqual(next(seen.iterdir()).read_text(), "2000\n")

    def test_a_jti_is_accepted_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            seen = Path(directory) / "seen-jti"
            remember(seen, "jti-1", 2000, now=1000)
            with self.assertRaises(RejectedError):
                remember(seen, "jti-1", 2000, now=1500)
            remember(seen, "jti-2", 2000, now=1500)

    def test_expired_entries_are_pruned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            seen = Path(directory) / "seen-jti"
            remember(seen, "jti-1", 2000, now=1000)
            remember(seen, "jti-2", 5000, now=2100)
            self.assertEqual(len(list(seen.iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
