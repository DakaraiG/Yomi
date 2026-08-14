# Yomi backend — v0.3.1

ASP.NET Core minimal API. Orchestration, caching, and the LLM call.

Takes a page image, asks the [sidecar](../sidecar/README.md) where the text is
and what it says, sends both to a vision model for translation, merges the two,
and returns a `TranslatedPage`. Geometry and reading order come from the
sidecar; only the language fields come from the model.

Nothing here changed between v0.2 and v0.3.1 — v0.3 was the
[extension](../extension/README.md), built against this API exactly as it was
frozen. That is the contract working as intended.

## Licence note

This project is **MIT**, and deliberately not the sidecar's GPL-3.0.

The two are separate processes talking over HTTP, and that seam is the licence
boundary. The sidecar is GPL because it links `comic-text-detector`; nothing
GPL is linked here, so nothing forces copyleft on this side.

Do not add a project reference between `backend/` and `sidecar/`, and do not
merge the processes. The separation is load-bearing, not incidental — a project
reference would pull this side under the GPL. The browser extension (also MIT)
must contain no GPL code either.

Historical note: this backend was AGPL-3.0 through v0.2, chosen for its
network-use trigger on the theory that it might one day be hosted. It is MIT as
of v0.3.1. The old reasoning is in git history if a hosted deployment ever
revives the question.

## Setup

Needs the .NET 10 SDK (`dotnet --version` should print `10.x`; `global.json` at
the repo root pins the band).

### API key

The key is read from configuration and must **never** go in `appsettings.json`,
which is committed. Use user-secrets, from this directory:

```bash
cd Yomi.Api
dotnet user-secrets set "Yomi:ApiKey" "sk-..."
```

That writes to `~/.microsoft/usersecrets/yomi-api/secrets.json`, outside the
repo. To check it registered without printing the value:

```bash
dotnet user-secrets list | sed -E 's/=.*/= <redacted>/'
```

`/health` also reports `apiKeyConfigured: true|false`. Nothing in this codebase
logs, echoes, or returns the key itself — not even a prefix. Keep it that way.

## Run

The sidecar must be running first, or every translate call returns 503.

```bash
cd Yomi.Api
dotnet run --launch-profile http
```

Serves on **http://localhost:5080**. Do not move this to 5000 — macOS binds
that port for AirPlay Receiver, and the failure looks like a routing bug rather
than a port conflict. The extension hardcodes 5080 in `background.js`, so
changing it means changing that too.

The port lives in `Yomi.Api/Properties/launchSettings.json`. It must stay under
`Properties/`; .NET does not read it from the project root, and a
`--launch-profile` that silently does nothing is the symptom.

```bash
curl -s localhost:5080/health
# {"status":"ok","model":"gpt-5.6-luna","reasoningEffort":"low",
#  "sidecar":"http://127.0.0.1:8001","apiKeyConfigured":true}
```

## Configuration

`appsettings.json`, section `Yomi`. Everything is overridable by user-secrets or
environment variables (`Yomi__Model=...`).

| Key | Default | Purpose |
|---|---|---|
| `ApiKey` | — | **user-secrets only.** Never commit. |
| `Model` | `gpt-5.6-luna` | Provider model id. Verify against the provider's model list before changing — a wrong id fails as a 404 at call time, not at startup. |
| `ProviderBaseUrl` | `https://api.openai.com` | |
| `ReasoningEffort` | `low` | `none`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh`. Whether `low` holds accuracy is an open experiment that decides the v0.5 prefetch design. |
| `MaxOutputTokens` | `8000` | Must cover reasoning tokens as well as the JSON payload. |
| `SidecarBaseUrl` | `http://127.0.0.1:8001` | |
| `SidecarTimeoutSeconds` | `120` | CPU detection on a large page is slow. |
| `ProviderTimeoutSeconds` | `180` | |
| `CacheHours` | `24` | In-memory only; nothing survives a restart until v0.4. |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Model, reasoning effort, sidecar URL, whether a key is configured |
| `POST` | `/v1/translate` | `TranslateRequest` → `TranslatedPage` |

`POST /v1/translate` body — **frozen as of v0.2**, this is the seam between the
extension and the backend and between Chrome and Safari. Additive header changes
are fine; body changes are not.

```jsonc
{
  "imageB64": "...",        // required. bare base64 or a data: URL
  "seriesId": "my-series",  // required. stable per-series key, drives v0.4 glossary
  "targetLang": "en",       // only "en" in v0.2; anything else is 400
  "contentHash": "sha256:…" // optional. transit check only; server rehashes
}
```

Every region in the response carries `polygon`, `order`, `japanese`, `vertical`
from the sidecar and `english`, `kind`, `speaker`, `confidence` from the model.
`kind` is one of `bubble` | `sfx` | `narration` | `thought` — as a **string**.
It is a C# enum internally, so `Program.cs` registers a
`JsonStringEnumConverter` with camelCase naming; without it the wire format
silently reverts to integers and breaks the contract.

`order` is contiguous `0..n-1` and comes from the sidecar, never the model. A
region the model drops still renders, with the Japanese showing — a visible
failure, per v0.6.

A page with **no** detected text is a 200 with `regions: []`, not an error, and
it is cached like any other result. The overlay needs to be able to say "nothing
here" rather than hang.

### Status codes

| Code | When |
|---|---|
| `400` | Bad base64, or `targetLang` other than `en` |
| `500` | No API key configured (`api_key_missing`) |
| `502` | Provider call failed or returned unparseable output |
| `503` | Sidecar unreachable — usually means it isn't running |

Failures return an RFC 7807-ish body, never a bare 500. The extension maps 502
and 503 to plain-English toasts, so keep the codes meaningful.

## Trying it

Three steps. Step 2 prints nothing at all if it succeeds.

```bash
# 1. an image file on your Mac, not a URL
IMG=~/Downloads/page.jpg

# 2. build the request body (silent on success; check with `ls -la /tmp/req.json`)
python3 -c "
import base64, json, sys
b = base64.b64encode(open(sys.argv[1],'rb').read()).decode()
json.dump({'imageB64': b, 'seriesId': 'demo', 'targetLang': 'en'}, open('/tmp/req.json','w'))
" "$IMG"

# 3. POST it. 20-40s on a cold call, ~0.02s on a repeat (cache hit)
curl -s -X POST http://localhost:5080/v1/translate \
  -H 'content-type: application/json' \
  -d @/tmp/req.json \
  -w '\nhttp=%{http_code} wall=%{time_total}s\n' | python3 -m json.tool
```

## Tests

From `Yomi.Api.Tests/` — **not** from `backend/`, which has no solution file and
fails with "Specify a project or solution file":

```bash
cd Yomi.Api.Tests
dotnet test          # 14 passed
```

`YomiAppFactory` boots the real application in memory via
`WebApplicationFactory<Program>` and replaces exactly two things: `ISidecarClient`
and `ITranslationClient`, the only two components that would otherwise do network
I/O. Routing, JSON serialisation, the merge, the cache and the error mapping are
all the real ones. Swap the edges, keep everything in between honest.

Both replacements are **fakes, not mocks** — working implementations with
simplified behaviour, which record call counts so the cache tests can tell
whether the pipeline ran or the answer came from memory.

What is covered:

| Area | Tests |
|---|---|
| Merge | Sidecar geometry + model text combine correctly; a region the model drops still comes back with its Japanese |
| Wire format | `kind` serialises as a string; polygons stay normalised 0–1; `order` is contiguous |
| Cache | Identical repeat request skips the pipeline; a different `seriesId` misses |
| Errors | 400 on bad base64 and on `targetLang` ∈ {`fr`, `ja`, `""`}; 503 sidecar down; 502 translation failure |

The cache lives inside the running app and is not reset between tests — the
factory is shared by `IClassFixture` so the app boots once. That is why every
test uses its own `seriesId`. Reusing one silently turns the next test into a
cache hit and the fake sidecar never gets called.

`Program.cs` ends with `public partial class Program;` purely so
`WebApplicationFactory<Program>` can name the entry point of a top-level-statements
app. Deleting it breaks the test project's compile, not the API's.

## Cost

Each successful call logs one line:

```
Translated 24 regions with gpt-5.6-luna: in=3618 out=1266 reasoning=350
```

`out` already includes `reasoning`; do not add them. At $0.20/1M input and
$1.20/1M output (reasoning bills as output), measured on two real pages:

| Page | Pixels | Regions | Input | Output | Cost |
|---|---|---|---|---|---|
| Manga109 spread | 1654×1170 | 24 | 3,618 | 1,266 | $0.00224 |
| Phone-sized page | 2242×1594 | 22 | 5,152 | 1,237 | $0.00252 |

**Input tokens are dominated by the image, not the prompt.** Tokenising the
text locally gives ~1,377 (system 370 + region text 871 + schema 136), so on the
first page ~62% of input was the image alone. Note the second page used *more*
input with *fewer* regions — image tokens scale with resolution, not with how
much text is on the page.

Two consequences. The design doc's estimate of 1–1.5k input tokens per page
matches the text-only figure almost exactly and appears never to have counted
the image; true cost is 2.4–3.6× that. And the lever for reducing cost is
**downscaling images before upload**, not trimming the prompt — untested,
and it needs checking against detection quality first. The extension's
screenshot retrieval tier already uploads at viewport resolution rather than
native, which is a downscale by accident; it has not been measured against
detection quality either.

Responses carry `input_tokens_details.cache_write_tokens`, so provider-side
prompt caching is already engaging. `TranslationPrompt` puts everything stable
(system prompt, schema) ahead of everything per-page (series id, region text)
precisely so a cache breakpoint can sit between them. The v0.4 plan to put the
glossary in the stable prefix should pay off as designed.
