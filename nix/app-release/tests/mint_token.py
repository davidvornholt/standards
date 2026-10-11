"""Mint GitHub Actions style OIDC tokens for the app-release NixOS VM test.

The signing key is generated inside the VM on first use and never leaves it.
"""

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

KEY_FILE = Path("/root/test-oidc/key.pem")
JWKS_FILE = Path("/var/lib/test-oidc/jwks.json")
KID = "vm-test"
ISSUER = "https://token.actions.githubusercontent.com"
LIFETIME_SECONDS = 300


def load_key() -> rsa.RSAPrivateKey:
    if KEY_FILE.exists():
        key = serialization.load_pem_private_key(KEY_FILE.read_bytes(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey):
            message = f"{KEY_FILE} is not an RSA key"
            raise SystemExit(message)
        return key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    KEY_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    KEY_FILE.touch(mode=0o600)
    KEY_FILE.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    public: dict[str, object] = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    JWKS_FILE.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    JWKS_FILE.write_text(
        json.dumps({"keys": [{**public, "kid": KID, "alg": "RS256", "use": "sig"}]})
    )
    return key


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--init", action="store_true", help="only create the key and JWKS")
    parser.add_argument("--sha", default="0" * 40)
    parser.add_argument("--run-id", default="1")
    parser.add_argument("--run-attempt", default="1")
    parser.add_argument("--event", default="push")
    parser.add_argument("--repository", default="owner/shop")
    parser.add_argument("--ref", default="refs/heads/main")
    parser.add_argument("--audience", default="app-release")
    parser.add_argument("--expires-in", type=int, default=LIFETIME_SECONDS)
    parser.add_argument("--jti", default=None)
    arguments = parser.parse_args()
    key = load_key()
    if arguments.init:
        return
    now = int(time.time())
    expires = now + arguments.expires_in
    issued = min(now, expires - LIFETIME_SECONDS)
    claims = {
        "iss": ISSUER,
        "aud": arguments.audience,
        "iat": issued,
        "nbf": issued,
        "exp": expires,
        "jti": arguments.jti or str(uuid.uuid4()),
        "repository": arguments.repository,
        "ref": arguments.ref,
        "event_name": arguments.event,
        "run_id": arguments.run_id,
        "run_attempt": arguments.run_attempt,
        "sha": arguments.sha,
        "workflow_ref": f"{arguments.repository}/.github/workflows/publish.yml@{arguments.ref}",
        "actor": "vm-test",
    }
    token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": KID})
    sys.stdout.write(token + "\n")


if __name__ == "__main__":
    main()
