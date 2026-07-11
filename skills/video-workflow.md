---
name: video-workflow
description: End-to-end workflow for planning, scripting, and executing video campaign tasks, including YouTube Shorts and TikToks. Uses Milim's voice, image generation, and omniflash.
---

# Video Campaign Workflow

When the user asks to create a video campaign (like a YouTube Short, TikTok, or video asset), follow this exact execution plan. 

## 1. Planning Phase (`planner-agy`)
Always spawn a `planner-agy` subagent to outline the task. The plan must include:
- The target audience and specific outreach channel.
- A script outline that adheres strictly to the brand voice (e.g., Milim Nova rules: bright, teasing, evidence-first, bold claim, scroll-stopping hook).
- A breakdown of scenes, identifying where base images and video clips are required.

## 2. Scripting & Asset Generation (`worker`)
Spawn a `worker` subagent to execute the plan:
1. **Draft the Script:** Create the final markdown script in `deliverables/tasks/` including detailed visual and audio/sound effect cues.
2. **Generate Base Keyframes:** Use the `image_generate` tool to create base images for each scene. Save these to `assets/media/youtube-short/` or a relevant campaign folder.
3. **Smoke Test Omni Flash:** Since the `omniflash` tool authenticates against an external API, always smoke test it first using a fast model (e.g., `nano-banana-2`) to verify the token is active.
4. **Generate Video:** If the smoke test passes, use `omniflash` (model: `seedance-2`) passing the generated `image_urls` and detailed prompts including sound effects (e.g., "whoosh", "pop", "epic boom"). 

## 3. Omni Flash Handoff (Computer-Use Agent)
Since the `omniflash` tool in the CLI harness may face auth restrictions or require complex back-and-forth, video generation is handed off to the computer-use agent running on the Mac.
1. The local worker commits the base images and the script.
2. The local worker updates the target GitHub Issue with `[COMPUTER-USE AGENT INSTRUCTIONS]`.
3. The computer-use agent takes over, opening the native **Gemini App on the Mac**, passing the base images, and using its built-in Omni Flash integration to generate the video clips and sound effects.

## 4. Delivery & Reporting
- The local worker ensures all assets are pushed to `main`.
- The computer-use agent reads `docs/social-accounts-mapping.md`, logs into the respective platforms (using the `browser-social-login` skill), and publishes the video/screenshots.