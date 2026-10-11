# Meeting Demo Script — Minute-by-Minute

**Total time**: ~10 minutes  
**Presenters**: 1 (switching between terminal, voice, and desktop)

## Minute 0–2: Setup & Context

**Slide**: "ox — talk, act, code"

Terminal:
```bash
ox --version
# ox 0.1.0
```

Point out: zero npm runtime deps, sub-150ms startup.

```bash
ox -p "explain what ox is in one sentence"
```

**Expected**: Accurate one-sentence explanation. Shows the core agent loop works.

## Minute 2–4: Voice Pipeline

**Slide**: "Microphone → STT → Agent → Action"

Terminal — show STT works without agent:
```bash
echo "$(base64 -i /tmp/demo-audio.wav)" | ox listen
# → "open chrome and go to gmail"
```

**Key point**: Privacy. Voice stays local (`VOICE_LOCAL_ONLY=1`). No cloud STT required.

```bash
ox clicky onboard
```

**Show**: Permission checklist output. Emphasize: permissions are explicit, not silent.

## Minute 4–6: Operator — Open Things

**Slide**: "Open anything on my Mac — approval-gated"

```bash
ox -p "open Chrome"
```

**Show**: Approval prompt in terminal → approve → Chrome opens.

```bash
ox -p "open https://backboard.io"
```

**Show**: Browser opens to backboard.io.

```bash
ox -p "open my Downloads folder"
```

**Show**: Finder opens at Downloads.

**Key point**: Every action needs approval (or --yolo). Nothing happens silently.

## Minute 6–8: Coding + Serve API

**Slide**: "Same agent. Codes too."

```bash
ox -p "explain what src/serve.js does in 3 bullet points"
```

**Show**: Accurate 3-bullet explanation of the HTTP server.

```bash
# In another terminal:
curl -s http://localhost:18080/health
# {"status":"ok","timestamp":"..."}
```

```bash
curl -s -X POST http://localhost:18080/v1/chat/completions \
  -H "Authorization: Bearer $OX_SERVE_API_KEY" \
  -d '{"model":"ox","messages":[{"role":"user","content":"hello from API"}]}'
```

**Show**: Valid JSON response with assistant message.

**Key point**: serve is the local bus — desktop, voice, CLI all share the same agent loop.

## Minute 8–10: Competitive Positioning + Close

**Slide**: "Coexistence, not competition"

Show comparison.md row 18 (Telemetry: none by default → ox ✓)
Show comparison.md row 27 (ox serve HTTP surface → ox ✓)

Show docs/E2E_CLICKY.md as the runnable checklist.

**Close**: "ox is one platform for voice, computer control, and coding. Local-first, approval-gated, BYOK. Demo is rehearsed in docs/E2E_CLICKY.md."

## Contingency

| If X goes wrong | Do this |
|---|---|
| Voice STT fails | Show `ox listen` output from pre-recorded file. Say: "STT is local — here's a test file." |
| Browser doesn't open | Run `open https://backboard.io` manually. Say: "Approval already granted." |
| Serve not running | Start it live: `ox serve --port 18080 &` then demo curl |
| Agent gives bad answer | Try different prompt. Agents vary. |
| Desktop crashes | Skip to terminal demo — desktop is optional. |

## Rehearsal Checklist

Run this before the meeting:

```bash
# 1. Ensure all commands work
ox --version && ox -p "hello" && ox serve --port 18080 &
# 2. Ensure serve responds
curl http://localhost:18080/health
# 3. Ensure voice works (if mic available)
echo "$(base64 -i /tmp/test.wav)" | ox listen
# 4. Run all tests
npm test
```
