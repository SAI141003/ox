# Voice in Ox

Ox has two separate voice paths. They are deliberately described separately so
that a microphone button, a wake-word toggle, and a completed command are not
confused with one another.

## Dictation

The command-line dictation pipeline uses a pinned local `whisper.cpp` model. It
does not require an OpenWhispr service, an API key, Docker, or a cloud speech
account.

```bash
# Show the installed recognizer and model.
ox voice status

# Download the pinned English base model (~142 MB) after confirmation.
ox voice setup

# Or choose a supported local model.
ox voice setup small.en

# Transcribe an existing audio file through the same local pipeline.
ox voice test /absolute/path/to/recording.wav

# Preview Ox's text cleanup without recording audio.
ox voice test --text 'um open package dot json new line'
```

`ox voice test` verifies file transcription only. It does not test microphone
permission, wake-word detection, browser control, or sending a message.

The Island's hold-to-talk control records from the Mac microphone and routes
the recognized command through the selected Ox session. macOS may require
Microphone and Speech Recognition permission for the Ox Island app. If either
permission is denied, the Island must show that state rather than claiming the
command was sent.

## Wake word

The Island has an opt-in, on-device wake-word listener. Its phrase is based on
the configured Ox name: a short name uses `OK <name>` / `Hey <name>` and a
name of four or more characters may be said by itself. Enable it from Island
controls. The listener uses Apple's on-device Speech Recognition API and
pauses while another Island voice feature owns the microphone.

Enabling the toggle only requests/uses the operating-system listener; it is
not evidence that the microphone, Speech Recognition permission, or a spoken
command has succeeded. Test it on the target Mac after granting permissions.

## What voice does not prove

After transcription, Ox still has to route the command to a supported session
or connector. Consequential actions such as sending email or a message retain
their explicit approval step. A visible transcript, queued request, or dry run
is not a successful external action.

## Troubleshooting

- `ox voice status` reports no model: run `ox voice setup` and allow the
  download to complete.
- File transcription is unavailable: install `whisper.cpp` so `whisper-cli` is
  on `PATH`, then run `ox voice status` again.
- Island cannot hear speech: grant Ox Island Microphone and Speech Recognition
  access in macOS System Settings, then disable and re-enable the wake-word
  toggle or reopen Island.
- A command is recognized but cannot act: inspect the selected session and
  connector status; Ox must display the actual unsupported/permission/error
  result rather than reporting delivery.
