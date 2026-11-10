"""Person 2 owns this file.

CONTRACT: check(text) takes one thing the speaker said and returns a CheckResult.
server.py calls it. index.html displays what it returned. Keep the shape; change the inside.
"""

from typing import Literal, TypedDict


class CheckResult(TypedDict):
    verdict: Literal["CONFIRMED", "CONTRADICTED", "UNCLEAR", "NOT_A_CLAIM"]
    claim: str    # the sentence that was checked
    say: str      # "" to stay silent, or the one sentence Jamie speaks (only on CONTRADICTED)
    source: str   # URL of the evidence, or ""


async def check(text: str) -> CheckResult:
    # TODO(Person 2): replace this stub with
    #   1. Jev noul gate  -> below threshold: NOT_A_CLAIM
    #   2. Exa search     -> top highlight + URL
    #   3. Jev choice     -> CONFIRMED / CONTRADICTED / UNCLEAR
    #   4. on CONTRADICTED, fill in `say`
    # Stub: a sentence containing "false" goes red, "true" goes green, anything else is ignored.
    lowered = text.lower()
    if "false" in lowered:
        return {"verdict": "CONTRADICTED", "claim": text,
                "say": "Quick correction. This is the stub speaking.", "source": "https://example.com"}
    if "true" in lowered:
        return {"verdict": "CONFIRMED", "claim": text, "say": "", "source": "https://example.com"}
    return {"verdict": "NOT_A_CLAIM", "claim": text, "say": "", "source": ""}
