# Yomi backend — v0.2

ASP.NET Core minimal API. Orchestration, caching, and the LLM call.

Takes a page image, asks the [sidecar](../sidecar/README.md) where the text is
and what it says, sends both to a vision model for translation, merges the two,
and returns a `TranslatedPage`. Geometry and reading order come from the
sidecar; only the language fields come from the model.

## Licence note

This project is **AGPL-3.0** — deliberately, and deliberately different from the
sidecar's GPL-3.0.

The two are separate processes talking over HTTP, and that seam is the licence
boundary. The sidecar is GPL because it links `comic-text-detector`; nothing
GPL is linked here. AGPL was chosen rather than inherited, and it is the
stronger of the two in one specific way: **GPL obligations trigger on
distribution, AGPL triggers on network use.** Running this backend as a hosted
service for other people carries source obligations that merely shipping it
would not. That is fine for the intended single-user, localhost deployment, and
is a decision to revisit before anything is ever hosted.

Do not add a project reference between `backend/` and `sidecar/`, and do not
merge the processes. The separation is load-bearing, not incidental. The browser
extension must contain no GPL or AGPL code at all.

## Setup

Needs the .NET 10 SDK (`dotnet --version` should print `10.x`).

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
than a port conflict.

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

### Status codes

| Code | When |
|---|---|
| `400` | Bad base64, or `targetLang` other than `en` |
| `502` | Provider call failed or returned unparseable output |
| `503` | Sidecar unreachable — usually means it isn't running |

Failures return an RFC 7807-ish body, never a bare 500.

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
and it needs checking against detection quality first.

Responses carry `input_tokens_details.cache_write_tokens`, so provider-side
prompt caching is already engaging. The v0.4 plan to put the glossary in the
stable prefix should pay off as designed.
