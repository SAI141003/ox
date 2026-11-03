# Testing ox

Thanks for trying ox. This takes about 15 minutes.

## 1. Install (Mac with Apple silicon)

1. Open Terminal and paste this line. It checks the download (an exact release, its published checksum) before installing, and does not open anything:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/SAI141003/ox/main/install.sh | sh
   ```

   Then open **OX** from Applications.
2. (Or by hand: download `ox-mac-arm64.zip` from [Releases](https://github.com/SAI141003/ox/releases), unzip, drag **OX** to Applications. macOS then blocks the first open: System Settings › Privacy & Security › **Open Anyway**.)
3. In OX, open **Settings › API keys** and add a key. A free NVIDIA key works: [build.nvidia.com](https://build.nvidia.com).

## 2. Allow access only for what you test

Nothing is asked at launch. OX asks the first time you use something that needs a permission, and everything else works without it. Use a test account and test files, and grant only what you are testing:

- **Microphone** and **Speech Recognition**: only for talking to ox
- **Accessibility**: only for ox typing and clicking in other apps for you
- **Screen Recording**: only for ox finding buttons on screen

You can turn any of them off again in System Settings › Privacy & Security; ox keeps working, without that feature.

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
