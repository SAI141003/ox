# OX Studio: open models, any agent

October 18, 2026. The owner's brief: a Studio that beats Higgsfield, built on
open-source image and video models, that any AI (Claude, ChatGPT, Codex,
Cursor…) can drive, the way agents drive Higgsfield. No models are installed
on the owner's Mac (6.5 GB free; the owner said not to).

## How Higgsfield connects to agents (from its public repos)

Read from `higgsfield-ai/skills` (MIT), `cli` (MIT), `cursor-plugin` (MIT)
and `app-templates`; nothing private was taken apart.

1. A remote **MCP server** (`https://mcp.higgsfield.ai/mcp`): `generate_image`,
   `generate_video`, `generate_audio`, `models_explore`, batch generation with
   `jobs_wait`, edits (upscale, outpaint, reframe, background removal, motion
   control, dubbing), `get_workflow_instructions` (a catalog of production
   recipes: faceless videos, UGC, subtitles, thumbnails, brand kits, character
   sheets), library, characters, billing.
2. A **CLI** the skills call.
3. **Skills**: Markdown recipes (product photoshoot, brand kit, thumbnails,
   explainer, Soul ID character).
4. A **routing command** (`/higgs <request>`): one result goes to a generate
   tool, several to batch, a production to a workflow, an edit to its edit tool.
5. **Studio UI** pieces: a justified gallery, generation cards, an asset library.

## OX Studio, the same shape on open models

| Higgsfield | OX Studio |
|---|---|
| Their own hosted models | **Open-weights models** (licences listed per model) on hosts you choose: fal, Hugging Face Inference, or your own ComfyUI / Draw Things / AUTOMATIC1111 when you run one; Higgsfield and OpenAI stay available too |
| Remote MCP server | `ox studio mcp`: an MCP server any agent connects to (`ox studio connect` prints the line for Claude Code, Codex, Cursor) |
| `models_explore` | the catalog: each model's kind, licence, strengths and where it runs |
| `generate_*`, batch, `jobs_wait` | `generate_image`, `generate_video`, `edit_image`, `upscale`, `remove_background`, `lip_sync`, `generate_audio`, each returning a job; `jobs_wait` |
| Camera presets (crash zoom, orbit…) | camera moves as words the open video models follow (Wan, LTX, Hunyuan) |
| `get_workflow_instructions` | ox's recipes: product photoshoot, YouTube thumbnail, character sheet, explainer video, short-form ad |
| Video tools | ox's own ffmpeg tools: captions, cut, vertical, highlights, polish, explainer video, and `compose_video`—a streamed scene timeline with an optional narration/music track for 30-minute or one-hour exports |
| Library | the Studio gallery and history (~/.ox/media) |
| Skills | `skills/ox-studio/SKILL.md`: how an agent uses all of this |

## The open models (checked on fal's model pages, Oct 18)

| Kind | Model | Licence | Why |
|---|---|---|---|
| image | FLUX.1 [schnell] | Apache-2.0 | fast, 1–4 steps |
| image | Qwen-Image | Apache-2.0 | the best open model at text inside images |
| image | HiDream-I1 Full | MIT | detailed, faithful to long prompts |
| image | Stable Diffusion 3.5 Large | Stability Community | broad styles |
| image | SDXL | OpenRAIL++-M | the huge LoRA ecosystem |
| edit | Qwen-Image-Edit | Apache-2.0 | edits by instruction, keeps text and faces |
| edit | FLUX.1 Kontext [dev] | FLUX.1 [dev] non-commercial | character-consistent edits |
| video | Wan 2.2 A14B (text and image to video) | Apache-2.0 | the strongest open video model, follows camera words |
| video | LTX-Video 13B distilled | LTXV open weights | fast, many takes |
| video | HunyuanVideo | Tencent Hunyuan Community | cinematic motion |
| video | Mochi 1 | Apache-2.0 | smooth motion |
| video | CogVideoX-5B | CogVideoX licence | steady short clips |
| upscale | Real-ESRGAN | BSD-3 | 4x detail |
| cutout | BiRefNet | MIT | background removal |
| lip sync | LatentSync | Apache-2.0 | a face speaks the audio |
| audio | Stable Audio Open | Stability Community | sound effects and loops |

## Where it is honest about limits

- A host key (fal or a Hugging Face token) or your own local server is needed
  to make anything; ox never installs models for you.
- "Better than Higgsfield" here means: open models you can move between hosts,
  any agent can drive it, the recipes and video tools run on your machine, and
  every result keeps its recipe. Quality per model is the model's own.
