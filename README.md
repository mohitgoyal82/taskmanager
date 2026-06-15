# TaskFlow — Team Task Manager

A simple, production-ready task manager with WhatsApp notifications and language translation.

## Features

- ✅ Create tasks (managers & supervisors only)
- 📊 Task statuses: Created → In Progress → Delayed → Complete
- 👤 Assignee, Priority (Low/Medium/High/Critical), Due Date, Created/Updated timestamps
- 📱 WhatsApp notifications to assignees via Twilio
- 🌐 Auto-translation into 15 languages (Hindi, Spanish, French, Arabic, Chinese, etc.)
- 📋 List & Kanban board views
- 📈 Stats dashboard
- 🔍 Search & filter

---

## Quick Start (Local)

### 1. Clone & Install

```bash
git clone <your-repo>
cd taskflow/backend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your keys
```

### 3. Run

```bash
node server.js
# Open http://localhost:3001
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: 3001) |
| `DB_PATH` | No | SQLite file path (default: ./taskflow.db) |
| `TWILIO_ACCOUNT_SID` | For WhatsApp | From console.twilio.com |
| `TWILIO_AUTH_TOKEN` | For WhatsApp | From console.twilio.com |
| `TWILIO_WHATSAPP_FROM` | For WhatsApp | Twilio WhatsApp number |
| `ANTHROPIC_API_KEY` | For translation | From console.anthropic.com |

> Without Twilio/Anthropic keys, the app works fully — WhatsApp sends are simulated and messages stay in English.

---

## Production Deployment

### Option A: Railway (Recommended — Free tier available)

1. Push code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Add environment variables in Railway dashboard
5. Done! Railway auto-deploys on every push

**Cost:** Free tier (500 hrs/month) or ~$5/month Hobby plan

### Option B: Render

1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect repo, select "Docker" as runtime
4. Add environment variables
5. Create a Disk (1GB) mounted at `/app/data`

**Cost:** Free tier available; $7/month for always-on

### Option C: Self-hosted with Docker

```bash
# Clone repo on your server
git clone <your-repo>
cd taskflow

# Create .env file
cp backend/.env.example .env
nano .env  # add your keys

# Run
docker-compose up -d

# View logs
docker-compose logs -f
```

---

## WhatsApp Setup (Twilio)

### Free Sandbox (Development)
1. Sign up at [twilio.com](https://www.twilio.com) (free)
2. Go to Messaging → Try it out → Send a WhatsApp message
3. Your team members must send `join <sandbox-keyword>` to the Twilio sandbox number
4. Copy Account SID, Auth Token, and sandbox number (+14155238886) to `.env`

### Production WhatsApp Number (~$10/month)
1. In Twilio console → Messaging → Senders → WhatsApp Senders
2. Apply for a WhatsApp Business number
3. Update `TWILIO_WHATSAPP_FROM` in `.env`

---

## Translation

Translation uses Claude Haiku (cheapest Claude model):
- ~$0.00025 per 1K input tokens
- A typical notification message costs < $0.001 to translate
- For 100 notifications/day: ~$0.03/month

---

## Cost Summary

| Service | Free Tier | Paid |
|---|---|---|
| Railway/Render hosting | 500 hrs/month free | ~$5–7/month |
| SQLite storage | Included | Included |
| Twilio WhatsApp | Sandbox free | ~$0.005/message |
| Anthropic translation | — | ~$0.001/message |

**Estimated total for small team (50 tasks/month):** ~$5–10/month

---

## Project Structure

```
taskflow/
├── backend/
│   ├── server.js          # Express API + SQLite + WhatsApp
│   ├── package.json
│   └── .env.example
├── frontend/
│   └── index.html         # Complete SPA (no build step needed)
├── Dockerfile
├── docker-compose.yml
├── railway.json           # Railway deployment config
└── render.yaml            # Render deployment config
```

---

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | /api/tasks | List all tasks |
| POST | /api/tasks | Create task |
| PUT | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| POST | /api/tasks/:id/notify | Send WhatsApp |
| GET | /api/users | List users |
| POST | /api/users | Create user |
| PUT | /api/users/:id | Update user |
| GET | /api/stats | Dashboard stats |

---

## Default Users (seeded on first run)

| Name | Role |
|---|---|
| Alice Manager | Manager |
| Bob Supervisor | Supervisor |
| Carlos Assignee | Assignee (Spanish) |
| Priya Assignee | Assignee (Hindi) |
| Jean Assignee | Assignee (French) |

Add phone numbers to users to enable WhatsApp.

---

## WhatsApp Reply Actions (Assignee → Task Update)

When a task is assigned or a reminder is sent, the assignee receives action keywords they can reply with:

| Assignee replies | What happens |
|---|---|
| `START` or `ACCEPT` | Task moves → **In Progress** |
| `DONE` | Task moves → **Complete** |
| `DELAY` | Task moves → **Delayed** |
| `STATUS` | Bot replies with current task details |

When an assignee replies, the task updates automatically in the app AND the manager/creator gets a WhatsApp notification.

### Setting up the Twilio Webhook

1. Deploy your app and get your public URL (e.g. `https://taskflow.railway.app`)
2. In Twilio Console → **Messaging → Settings → WhatsApp Sandbox Settings**
3. Set **"When a message comes in"** to:
   ```
   https://your-app-url.railway.app/webhook/whatsapp
   ```
   Method: **HTTP POST**
4. Save — done! Assignees can now reply to update tasks.

> **Important:** Make sure manager/supervisor phone numbers are also saved in the Team page so they receive update notifications when assignees reply.
