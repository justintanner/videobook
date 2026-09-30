# Voice chat

Voice is an optional input/output mode in the existing command composer. Its COMMS
control has a 44px target, keyboard activation, visible focus, `aria-pressed`, and
text states for connecting, listening, thinking, speaking, review, off, and error.
The segmented ring follows measured microphone or decoded playback energy. Reduced
motion removes scaling and glow; captions remain selectable and expandable. The
ordinary command editor retains its draft and rich references during voice turns.

Choose **Auto**, **OpenAI**, or **xAI** beside the microphone. Auto is the default:
it tries OpenAI, then xAI once if startup fails because of provider access, credits,
rate limits, or availability. The COMMS badge shows the connected provider; the
fallback notice expands to show why OpenAI was unavailable. Explicit provider
choices stay pinned. The browser remembers the choice but never restores microphone
access on reload. Changing provider stops the current channel and keeps any pending
action review; press Start to connect again. An established conversation never
switches providers or replays its audio or actions automatically.

If a reply makes no progress for 15 seconds, the session cancels that response and
retries once on the same connection. It waits up to five seconds for cancellation
before continuing, ignores late events from the abandoned response, and reuses any
accepted action outcome. A second stall shows a connection error and releases the
microphone. This recovery does not execute an accepted action again.

## Transport and configuration

The browser captures audio only after the user starts voice. It sends an SDP offer
to the same-origin Videobook server. `@apicity/openai` creates the Realtime call and
owns its authenticated server sideband. Browser WebRTC carries media, while typed
application events carry captions and action proposals. The server returns a random
session owner token; permanent provider keys stay on the server.

For xAI, `@apicity/xai/realtime` owns the authenticated provider WebSocket. The browser
uses a same-origin WebSocket authenticated with the session owner token in its first
message to send 48 kHz mono PCM16 captured by an AudioWorklet. An explicit 48 kHz
AudioContext resamples hardware capture, including devices running at 96 kHz.
The existing authenticated HTTP event stream carries xAI's 24 kHz PCM replies,
captions, and actions. Browser audio transport never contacts xAI directly. Both
directions have bounded buffers; disconnect closes capture, playback, and the
provider connection. `XAI_API_KEY` enables xAI; `OPENAI_API_KEY` enables OpenAI.

The vendored provider is `@apicity/openai` 0.11.0 built from Apicity commit
`828e37730593c8fd069c2302c7ecab772906b4e6`. The package contains the Realtime call,
hangup, and server control APIs missing from the prior dependency. Its provenance is
recorded in [`vendor/OPENAI_REVISION.txt`](../vendor/OPENAI_REVISION.txt). No application
HTTP or WebSocket wrapper bypasses the provider.

The vendored `@apicity/xai` 0.11.0 package includes the server Realtime transport from
Apicity commit `7c5e2e56`. Its revision and checksum are recorded in
[`vendor/XAI_REVISION.txt`](../vendor/XAI_REVISION.txt).

| Setting | Value |
| --- | --- |
| Voice model | `gpt-realtime-2.1`; override with `VIDEOBOOK_VOICE_MODEL` |
| Reasoning | `minimal` |
| Turn detection | Server VAD, threshold 0.5, 350 ms silence, 300 ms prefix |
| Input | Near-field noise reduction; native speech-to-speech |
| Display transcription | `gpt-4o-mini-transcribe` |
| Output | `alloy`, speed 1, terse replies, maximum 512 output tokens |
| Idle limit | 120 seconds; `VIDEOBOOK_VOICE_IDLE_TIMEOUT_MS` clamps to 10–600 seconds |
| Lifetime/concurrency | 30 minutes; four sessions per server |
| Startup deadline | 30 seconds for a pinned provider; 80 seconds for Auto, including failed-call cleanup and fallback |

The copilot speaks as one character on both providers: Videobook's computer, a
1980s mainframe AI — literal, precise, impersonal. One short line per reply,
outcome first; fixed vocabulary (`Affirmative.` `Negative.` `Complete.`
`Standing by.` `Unable to comply. <reason>.` `Specify <detail>.` `Review
pending. <what, where>.` `Queued. <what, where>.`) used verbatim, because
repetition is the character. No jokes, asides, apologies, hedges, or filler.
It fills an action in from the request and the supplied workspace rather than
interviewing the speaker, so a parameter the discovered schema marks optional
is omitted rather than asked for. `expected_revision` is such a parameter on
every tool that accepts it.

xAI uses `grok-voice-think-fast-2.0`, Sal's voice, reasoning effort `none`, and the
same 350 ms VAD silence setting. `VIDEOBOOK_XAI_VOICE_MODEL` overrides the xAI model, and
`VIDEOBOOK_XAI_REALTIME_URL` points the same client at another realtime endpoint — a local
gateway, or the integration test's server; unset, voice talks to xAI.
Its native speech model supplies input captions. These settings follow the current
[xAI voice API](https://docs.x.ai/developers/rest-api-reference/inference/voice);
they do not establish a latency ranking against other providers.

## Activation line

Starting voice greets the speaker with exactly `Voice Chat Activated`, spoken in
the session voice and shown as a COPILOT bubble. Nothing speaks when the session
descriptor returns: OpenAI's audio rides the WebRTC track, which is not flowing
yet, so the browser posts `ready` (`POST /api/voice/:id/ready`) once its media
path is up, and only then does the server speak the line — once per session,
and only while the session is pristine. xAI receives a `force_message`
`conversation.item.create`; OpenAI receives a `response.create` with empty
input and per-response instructions. The line is canonical in the caption
whatever the transcript says, is excluded from the voice-chat log and
workspace context (including after a barge-in), and errors it provokes drop
the line instead of the session.

Input transcription supplies captions and durable prompt history. It is not a
separate speech-to-text/chat/text-to-speech response pipeline. Workspace actions wait
for the finalized user prompt to be saved before execution. Text routing continues
to use the existing text model catalog.

## Command behavior and lifetime

Realtime discovers the registered action schemas and proposes a tool with parameters.
Discovery prioritizes the requested operation over generic media/cell words, so a
query such as “rename cell” keeps `rename_asset` visible. Media actions use the cell's
artifact ID; bulk actions require an explicit bulk request.
`prepareVoiceChatAction` reuses the text chat service's reference resolution, routing,
schema validation and action-plan policy without another chat model request. Reads
return their actual result. Auto-apply, reviewed mutations, generation consent,
canonical revisions and queued domain work use the existing application handlers.
A chained request is one action with several steps. Steps that only read or
auto-apply run straight through; every step that spends provider money stops
first and raises its own review carrying that step's estimated cost, or saying
the cost is unknown when the model publishes no rate. Applying spends that step
and moves to the next, which arrives as another review, so the session keeps its
lock until the chain ends. Cancelling one step drops every remaining step —
later steps consume its output — and leaves finished work in place. A chain step
cannot be revised, only applied or cancelled.

A request to show, open or enlarge a cell's image or video is a view, not a
change. `show_media_fullscreen` is discovered like any other action, accepts the
cell's artifact ID or its spoken address, and opens the fullscreen viewer at once
without a review; typed chat routes the same request the same way. It is not an
MCP tool: the server only resolves the cell and the app opens the viewer. An empty
cell or one holding audio is refused with the reason. Fullscreen still ends voice
as described below, so the viewer opens without a spoken confirmation. This
holds when voice itself opened the viewer: the image viewer swaps the composer
to its image-edit session, video playback would feed the microphone, and a
review raised behind the modal dialog could not reach Apply or Cancel — so the
channel ends and resumes only with an explicit click after the viewer closes.

The workspace reaches the model three ways. It is in the instructions at
connect; it rides along with every tool result, cells only, so the transcript is
not resent and cannot crowd out the result; and a `session.update` replaces the
instructions' copy whenever the board changes, checked once a second and only
between turns, since an update mid-response would land inside the model's own
sentence. Only the instructions change in that update — resending the model or
the audio settings would renegotiate a live call for nothing. A picture can
still lag a change made a moment ago, so a spoken address the model cannot find
is passed through rather than refused, and the action resolves it against the
live workspace.

Only Apply or Cancel on screen resolves a pending review. A spoken yes cannot approve
an operation, and turning voice off leaves the review available. Spoken feedback
distinguishes an action awaiting review, a queued job, completion, cancellation and
failure.

Spoken addresses such as “A1” or “A one” refer to `@a1`. Generic generation requests
use the same default actions as typed chat and retain the address in the generation
prompt. Exact action discovery returns that action's schema; broader searches still
return up to eight matches. Voice completes discovery and preparation before
speaking the actual result or asking for a missing detail. Every speech segment starts
a new turn, so a call the model made for an earlier one — the speaker added a clause,
or just asked whether it was working — is dropped rather than run against the newer
request. It is still answered as dropped: an unanswered call leaves the model
believing the work is running, so it narrates a generation that never started while
the screen stays empty.

Sessions are bound to their book, notebook and owner. Turn, response and function IDs
deduplicate events; old-scope proposals cannot enter the current workspace. Finalized
user/assistant text is stored through engine prompt history and logs. Interrupted
assistant history is amended so unheard text is omitted from the next conversation's
context. Raw microphone recordings and owner tokens are not persisted by Videobook.
Session diagnostics contain duration and observed response token totals, not audio
or transcript content.

Stop immediately disconnects local playback and ends microphone tracks. Barge-in
silences local decoded output while Realtime cancels/truncates its response. Hiding
the page or composer, changing workspace, opening fullscreen, playing other media,
capture loss, disconnect and server shutdown also end voice. An explicit click is
required to resume. Missing credentials, denied permission and connection failures
leave text chat usable. Browser autoplay recovery is exposed as **Enable spoken
replies**.

## Connection limits and billing

OpenAI can return HTTP 429 for both temporary rate limits and exhausted credits or
account limits. Voice reads the provider error code before choosing recovery text,
including errors received during replies or transcription. Provider messages and
raw error payloads are not sent to the browser.

| Error | Recovery |
| --- | --- |
| `credit_balance_exhausted` | Add API credits in [OpenAI billing](https://platform.openai.com/settings/organization/billing/), then start voice again. |
| `project_spend_limit_exceeded` | Review the project's spend limit in OpenAI settings. |
| `organization_spend_limit_exceeded` | Review the organization's spend limit in OpenAI settings. |
| `organization_usage_limit_exceeded` | Review the organization's approved usage limit. |
| `insufficient_quota` | Check API credits and usage limits. |
| `rate_limit_exceeded` / `slow_down` | Wait before explicitly starting voice again. |

Waiting alone does not resolve exhausted credits or account limits. An unclassified
429 asks the user to check billing and usage limits without promising a temporary
failure. See the [official OpenAI error guide](https://developers.openai.com/api/docs/guides/error-codes).

## Reproducible validation

Normal integration tests use real book engines and local HTTP servers. Browser tests
use real Chromium capture, WebRTC and decoded audio with synthesized WAV microphone
input. They do not stub the provider or replace browser media APIs. Chromium's native
permission controls exercise denial and capture revocation. Real provider calls are
opt-in and run separately from the normal suite's credential/network restrictions.

```bash
npx vitest run server/src/tools/voice-chat-action.test.ts server/src/tools/voice-session.test.ts
npx vitest run --config vitest.e2e.config.ts tests/v2/voice-activation.e2e.test.ts
npx vitest run --config vitest.e2e.config.ts tests/v2/voice-chat.e2e.test.ts
op run --env-file=.env.tpl -- npm run test:voice:live
VIDEOBOOK_VOICE_TEST_MODE=xai op run --env-file=.env.tpl -- npm run test:voice:live
VIDEOBOOK_VOICE_TEST_MODE=xai VIDEOBOOK_VOICE_TEST_PREVIEW=1 op run --env-file=.env.tpl -- npm run test:voice:live -- -t 'captures real'
VIDEOBOOK_VOICE_TEST_OPENAI_UNAVAILABLE=1 op run --env-file=.env.tpl -- npm run test:voice:live -- -t 'captures real|cancels Auto'
VIDEOBOOK_VOICE_TEST_MODE=openai VIDEOBOOK_VOICE_BENCHMARK_TURNS=20 op run --env-file=.env.tpl -- npm run test:voice:live -- -t 'captures real'
VIDEOBOOK_VOICE_TEST_MODE=openai VIDEOBOOK_VOICE_MODEL=gpt-realtime-2.1-mini VIDEOBOOK_VOICE_BENCHMARK_TURNS=20 op run --env-file=.env.tpl -- npm run test:voice:live -- -t 'captures real'
```

The browser fixture defaults to installed Chrome. `PLAYWRIGHT_CHANNEL` selects a
different installed Chromium channel. Artifacts go to ignored `test-results/voice/`;
benchmark filenames include the model and turn count so a smoke run does not replace
a longer measurement. The committed [measurement record](voice-latency.json) contains
numeric measurements and conditions without conversation text or session credentials.

The comparison used Chrome 152.0.7977.83, a local Videobook/Vite server, unthrottled
WebRTC and four prerecorded ordinary requests repeated five times per model. These
are development-machine observations, not a provider latency guarantee or an
exhaustive ranking of OpenAI models.

| Model | Turns | Median detected-turn-end to decoded output | p95 | Cold connect |
| --- | ---: | ---: | ---: | ---: |
| `gpt-realtime-2.1-mini` | 20 | 881 ms | 1,169 ms | 2,940 ms |
| `gpt-realtime-2.1` | 20 | 661 ms | 902 ms | 2,649 ms |

The full model was faster in this same-fixture comparison and correctly handled the
tested grid reference and review command, so it is the default. The table starts at
receipt of the provider's `speech_stopped` event. It excludes VAD silence and uplink
time. The fixture also measures from the last microphone sample above the signal
threshold to decoded assistant output, separately from the provider event metric.
Neither measure treats a tool acknowledgement as completed domain work.
The output measurement detects nonzero PCM in the browser playback graph. It does
not include physical speaker latency or an external microphone loopback.

A second 20-turn run of the selected model measured 1,367 ms median and 1,550 ms
p95 from the last microphone sample above the signal threshold to decoded output.
The p95 missed the initial 1,500 ms target by 50 ms. The 350 ms VAD silence setting
is retained to allow short pauses within a request. Detected-turn-end to output in
that run was 650/837 ms median/p95, with a 2,484 ms cold connection. First assistant
caption latency from detected turn end was 308/483 ms across 20 turns. Final caption
latency was 1,573/2,782 ms across 19 completed captions; the last response was stopped
after its first decoded audio was measured.

A representative barge-in silenced the decoded output in 25 ms, within the 250 ms
target. A spoken rename reached the ordinary review sheet in 2,759 ms from detected
turn end, including tool discovery and validation. Those are single interaction
samples, separate from the ordinary-turn distribution. Live cases also covered a
grid reference with pink noise, an intentional pause, explicit Apply, spoken approval
refusal, Cancel after voice off, reads, duplication, generation preview without a paid
job, microphone revocation, offline/project/fullscreen teardown, and 320px/short-screen
review layouts. Physical microphone hot-unplug and hardware speaker latency were not
measured; native capture loss was exercised with Chromium permission revocation.

Official references checked on 2026-09-14:
[GPT Realtime 2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1),
[GPT Realtime 2.1 mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini),
[Realtime](https://developers.openai.com/api/docs/guides/realtime),
[server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=realtime),
and [VAD](https://developers.openai.com/api/docs/guides/realtime-vad).
