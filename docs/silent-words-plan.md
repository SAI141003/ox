# Silent words: our own mouthed-word system

Goal: with earphones in, you mouth a word and ox acts on it. No sound, no typing.

## How Subvox works (what we ported, `desktop/island/Sources/Subvox`)

1. **Sensor.** `CMHeadphoneMotionManager` streams the AirPods' processed motion: user
   acceleration (g), rotation rate (rad/s), attitude (pitch, roll, yaw), gravity and a
   quaternion, about 25 times a second (`HeadphoneMotionService`, `MotionSample`). It is
   head and jaw movement picked up by the earbuds, not sound: the speech accelerometer and
   the inward microphone are not open to apps.
2. **Cutting words out of the stream** (`CaptureController`). Activity per frame is
   `|rotation| + 5·|acceleration|`, smoothed (0.6/0.4). Either you hold Space while you mouth
   the word, or auto-detect: 2 s of calibration sets a noise floor (median), a word starts when
   activity passes 3× the floor (with 0.3 s of pre-roll) and ends after 0.35 s below 0.7× the
   threshold, at most 3 s (6 s when held).
3. **Features** (`MotionFeatures`). Quiet frames at both ends are trimmed (threshold 15% of
   the way from the 20th-percentile to the peak). Each frame is 9 numbers: acceleration (3),
   rotation (3) and attitude change since the word started (3). Each channel is mean-centred
   (removes posture), then divided by its spread across all the training takes so no channel
   dominates.
4. **Matching** (`DTW`, `TemplateClassifier`). Dynamic time warping with a Sakoe–Chiba band
   (25%), so a word said faster or slower still lines up, normalised by path length. The
   nearest training take per word wins. A word is refused when its distance is over *max
   distance* (1.5) or when the margin to the runner-up, `1 − best/second`, is under *min
   confidence* (0.05).
5. **Is it real?** (`Evaluation`). Leave-one-out accuracy over your takes, compared with the
   same thing on 500 label shuffles. p < 0.05 means the motion tells your words apart better
   than chance. There is a confusion matrix, and the three channel groups can be switched off
   to see which carry the signal.
6. **Recording** (`SessionRecorder`): `motion.csv`, `audio.caf`, `events.csv`, `meta.json` per
   session, for the normal / whisper / silent comparison.

What it is honestly good for: a **small vocabulary you trained yourself** (yes, no, next,
stop…). Takes are specific to you and to how the earbuds sit; re-seating them can shift the
signal. Open-ended sentences are out of reach from this sensor alone.

## What ox has today (shipped)

- All of Subvox, unchanged, in **Silent Words.app** (`ox island silent`, or Island controls).
- **Send words to ox**: each accepted word is written to `~/.ox/subvox/words.jsonl`; the island
  answers a waiting approval with a mouthed **yes/allow/approve/ok** (allow once) or
  **no/deny/stop/cancel** (deny). Never "always allow". Words older than 10 s are ignored.

## Plan: from a port to our own system

### Phase 1: measure on your AirPods (1 day, you + ox)
- Train 5 words × 10 takes each, under Normal, Whisper and Silent (the Subvox protocol).
- Run Evaluate for each feature set. Ship only the words that reach ≥ 90% leave-one-out with
  p < 0.05; the rest are confused with each other and get dropped or renamed.
- ox records the numbers (`~/.ox/subvox/evals.jsonl`) so every later change is compared with them.

### Phase 2: the ox engine (our own code, replacing the demo screens)
- **Always-on, hands-free capture** in the island itself (no window, no Space): auto-detect
  with a per-session calibration, a short "arm" gesture (a double nod) before a word counts, so
  chewing and talking do not trigger it.
- **Fewer takes, more robust**: augment each take (time stretch 0.8–1.25×, small noise, small
  rotations of the axes) and keep the 3 best templates per word; recalibrate with 2 anchor words
  when the earbuds are re-seated (detected from a jump in the gravity vector).
- **A learned matcher on this Mac**: a small 1-D CNN embedding (Core ML, trained on your own
  takes in seconds) with nearest-centroid matching; DTW stays as the fallback and as the judge
  in the evaluation, and the embedding only replaces it when it measures better.
- **Command words → actions** (a small grammar): yes/no (approvals), next/back (cards, slides,
  music), stop (stop the run, stop reading), open + app name, "note" (start a voice note).
  Each word maps to one action you choose in Settings › Silent words.
- **Safety**: silent words can allow once, deny, stop and navigate. Anything that sends,
  pays, deletes or "always allows" still needs a click or the spoken voice confirmation.

### Phase 3: more signals (when the motion alone is not enough)
- **Lip reading from the camera** when you sit at the Mac: an on-device visual speech
  recognition model reads the mouth (works for whole sentences, unlike the IMU); the AirPods
  motion confirms that you, the wearer, are the one mouthing.
- **Whisper**: a barely-voiced whisper is transcribed by the existing Whisper path; motion
  decides that it was you and not someone near you.
- **Fusion**: each source gives a word and a confidence; ox acts only when the combined
  confidence clears the bar for that action.

### Phase 4: everywhere ox runs
- iPhone with AirPods (same Core Motion API on iOS) through the mesh, so silent words work away
  from the Mac; the Windows island gets the camera path only.

## How we will know it works
- Per word: leave-one-out accuracy, permutation p-value, false triggers per hour of normal
  talking and chewing (target < 1), time from mouthing to action (target < 600 ms).
- An evaluation suite like `ox island evals` for silent words, run on recorded sessions, so a
  change that lowers accuracy is caught before it ships.

Credit: Subvox by Joe Blau, github.com/joeblau/subvox, MIT.
