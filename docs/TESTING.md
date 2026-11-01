# Testing ox

Thanks for trying ox. This takes about 15 minutes.

## 1. Install (Mac with Apple silicon)

1. Download `ox-mac-arm64.zip` from [Releases](https://github.com/SAI141003/ox/releases), unzip it, and drag **OX** to Applications.
2. Open OX. If macOS blocks it: System Settings › Privacy & Security › **Open Anyway**.
3. In OX, open **Settings › API keys** and add a key. A free NVIDIA key works: [build.nvidia.com](https://build.nvidia.com).

## 2. Allow access (once)

When macOS asks, choose **Allow**. If a toggle is missing, open System Settings › Privacy & Security and turn on both **OX** and **OX Island** in:

- **Microphone** and **Speech Recognition**: talking to ox
- **Accessibility**: typing and clicking for you
- **Screen Recording**: finding buttons on screen

## 3. Try these

Click the mic in the notch (or hold ⌃⌥Space) and say:

| Say | You should see |
|---|---|
| "open calculator" | Calculator opens |
| "open text editor and type hello" | TextEdit opens with "hello" |
| "what time is it" | ox says the time |
| "open WhatsApp and send a message to *a contact*" | that person's chat opens; nothing is sent |
| "what is the capital of Japan" | ox answers "Tokyo" |

Then in the OX window:

- **Studio**: make an image ("a red panda in the snow").
- **Settings › Your own model**: pick Qwen 0.5B, paste 20 or more `Q:` / `A:` lines, Train, Try, Use.

## 4. Tell us what happened

For anything that did not work, send:

1. What you said or clicked, and what happened instead.
2. The output of these, from Terminal:

```bash
ox doctor
tail -20 ~/.ox/island.log
```

ox never sends messages, pays or deletes anything without asking you first.
