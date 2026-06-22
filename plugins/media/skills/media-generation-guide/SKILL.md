---
name: media-generation-guide
description: Use Hana Media Generation tools for image and video generation. Read before calling media_generate-image, media_generate-video, or media_describe-options.
---

# Media Generation

Generation is asynchronous. After submission, the tool returns immediately with a pending media block. Tell the user the image or video is being generated and will appear automatically when finished. Do not wait for the background task and do not call stage_files for generated media.

## Tools

### media_generate-image

- `prompt` is required.
- `count` controls concurrent image count.
- `image` accepts a current-session reference image. Prefer `{ "kind": "session_file", "fileId": "..." }`.
- `referenceImages` accepts multiple current-session reference images. Prefer session_file references.
- `ratio`, `resolution`, and `quality` are normal generation controls.
- `provider`, `model`, `mode`, and `options` are advanced overrides. Omit them for ordinary generation unless the user explicitly asked for a provider/model/mode or media_describe-options shows they are needed.
- Do not put mode values such as `text2image` or `image2image` in `model`.

### media_generate-video

- `prompt` is required.
- `image` is for image-to-video. Prefer `{ "kind": "session_file", "fileId": "..." }`.
- `duration`, `ratio`, and `resolution` are normal generation controls.
- `provider`, `model`, `mode`, and `options` are advanced overrides. Omit them for ordinary generation unless the user explicitly asked for them.

### media_describe-options

Use this side-effect-free tool only when the user asks for a specific provider/model/mode, asks for advanced parameters, or a default generation path reports a clear unsupported-capability error.

## Routing

| Intent | Tool |
|---|---|
| Generate an image from text | media_generate-image |
| Edit or restyle a reference image | media_generate-image with `image` |
| Blend several reference images | media_generate-image with `referenceImages` |
| Generate a video from text | media_generate-video |
| Animate an image | media_generate-video with `image` |
| Inspect provider/model/mode options | media_describe-options |

## Rules

- Use only the `media_*` tools for image and video generation.
- Do not silently switch providers after a failure. Report the error unless the user asks you to try another provider.
- Provider capability comes from Hana Media Provider Registry, not from chat model names.
- If the user wants text inside the image, put the exact text in double quotes inside the prompt.
