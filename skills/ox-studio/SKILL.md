---
name: ox-studio
description: Use when the user wants an image, a video clip, a sound, a thumbnail, a product shot, a character across shots, or an explainer made or edited. Drives OX Studio's open models over the ox-studio MCP tools.
---
# OX Studio

OX Studio makes and edits images, video and sound with open-weights models
(FLUX.1, Qwen-Image, HiDream, Wan 2.2, LTX-Video, HunyuanVideo, Real-ESRGAN,
BiRefNet, LatentSync, Stable Audio Open). Connect it with `ox studio connect`.

On this Mac, no key (`ox studio local`): images ~25 s, edits, 5 s clips ~3 min,
upscale, cut-outs; picked first unless a model or host is named. Say how long a clip takes.

## Route the request

- One picture → `generate_image`. Words in the picture → leave the model unset;
  Qwen-Image is picked because it spells.
- Several pictures of one idea → `generate_image` with `n` up to 4.
- Change a picture → `edit_image` (say only what changes; the rest is kept).
- Bigger, sharper → `upscale`. Cut-out → `remove_background`.
- A clip → `generate_video` (5 s). From a still → pass `image`. Add `camera`
  (dolly-in, crash-zoom, orbit, crane-up, whip-pan, handheld, fpv, bullet-time,
  push-in, static). It returns a job: call `jobs_wait`.
- Shots into one video → `video_edit` op `join`, then op `captions`.
- A production (photoshoot, thumbnail, character sheet, explainer, short ad)
  → `workflow_instructions` first, then follow its steps.
- Steps to explain, no model needed → `explainer_video`.
- A film in a named look, made in code (Ukiyo-e, Pixel RPG…) → `film_styles`, recipe code-film.
- A PSD, raw photo, vector, PDF or timeline in an open Adobe-style app → `craft_apps`, recipe craft-edit.

## Rules

- Start with `models_explore` when unsure what can run; it says what is ready.
- If a tool says a host key is needed, tell the user which one; never ask for
  the key's value in chat (they add it in the ox app under Settings › API keys).
- FLUX.1 Kontext [dev] is non-commercial: say so before using it for a business.
- Report the file paths the tools return, exactly. Do not describe a result you
  have not seen; open the file if you need to judge it.
- Prompts: subject, setting, light, lens or style, mood. One idea per image.
