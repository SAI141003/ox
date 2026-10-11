# E2E Clicky — End-to-End Voice + Computer Control

Run this on macOS for meeting demo. Each step has expected result + failure recovery.

## Prerequisites Check

```bash
# All should succeed:
ox -p "echo hello" --json
ox serve --port 18080
# (in another terminal) curl http://localhost:18080/health → {"status":"ok",...}
```

If any fail: fix that component before proceeding.

## Step 1: Onboarding

```bash
ox clicky onboard
```

**Expected**: Permission checklist output with current status of Mic, Accessibility, Screen Recording.
**Failure recovery**: Manually add Terminal.app to System Settings → Privacy & Security.

## Step 2: Voice Transcription (no agent needed)

```bash
# Record 5s of audio to a WAV file, or use existing file:
echo "$(base64 -i /path/to/audio.wav)" | ox listen
```

**Expected**: Transcript text printed to stdout.
**Failure recovery**: If whisper fails, check VOICE_STT_BACKEND. Try `VOICE_LOCAL_ONLY=0`.

## Step 3: Agent + Operator (text mode, no mic)

```bash
ox -p "open Chrome" --yes-edits
```

**Expected**: Agent runs, requests approval for open_app("Chrome"), executes, confirms "Opening Chrome."
**Failure recovery**: If Chrome already open, agent should note it. If permission fails, check trust level.

```bash
ox -p "open https://backboard.io" --yes-edits
```

**Expected**: Default browser opens to backboard.io.
**Failure recovery**: Check `open` command works in terminal.

```bash
ox -p "open this project in Finder" --yes-edits
```

**Expected**: Finder opens at project directory.
**Failure recovery**: Check `pwd` returns valid path.

## Step 4: Serve API

```bash
# In one terminal:
ox serve --port 18080 --api-key

# In another terminal:
curl -s http://localhost:18080/health | python3 -m json.tool
curl -s -X POST http://localhost:18080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OX_SERVE_API_KEY" \
  -d '{"model":"ox","messages":[{"role":"user","content":"hello"}]}' | python3 -m json.tool
```

**Expected**: Health returns ok. Chat completions returns valid JSON with choices[0].message.
**Failure recovery**: Check OX_SERVE_API_KEY is set. Check port isn't in use.

## Step 5: Coding Still Works

```bash
ox -p "explain what src/serve.js does in 3 bullet points"
ox -p "write a test for src/tools/operator.js" --yes-edits
```

**Expected**: Agent explains serve.js in bullets. Agent writes valid test.
**Failure recovery**: If agent refuses, check approval level.

## Step 6: Desktop (if built)

```bash
cd desktop && npm run dev &
# Tauri app opens → type a prompt → observe streaming response
```

**Expected**: Chat panel responds with streaming text. File tree loads.
**Failure recovery**: Check tauri.conf.json devUrl matches Vite port.

## Step 7: Backboard Integration (if configured)

```bash
export OX_BASE_URL=https://api.backboard.io/v1
export BACKBOARD_API_KEY=bb_live_xxx  # your key
ox --bot backboard -p "what can you do?"
```

**Expected**: Agent uses backboard model. Responses work.
**Failure recovery**: Check API key is valid. Check network to api.backboard.io.

## Success Criteria

- [ ] Voice transcription returns text
- [ ] Agent opens apps/URLs on approval
- [ ] Serve API responds to chat completions
- [ ] Agent explains code accurately
- [ ] Agent writes working tests
- [ ] (Desktop) Chat panel streams responses
