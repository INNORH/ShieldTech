# Work Station — backend handoff

Work Station is a **sidebar module** inside Job Scam Shield (`app.html` → Work Station).

## Switch off mocks

Edit **only** `workstation-api.js`:

1. Set `USE_MOCK = false`
2. Set `BASE_URL` to your API origin (e.g. `https://api.example.com/api`)

No UI file needs changes.

## Auth

- JWT is read from `localStorage.token`
- Sent as `Authorization: Bearer <token>`

## Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/resumes` | `multipart/form-data` field `resume` (file) | `{ resumeId, fileName, score, summary }` |
| `GET` | `/resumes/:id/suggestions` | — | `{ resumeId, suggestions: Suggestion[] }` |
| `GET` | `/resumes/:id/templates` | — | `{ resumeId, templates: Template[] }` |
| `GET` | `/resumes/:id/matches` | — | `{ resumeId, matches: JobMatch[] }` |
| `GET` | `/resumes/:id/matches/:jobId` | — | `JobComparison` |

## Error contract

Non-2xx with JSON: `{ "error": string, "code"?: string }`

## Shared client state

Only `resumeId` (plus score/file name for display) is persisted under:

- `workstation:resumeId`
- `workstation:score`
- `workstation:fileName`

Safe to replace later with a server session.
