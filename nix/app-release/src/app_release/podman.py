"""The podman image operations app-release needs."""

import json
from dataclasses import dataclass
from typing import Protocol, cast

from app_release.errors import FailedError
from app_release.runner import Runner

REVISION_LABEL = "org.opencontainers.image.revision"
PULL_TIMEOUT_SECONDS = 1800


class PodmanError(FailedError):
    """A podman command failed."""


@dataclass(frozen=True)
class Image:
    id: str
    digest: str
    revision: str | None
    content: str
    """Canonical JSON of the fields that decide whether two images run the same thing."""


@dataclass(frozen=True)
class ImageSummary:
    id: str
    names: tuple[str, ...]
    repo_digests: tuple[str, ...]
    containers: int


class ImageStore(Protocol):
    def exists(self, reference: str) -> bool: ...
    def inspect(self, reference: str) -> Image | None: ...
    def pull(self, reference: str) -> None: ...
    def tag(self, image_id: str, name: str) -> None: ...
    def untag(self, image_id: str, name: str) -> None: ...
    def images(self) -> list[ImageSummary]: ...
    def remove(self, name: str) -> str | None: ...


def _dict(value: object) -> dict[str, object]:
    return cast("dict[str, object]", value) if isinstance(value, dict) else {}


def _labels(data: dict[str, object]) -> dict[str, object]:
    labels = _dict(_dict(data.get("Config")).get("Labels"))
    return labels or _dict(data.get("Labels"))


def content_key(data: dict[str, object]) -> str:
    """Equal keys mean the images run the same filesystem with the same runtime config."""
    config = _dict(data.get("Config"))
    healthcheck = config.get("Healthcheck") or data.get("Healthcheck") or None
    return json.dumps(
        {
            "layers": _dict(data.get("RootFS")).get("Layers") or [],
            "entrypoint": config.get("Entrypoint") or [],
            "cmd": config.get("Cmd") or [],
            "env": config.get("Env") or [],
            "workingDir": config.get("WorkingDir") or "",
            "user": config.get("User") or "",
            "exposedPorts": config.get("ExposedPorts") or {},
            "healthcheck": healthcheck,
        },
        sort_keys=True,
    )


def parse_image(data: dict[str, object]) -> Image:
    image_id = data.get("Id")
    digest = data.get("Digest")
    if not isinstance(image_id, str) or not isinstance(digest, str):
        message = "podman image inspect returned an image without Id or Digest"
        raise PodmanError(message)
    revision = _labels(data).get(REVISION_LABEL)
    return Image(
        id=image_id,
        digest=digest,
        revision=revision if isinstance(revision, str) else None,
        content=content_key(data),
    )


def _strings(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


class Podman:
    def __init__(self, executable: str, runner: Runner, authfile: str | None) -> None:
        self.executable = executable
        self.runner = runner
        self.authfile = authfile

    def exists(self, reference: str) -> bool:
        result = self.runner([self.executable, "image", "exists", reference])
        if result.returncode == 0:
            return True
        if result.returncode == 1:
            return False
        message = f"podman image exists {reference}: {result.summary()}"
        raise PodmanError(message)

    def inspect(self, reference: str) -> Image | None:
        if not self.exists(reference):
            return None
        result = self.runner([self.executable, "image", "inspect", "--format", "json", reference])
        if not result.ok:
            message = f"podman image inspect {reference}: {result.summary()}"
            raise PodmanError(message)
        try:
            parsed: object = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            message = f"podman image inspect {reference} returned invalid JSON: {error}"
            raise PodmanError(message) from None
        if not isinstance(parsed, list) or len(parsed) != 1:
            message = f"podman image inspect {reference} did not return exactly one image"
            raise PodmanError(message)
        return parse_image(_dict(parsed[0]))

    def pull(self, reference: str) -> None:
        argv = [self.executable, "pull", "--quiet"]
        if self.authfile is not None:
            argv += ["--authfile", self.authfile]
        result = self.runner([*argv, reference], timeout=PULL_TIMEOUT_SECONDS)
        if not result.ok:
            raise PodmanError(result.summary())

    def tag(self, image_id: str, name: str) -> None:
        result = self.runner([self.executable, "tag", image_id, name])
        if not result.ok:
            message = f"podman tag {name}: {result.summary()}"
            raise PodmanError(message)

    def untag(self, image_id: str, name: str) -> None:
        result = self.runner([self.executable, "untag", image_id, name])
        if not result.ok:
            message = f"podman untag {name}: {result.summary()}"
            raise PodmanError(message)

    def images(self) -> list[ImageSummary]:
        result = self.runner([self.executable, "images", "--format", "json"])
        if not result.ok:
            message = f"podman images: {result.summary()}"
            raise PodmanError(message)
        try:
            parsed: object = json.loads(result.stdout or "[]")
        except json.JSONDecodeError as error:
            message = f"podman images returned invalid JSON: {error}"
            raise PodmanError(message) from None
        summaries: dict[str, ImageSummary] = {}
        for entry in parsed if isinstance(parsed, list) else []:
            data = _dict(entry)
            image_id = data.get("Id")
            if not isinstance(image_id, str) or image_id in summaries:
                continue
            containers = data.get("Containers")
            summaries[image_id] = ImageSummary(
                id=image_id,
                names=_strings(data.get("Names")),
                repo_digests=_strings(data.get("RepoDigests")),
                containers=containers if isinstance(containers, int) else 0,
            )
        return list(summaries.values())

    def remove(self, name: str) -> str | None:
        # Never pass --force: it would also remove containers that use the image.
        result = self.runner([self.executable, "rmi", name])
        return None if result.ok else result.summary()


def repository_of(name: str) -> str:
    """`ghcr.io/o/r:tag` and `ghcr.io/o/r@sha256:...` both belong to `ghcr.io/o/r`."""
    if "@" in name:
        return name.split("@", 1)[0]
    slash = name.rfind("/")
    colon = name.rfind(":")
    return name[:colon] if colon > slash else name


def digest_of(name: str) -> str | None:
    return name.split("@", 1)[1] if "@" in name else None
