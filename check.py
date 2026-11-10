"""Person 2 owns this file.

CONTRACT: check(text) takes one thing the speaker said and returns a CheckResult.
server.py calls it. index.html displays what it returned. Keep the shape; change the inside.

Pipeline:  Jev noul gate -> Exa search -> Jev choice verdict -> (on CONTRADICTED) pick the line Jamie says.
Try it without audio:  python check.py "The Eiffel Tower is 500 meters tall."
"""

import asyncio
import os
import re
import time
from typing import Literal, TypedDict
from urllib.parse import urlparse

import httpx
from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul

GATE_MIN = 0.7        # below this the sentence is banter, not a claim (measured: banter ~0.03, claims ~0.97)
VERDICT_MIN = 0.8     # a CONFIRMED / CONTRADICTED less sure than this is shown as UNCLEAR
SAY_MIN = 0.5         # how sure Jev must be that a sentence is the correction before Jamie reads it out
EXA_TYPE = "fast"     # ~350 ms. "auto" measured ~1200 ms, so don't.

GATE = Noul(instructions=(
    "Does the speaker state a specific factual claim that could be verified against a public source? "
    "Opinions, predictions, personal anecdotes, questions, greetings and jokes are not claims."))
VERDICT = Choice(
    instructions=("Compare the claim with ONLY the supplied evidence. Match entity, units and numbers exactly. "
                  "Lack of support is not contradiction."),
    criteria={
        "CONFIRMED": "Evidence explicitly states the same fact as the claim, with the same entity, number, date or name.",
        "CONTRADICTED": ("Evidence explicitly states a different number, date, name or fact for the same thing, "
                         "or says the claim is a myth or false."),
        "UNCLEAR": "Evidence is about something else or does not settle the claim.",
    })
CORRECTS = Noul(instructions=(
    "Does the sentence, read on its own, state the correct fact that shows the claim is wrong?"))


class CheckResult(TypedDict):
    verdict: Literal["CONFIRMED", "CONTRADICTED", "UNCLEAR", "NOT_A_CLAIM"]
    claim: str    # the sentence that was checked
    say: str      # "" to stay silent, or the one sentence Jamie speaks (only on CONTRADICTED)
    source: str   # URL of the evidence, or ""


_clients: dict = {}


def _get_clients():
    """One Exa and one Jev client per event loop, so calls reuse a warm connection instead of a new TLS handshake."""
    loop = asyncio.get_running_loop()
    if _clients.get("loop") is not loop:
        _clients.update(
            loop=loop,
            exa=httpx.AsyncClient(timeout=3.0, headers={"x-api-key": os.environ["EXA_API_KEY"]},
                                  limits=httpx.Limits(keepalive_expiry=120)),
            jev=AsyncTypeSafeClient(api_key=os.environ["TYPESAFE_API_KEY"], timeout=3.0))
    return _clients["exa"], _clients["jev"]


async def warm_up() -> None:
    """Open the Jev and Exa connections at boot, so the first real claim doesn't pay for the handshakes."""
    t = time.perf_counter()
    try:
        exa, jev = _get_clients()
        line = "Paris is the capital of France."
        await asyncio.gather(
            jev.system_one(state={"sentence": line}, questions={"is_claim": GATE}),
            exa.post("https://api.exa.ai/search", json={"query": line, "type": EXA_TYPE, "numResults": 1}))
        print(f"[check] warm-up done in {int((time.perf_counter() - t) * 1000)}ms")
    except Exception as e:  # a failed warm-up only means a slower first check
        print(f"[check] warm-up failed: {e!r}")


def _domain(url: str) -> str:
    return urlparse(url).hostname.removeprefix("www.") if url else ""


def _sentences(highlight: str) -> list[str]:
    """Sentences from a web excerpt that are clean enough to be read out loud."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", highlight)          # [label](url) -> label
    text = re.sub(r"[#*_|>`]+", " ", text)                             # markdown
    out = []
    # Line by line first: headings, captions and table rows are their own lines and must not glue onto a sentence.
    for s in (s.strip() for line in re.split(r"[\r\n]+|\.\.\.|…", text) for s in re.split(r"(?<=[.!?])\s+", line)):
        s = re.sub(r"^\d{4}\s+(?=[A-Z])", "", re.sub(r"\s+", " ", s))  # drop a timeline year glued to the front
        if (6 <= len(s.split()) <= 24 and s.endswith(".") and re.match(r"[A-Z0-9]", s)
                and not re.search(r"http|[:;/©(\[]", s)
                and not re.match(r"(it|its|they|their|he|his|she|her|this|that|these|those|and|but|however|also|"
                                 r"indeed|one of|by this|so|then|here|there)\b", s, re.I)):
            out.append(s)
    return out


async def _correction(jev, claim: str, results: list[dict]) -> tuple[str, str]:
    """The line Jamie says and the URL it came from: the evidence sentence that best states the right fact."""
    candidates, seen = [], set()
    for r in results:
        for s in [s for h in r.get("highlights") or [] for s in _sentences(h)][:5]:
            if s not in seen:
                seen.add(s)
                candidates.append((s, r["url"]))
    if candidates:
        answers = await asyncio.gather(
            *(jev.system_one(state={"claim": claim, "sentence": s}, questions={"corrects": CORRECTS})
              for s, _ in candidates), return_exceptions=True)
        scores = [0.0 if isinstance(a, BaseException) else a.answers["corrects"].noul for a in answers]
        best = max(range(len(candidates)), key=scores.__getitem__)
        if scores[best] >= SAY_MIN:
            sentence, url = candidates[best]
            return f"Quick correction. According to {_domain(url)}, {sentence}", url
    url = results[0]["url"]
    return f"Quick correction. That does not match what {_domain(url)} says.", url


async def check(text: str) -> CheckResult:
    claim = text.strip()
    result: CheckResult = {"verdict": "NOT_A_CLAIM", "claim": claim, "say": "", "source": ""}
    if not claim:
        return result
    ms: dict[str, int] = {}
    t = time.perf_counter()

    def lap(stage: str):
        nonlocal t
        ms[stage] = int((time.perf_counter() - t) * 1000)
        t = time.perf_counter()

    try:
        exa, jev = _get_clients()

        gate = await jev.system_one(state={"sentence": claim}, questions={"is_claim": GATE})
        lap("gate")
        if gate.answers["is_claim"].noul < GATE_MIN:
            return result

        result["verdict"] = "UNCLEAR"      # from here on it is a claim; anything that goes wrong leaves it unsettled
        response = await exa.post("https://api.exa.ai/search", json={
            "query": claim, "type": EXA_TYPE, "numResults": 3, "contents": {"highlights": True}})
        response.raise_for_status()
        results = [r for r in response.json().get("results", []) if r.get("url") and r.get("highlights")]
        lap("exa")
        if not results:
            return result

        # All three results go to the judge. One excerpt alone is often a page header that settles nothing.
        evidence = [{"source": _domain(r["url"]), "title": r.get("title") or "",
                     "excerpt": " ... ".join(r["highlights"])[:1500]} for r in results]
        answer = (await jev.system_one(state={"claim": claim, "evidence": evidence},
                                       questions={"verdict": VERDICT})).answers["verdict"]
        lap("verdict")
        if answer.choice == "UNCLEAR" or answer.confidence < VERDICT_MIN:
            return result

        result["verdict"] = answer.choice
        result["source"] = results[0]["url"]
        if answer.choice == "CONTRADICTED":
            result["say"], result["source"] = await _correction(jev, claim, results)
            lap("say")
        return result
    except Exception as e:  # a failed check must never read as "true"
        print(f"[check] failed after {ms}: {e!r}")
        return result
    finally:
        print(f"[check] stages {ms}")


if __name__ == "__main__":
    import sys

    from dotenv import load_dotenv

    load_dotenv()

    async def _main():
        for line in sys.argv[1:] or ["The Eiffel Tower is 500 meters tall."]:
            print(await check(line))

    asyncio.run(_main())
