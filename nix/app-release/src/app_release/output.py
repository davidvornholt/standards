"""Progress lines and the final APP_RELEASE_RESULT line."""

import json
from typing import TextIO

RESULT_PREFIX = "APP_RELEASE_RESULT "


class Output:
    """Writes each line to every stream and flushes, ignoring readers that went away."""

    def __init__(self, *streams: TextIO) -> None:
        self.streams = list(streams)

    def line(self, text: str) -> None:
        for stream in list(self.streams):
            try:
                stream.write(text + "\n")
                stream.flush()
            except (BrokenPipeError, OSError, ValueError):
                self.streams.remove(stream)

    def warn(self, text: str) -> None:
        self.line(f"warning: {text}")

    def result(self, payload: dict[str, object]) -> None:
        self.line(RESULT_PREFIX + json.dumps(payload, separators=(",", ":"), sort_keys=False))
