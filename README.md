# SOVA — Local AI workspace

SOVA is a local-first assistant built with a Python/FastAPI backend, Ollama, and a React frontend. It supports streamed model chat, local document search (RAG), a small read-only document agent, SHA-256 upload auditing, and DOCX/XLSX answer export.

## Requirements

- Python 3.10 or newer
- Node.js 18 or newer
- [Ollama](https://ollama.com/) installed and running on this computer

Model downloads require internet access once. After the models are downloaded, SOVA defaults to the loopback Ollama service and does not send prompts or documents to a cloud API. The web UI uses system fonts and has no external font/CDN requests.

## 1. Download local models

In PowerShell:

```powershell
ollama pull gemma3
ollama pull qwen2.5
ollama pull nomic-embed-text
```

The downloads are large. `gemma3` is used for chat and image text extraction, `qwen2.5` for tool selection, and `nomic-embed-text` for document retrieval.

## 2. Configure and run the Python backend

From the repository root:

```powershell
cd backend
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `backend/.env` and replace the sample `SOVA_PASSWORD` and `SOVA_JWT_SECRET` values with your own. Generate a random secret with:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Then start the backend from the `backend` directory:

```powershell
uvicorn main:app --reload
```

The API listens on `http://127.0.0.1:8000`. Interactive API documentation is available at `http://127.0.0.1:8000/docs`. Uploaded files, the SQLite audit log, and the Chroma index are stored in the repository-root `data/` directory by default; this directory is ignored by Git.

SOVA intentionally rejects non-loopback `OLLAMA_HOST` values. Set `SOVA_DATA_DIR` only if you want the local database and uploads stored in another directory.

## 3. Run the React frontend

In a second PowerShell window, from the repository root:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`) and sign in with the credentials configured in `backend/.env`. Set `VITE_API_URL` in `frontend/.env.local` only if the local API uses a different address.

## Deploy the frontend to Vercel

The React frontend can be deployed to Vercel, but the current FastAPI backend cannot run there as-is. It requires an Ollama instance on the same machine, a persistent writable data directory for SQLite and Chroma, and a WebSocket connection for streamed chat. Host the backend and Ollama on a separate persistent server that supports HTTPS and WebSockets; do not expose an Ollama port publicly.

1. Deploy the backend on that server and configure `SOVA_USERNAME`, `SOVA_PASSWORD`, and a unique `SOVA_JWT_SECRET` of at least 32 characters. Keep `OLLAMA_HOST` pointed at the server's loopback Ollama service, pull the configured models, and mount persistent storage for `SOVA_DATA_DIR`.
2. Set `SOVA_CORS_ORIGINS` on the backend to the exact Vercel deployment origin (for example, `https://your-project.vercel.app`). Add the custom domain separately if you use one. Restart the backend after changing this value.
3. Import this repository into Vercel and set the project **Root Directory** to `frontend`.
4. Add the Vercel environment variable `VITE_API_URL` with the public HTTPS base URL of the FastAPI backend (for example, `https://api.example.com`), with no trailing slash. Set it for each environment you use, then redeploy.
5. Open the Vercel deployment URL, sign in using the backend credentials, and verify login, document upload, Ask/Agent, exports, and streamed Chat. The backend must allow browser requests from the Vercel origin and accept secure WebSocket (`wss://`) connections.

For local development, copy `frontend/.env.example` to `frontend/.env.local`; the Vite development server defaults to `http://127.0.0.1:8000` when `VITE_API_URL` is unset.

## Features and API

- **Chat:** `/chat` streams Ollama responses over an authenticated WebSocket.
- **Upload and RAG:** `/upload` accepts PDF, DOCX, TXT, Markdown, and common image formats. Text is extracted locally, chunked, embedded, and indexed. `/ask` returns an answer with source passages.
- **Agent:** `/agent` provides bounded, read-only `search_docs`, `summarize`, and `generate_report` tools.
- **Local login:** `/auth/login` issues a 12-hour JWT. All document, chat, agent, and export endpoints require it.
- **Audit:** each successful upload records its SHA-256, original filename, and timestamp in SQLite. `/audit` shows the latest 500 records.
- **Exports:** `/export/docx` and `/export/xlsx` generate answer files with source details.

Uploaded files are limited to 20 MiB. The document store and audit log are local files, not encrypted; use OS disk encryption and restrict access to the data directory for sensitive documents.
