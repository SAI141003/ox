# Personal model: safe adapter workflow

Ox's personal-model setting is deliberately **not** a switch that silently
trains on every chat, desktop action, or Studio asset.  It is a local control
plane for a user-owned LoRA adapter over a separately selected open-weight
base model.

## What the current feature does

Settings → **Personal model** stores an explicit opt-in configuration under
`~/.ox/personal-model/`.  It starts off.  Enabling it requires explicit
consent, a base model, and a source selection.  It never reads historical
chats automatically.  The only accepted examples are records a user adds one
at a time with `approved: true`.

Before an example lands on disk, Ox applies the same secret and prompt-
injection screen used by persistent memory.  The example dataset is private
JSONL (`0600`); its directory is user-only (`0700`).  Base weights are never
rewritten; an adapter is a separate, versioned artifact.

The readiness check does not pretend a trainer exists.  It reports MLX LoRA on
Apple Silicon when `mlx_lm` is installed, or PEFT LoRA when `peft` and
`transformers` are installed.  It does not install packages, download a model,
send a dataset to a provider, or start a GPU job by itself.

## Promotion contract

Before an adapter can be promoted, Ox requires all of the following:

1. A clean held-out set (at least five examples, never used for training).
2. Numeric scores for both the base model and candidate adapter.
3. Candidate score at least equal to the base score.
4. A passing safety regression suite.
5. A separate human approval to promote the new version.

An adapter cannot modify Ox, Studio, prompts, source code, or its own
configuration.  It can propose work through normal agent approvals only.

## Why adapters, not a from-scratch model

Parameter-efficient tuning keeps the pretrained base frozen and learns a small
adapter.  QLoRA similarly backpropagates into low-rank adapters over a frozen,
quantized base, which is far more practical for personal hardware than
foundation-model training.  This implementation uses that boundary as both a
resource and rollback safeguard.

## Next required choice before an actual training runner

The user must choose a compatible base model and local runtime (MLX on Apple
Silicon or PEFT/CUDA).  That is intentionally not guessed: the choice changes
disk use, license obligations, time, and hardware requirements.  Once chosen,
the training runner can consume only the approved JSONL dataset and write an
adapter version plus its evaluation report.
