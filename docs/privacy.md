# Privacy — audio stays on the user's computer

## What is captured

- Microphone audio (only while the user explicitly starts a meeting)
- Windows system audio (only while the user explicitly starts a meeting)

## What happens to it

Captured audio is written to **temporary on-device files** while a meeting runs so
long meetings are not limited to memory, then processed locally after the meeting
stops:

```
capture → temp PCM chunks (disk, userData/recordings/<meetingId>)
       → Stop → local Whisper → transcript text → temp files DELETED
       → failure/interruption → files PRESERVED for retry
```

- Captured audio exists only as **temporary files under `userData/recordings`** on
  the user's machine, inside the meeting lifecycle.
- Those files are **deleted automatically** once the meeting has been transcribed,
  analyzed, and saved. If transcription fails — or a session is interrupted by a
  crash, force-quit, or quitting with a recording active — the temporary audio is
  **preserved on disk** so the user can retry it or explicitly delete it from the
  Meetings page. Preserved audio is never uploaded; it lives only on the local
  disk until processed, retried, or discarded.
- The raw audio is **never uploaded** and **never stored** by the backend or any
  third party. Only the transcript **text** survives.
- Transcription runs **locally** (Whisper local runtime) and only after the user
  stops the meeting. No cloud transcription API is used, and none was designed in.

## What is synchronized to the server

Only text and metadata:

- Account information (name, email, hashed password)
- Meeting metadata (title, times, duration, status)
- Transcript **text**
- Summaries, action items, decisions, risks, open questions
- Templates and user settings

## Explicit non-claims

- No raw recordings are kept for "quality" or "replay" purposes.
- Temporary capture files are never synced or uploaded; they only exist locally
  and are deleted after processing.
- There is no `POST /audio`, no `POST /upload-audio`, no audio table, no audio
  blob storage. If you find one in a PR, it is a bug.

## Controls

- There is **no "store audio" toggle** — temporary capture files are deleted
  automatically after a successful transcription and are never kept long-term, in
  any build. The app starts/stops capture only on explicit meeting start/stop.
- The app refuses to start a recording when the disk cannot hold even a short
  meeting, and the New Meeting page shows a projection of temporary disk usage
  with a warning when free space is tight.
- Meetings whose transcription failed or was interrupted show an **"Audio on
  disk"** badge; only the user can decide to retry or explicitly delete that
  audio, and delete flows include confirmations.
- Meeting stop/delete flows include privacy confirmations.
- Only the text of completed meetings is synced; pending/offline meetings live in
  the local SQLite store until explicitly synced by the user.

## Server-side guarantees

- Data is scoped to the authenticated user.
- Administrators can access user **text** data through explicit, audited admin
  paths only.
- Audit logs never contain passwords, tokens, or raw audio (there is none).