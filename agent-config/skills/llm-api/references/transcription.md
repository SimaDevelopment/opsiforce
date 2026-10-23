# Transcription

Source of truth for every parameter: OpenAI's [Speech to text guide](https://developers.openai.com/api/docs/guides/speech-to-text).

Turn audio into text with `whisper-1`. Reasoning settings don't apply. In an App, record with `MediaRecorder` on the frontend, send the recording to the backend, and transcribe there.

```typescript
import { createReadStream } from "fs"

const transcription = await llm.audio.transcriptions.create({
  file: createReadStream("audio.mp3"),
  model: "whisper-1",
})
const text = transcription.text
```

From an uploaded file buffer, with the optional tuning parameters:

```typescript
import { toFile } from "openai"

const transcription = await llm.audio.transcriptions.create({
  file: await toFile(buffer, "audio.webm"),
  model: "whisper-1",
  language: "en",
  response_format: "verbose_json",
  prompt: "Technical meeting about Kubernetes deployments",
})
```

Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm, up to 25 MB per request. `response_format` picks the output: `"text"` (plain string), `"json"` (with a text field), `"verbose_json"` (with word-level timestamps), `"srt"` or `"vtt"` (subtitles).

## Direct task: transcribe a file yourself, no app

Fetch the media and post it to the gateway from the shell:

```bash
yt-dlp -x --audio-format mp3 -o audio.mp3 "<url>"   # or, for a local file: ffmpeg -i input.mp4 -vn audio.mp3
curl -s "$APP_LLM_BASE_URL/audio/transcriptions" \
  -H "Authorization: Bearer $APP_LLM_API_KEY" \
  -F model=whisper-1 -F response_format=text -F file=@audio.mp3
```

Split media over 25 MB with `ffmpeg` (`-f segment -segment_time 900`) and join the text.
