# research-agent (AI research proxy)

Server-side AI agent that powers Catalyzed Alpha's **AI Niche Discovery** feed and
the Blueprint tab. The desktop client POSTs `{ ticker?, companyName?, narrative?,
themes?, task }` and gets back the structured `ResearchIntel` JSON contract, which
the app renders into its **card UI** (ticker suggestions, themes, catalysts) - this
is AI-*assisted* discovery, never a chat dump. The LLM key stays here on the
server; it is **never** shipped in the desktop bundle.

## Two provider modes - pick whichever FREE key you have

You only need **one** working key. Configure both and the function uses one as the
primary and the other as automatic fallback. Every upstream call has a hard
timeout, so the function **can never hang** (the old version did, which silently
froze the feed onto its anchor fallback list).

| Mode | Secret(s) | Web-grounded? | Get a free key |
| --- | --- | --- | --- |
| **Gemini** (recommended) | `GEMINI_API_KEY` (+ optional `RESEARCH_MODEL`) | ✅ live `google_search` | https://aistudio.google.com/apikey |
| **OpenAI-compatible** | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` | ❌ model knowledge only | Groq / NVIDIA NIM / OpenRouter (below) |

Gemini is preferred because its `google_search` grounding gives **fresh,
news-driven** results (e.g. a catalyst that broke this morning). The
OpenAI-compatible lane is fast and reliable on free tiers but answers from model
knowledge, so use it as a fallback or when Gemini's free quota is exhausted.

### Choosing the Gemini model (`RESEARCH_MODEL`)
The Gemini key (`GEMINI_API_KEY`), endpoint, and model are all configurable; only
the model needs a thought. The default is **`gemini-2.0-flash`** because it has by
far the most generous free daily quota *and* keeps `google_search` grounding, so
the discovery feed rarely hits a limit. Override it per your needs:

| `RESEARCH_MODEL` | Free quota | When to use |
| --- | --- | --- |
| `gemini-2.0-flash` (default) | most generous | day-to-day discovery; best uptime |
| `gemini-2.5-flash` | medium | a quality bump while staying grounded |
| `gemini-2.5-pro` | **restrictive** | deepest synthesis; expect to hit free limits sooner |

```bash
supabase secrets set RESEARCH_MODEL=gemini-2.5-pro
```
All three speak the same request/response shape, so the `ResearchIntel` JSON
contract the app consumes is unchanged regardless of model.

### Free OpenAI-compatible endpoints (typically "paid" models, free tier)
| Provider | `LLM_BASE_URL` | Example `LLM_MODEL` | Free key |
| --- | --- | --- | --- |
| Groq (fastest) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | https://console.groq.com/keys |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.1-70b-instruct` | https://build.nvidia.com |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` | https://openrouter.ai/keys |

## Deploy (Supabase)
1. Get at least one free key from the tables above.
2. Install the CLI and link your project:
   ```bash
   npm i -g supabase
   # On Windows, if `supabase login` doesn't carry over, create a token at
   # https://supabase.com/dashboard/account/tokens and set it first:
   #   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."
   supabase link --project-ref <your-project-ref>
   ```
3. Set the secret(s) - server-side only, never in the app bundle:
   ```bash
   # Gemini path:
   supabase secrets set GEMINI_API_KEY=your_key
   # optional: supabase secrets set RESEARCH_MODEL=gemini-2.0-flash

   # OR an OpenAI-compatible path (e.g. Groq):
   supabase secrets set LLM_API_KEY=gsk_your_key
   supabase secrets set LLM_BASE_URL=https://api.groq.com/openai/v1
   supabase secrets set LLM_MODEL=llama-3.3-70b-versatile

   # optional, when BOTH are set - choose the primary: gemini | openai | auto
   supabase secrets set RESEARCH_PROVIDER=auto
   ```
4. Deploy:
   ```bash
   supabase functions deploy research-agent --no-verify-jwt
   ```
5. Point the app at it in `.env`:
   ```
   VITE_RESEARCH_PROXY_URL=https://<your-project-ref>.functions.supabase.co/research-agent
   ```
6. Restart `npm run tauri dev`. The AI Niche Discovery feed and Blueprint's
   **AI deep research** turn on.

## Verify it works (not hanging)
```bash
curl -s -X POST "$VITE_RESEARCH_PROXY_URL" \
  -H "Content-Type: application/json" \
  -d '{"task":"discover","narrative":"quantum computing small caps","themes":["quantum"]}'
```
You should get JSON back within ~20s. If you see `{"error":"All research
providers failed", ...}` the `detail` field tells you exactly which provider
failed and why (bad key, quota, etc.). It will **never** hang indefinitely.

## Free-tier limits
Free tiers are rate-limited per minute/day. When you hit a limit the call fails
fast (you are never charged) and - if configured - the function falls back to the
other provider; otherwise the client backs off and uses its anchor universe until
the limit resets. Configuring **both** a Gemini key and a Groq/NVIDIA key gives
the most uptime for $0.

## Swap the model/provider
Any agent works as long as it returns the same `ResearchIntel` JSON shape. Keep
secrets in `supabase secrets`, respect each provider's terms, and never scrape
prohibited sites. Research/discovery only - the system prompt forbids buy/sell advice.
