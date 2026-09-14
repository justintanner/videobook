# Voice input fixtures

These WAV files contain synthetic test speech made locally with macOS `say`, voice
Samantha, converted with FFmpeg to mono 48 kHz PCM. They are test
inputs, not recordings of a user or samples of OpenAI output.

`ready`, `colors`, `storyboard` and `moon` are ordinary short requests for the repeated
latency comparison. `assets`, `rename`, `duplicate` and `generate` exercise workspace
tools. `review` combines the rename request, nine seconds of silence, and “Yes, apply
that change” to verify that speech cannot bypass on-screen review. `interrupt` asks
for a slow count, pauses 2.5 seconds, then says “Stop. Say ready.” The browser fixture
adds leading silence for negotiation and trailing silence to avoid accidental
overlapping repetitions during an individual case.

`duplicate` includes deterministic pink noise mixed with FFmpeg's `anoisesrc`
(`amplitude=0.008`, `seed=42`) to exercise a grid-reference command with background
noise. OpenAI replies are obtained live rather than stored in this fixture directory.
