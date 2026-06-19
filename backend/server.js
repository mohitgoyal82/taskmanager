require('dotenv').config();
const express = require('express');
const cors = require('cors');
const loki = require('lokijs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

let twilio = null;
try { twilio = require('twilio'); } catch(e) {}
let fetch = null;
try { fetch = require('node-fetch'); } catch(e) {}
let multer = null;
try { multer = require('multer'); } catch(e) {}

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || './taskflow.json';
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
// Must be set in production so Twilio can fetch the image (e.g. https://taskflow.up.railway.app)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for Twilio webhooks
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── File upload config ────────────────────────────────────────────────────────
const storage = multer ? multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  }
}) : null;
const upload = multer ? multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
}) : null;

// ─── Database ─────────────────────────────────────────────────────────────────
let db, usersCol, tasksCol, logsCol;

async function initDB() {
  return new Promise((resolve) => {
    db = new loki(DB_PATH, {
      autoload: true,
      autoloadCallback: () => {
        usersCol = db.getCollection('users') || db.addCollection('users', { indices: ['id'] });
        tasksCol = db.getCollection('tasks') || db.addCollection('tasks', { indices: ['id'] });
        logsCol  = db.getCollection('logs')  || db.addCollection('logs',  { indices: ['task_id'] });
        if (usersCol.count() === 0) {
          const seed = [
            { id: uuidv4(), name: 'Alice Manager',   role: 'manager',    phone: '', language: 'en', created_at: now() },
            { id: uuidv4(), name: 'Bob Supervisor',  role: 'supervisor', phone: '', language: 'en', created_at: now() },
            { id: uuidv4(), name: 'Carlos Assignee', role: 'assignee',   phone: '', language: 'es', created_at: now() },
            { id: uuidv4(), name: 'Priya Assignee',  role: 'assignee',   phone: '', language: 'hi', created_at: now() },
            { id: uuidv4(), name: 'Jean Assignee',   role: 'assignee',   phone: '', language: 'fr', created_at: now() },
          ];
          seed.forEach(u => usersCol.insert(u));
          db.saveDatabase();
          console.log('✅ Seeded default users');
        }
        resolve();
      },
      autosave: true,
      autosaveInterval: 5000
    });
  });
}

function now() { return new Date().toISOString(); }
function cleanDoc(doc) { if (!doc) return null; const { $loki, meta, ...rest } = doc; return rest; }
function withJoins(task) {
  if (!task) return null;
  const t = cleanDoc(task);
  const assignee = t.assignee_id ? cleanDoc(usersCol.findOne({ id: t.assignee_id })) : null;
  const creator  = t.created_by  ? cleanDoc(usersCol.findOne({ id: t.created_by  })) : null;
  return { ...t, assignee_name: assignee?.name||null, assignee_phone: assignee?.phone||null,
    assignee_language: assignee?.language||'en', creator_name: creator?.name||null,
    creator_phone: creator?.phone||null,
    image_full_url: t.image_url ? (PUBLIC_BASE_URL ? PUBLIC_BASE_URL + t.image_url : t.image_url) : null };
}

// ─── Translation ──────────────────────────────────────────────────────────────
const LANG_NAMES = {
  en:'English', hi:'Hindi', es:'Spanish', fr:'French', ar:'Arabic',
  zh:'Chinese', pt:'Portuguese', de:'German', ja:'Japanese', ko:'Korean',
  ru:'Russian', bn:'Bengali', ta:'Tamil', te:'Telugu', mr:'Marathi'
};

async function translateText(text, targetLang) {
  if (!targetLang || targetLang === 'en') return text;
  const langName = LANG_NAMES[targetLang] || targetLang;
  console.log(`🌐 Translating to ${langName}...`);
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.responseStatus !== 200) { console.error('❌ MyMemory error:', data.responseDetails); return text; }
    const translated = data.responseData?.translatedText?.trim();
    console.log(`✅ Translated to ${langName}: ${translated?.slice(0, 80)}`);
    return translated || text;
  } catch (err) {
    console.error('❌ Translation error:', err.message);
    return text;
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
async function sendWhatsApp(toPhone, message, mediaUrl) {
  if (!process.env.TWILIO_ACCOUNT_SID || !toPhone || !twilio) {
    console.log('📱 WhatsApp (simulated):', message.slice(0, 120), mediaUrl ? `[image: ${mediaUrl}]` : '');
    return { simulated: true };
  }
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const payload = {
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    to: `whatsapp:${toPhone}`,
    body: message
  };
  if (mediaUrl) {
    if (!/^https?:\/\//.test(mediaUrl)) {
      console.warn('⚠️ mediaUrl is not a public absolute URL — Twilio cannot fetch it. Set PUBLIC_BASE_URL env var.');
    } else {
      payload.mediaUrl = [mediaUrl];
    }
  }
  return await client.messages.create(payload);
}

// Build task notification message with action buttons as reply keywords
function buildTaskMessage(task, creator, eventType) {
  const divider = '─────────────────';

  let header = '';
  let actions = '';

  if (eventType === 'assigned') {
    header = `📋 *New Task Assigned to You!*\n${divider}`;
    actions = task.status === 'Created'
      ? `\n${divider}\n*Reply with a keyword to update:*\n✅ Reply *ACCEPT* → Move to In Progress\n🚫 Reply *DECLINE* → Notify manager`
      : '';
  } else if (eventType === 'status_changed') {
    header = `🔄 *Task Status Updated*\n${divider}`;
  } else if (eventType === 'reminder') {
    header = `⏰ *Task Reminder*\n${divider}`;
    actions = `\n${divider}\n*Reply with a keyword:*\n▶️ Reply *START* → Mark In Progress\n✅ Reply *DONE* → Mark Complete\n⚠️ Reply *DELAY* → Mark Delayed`;
  }

  // Determine what action buttons to show based on current status
  if (eventType === 'assigned' || eventType === 'reminder') {
    if (task.status === 'Created') {
      actions = `\n${divider}\n*Reply to update this task:*\n▶️ *START* — Accept & move to In Progress\n⚠️ *DELAY* — Mark as Delayed\n❓ *STATUS* — Check current status`;
    } else if (task.status === 'In Progress') {
      actions = `\n${divider}\n*Reply to update this task:*\n✅ *DONE* — Mark as Complete\n⚠️ *DELAY* — Mark as Delayed\n❓ *STATUS* — Check current status`;
    } else if (task.status === 'Delayed') {
      actions = `\n${divider}\n*Reply to update this task:*\n▶️ *START* — Move back to In Progress\n✅ *DONE* — Mark as Complete\n❓ *STATUS* — Check current status`;
    }
  }

  const msg = `${header}
*${task.title}*
Priority: ${task.priority}
Status: ${task.status}${task.due_date ? '\nDue: ' + task.due_date : ''}
Created by: ${creator || 'Manager'}${task.description ? '\n\n' + task.description : ''}${actions}`;

  return msg;
}

// ─── Twilio Webhook — incoming WhatsApp replies ───────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  const from = (req.body.From || '').replace('whatsapp:', '').trim();
  const body = (req.body.Body || '').trim().toUpperCase();
  console.log(`📩 WhatsApp reply from ${from}: "${body}"`);

  // Find user by phone number
  const allUsers = usersCol.chain().data().map(cleanDoc);
  const user = allUsers.find(u => u.phone && from.endsWith(u.phone.replace(/\D/g, '').slice(-10)));

  if (!user) {
    console.log(`⚠️ Unknown sender: ${from}`);
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Message>Sorry, your number is not registered in TaskFlow. Please contact your manager.</Message></Response>`);
  }

  // Find their most recent active (non-complete) task
  const allTasks = tasksCol.chain().data()
    .filter(t => t.assignee_id === user.id && t.status !== 'Complete')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const task = allTasks.length > 0 ? allTasks[0] : null;

  // STATUS command — no task needed
  if (body === 'STATUS') {
    if (!task) {
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response><Message>✅ You have no active tasks right now!</Message></Response>`);
    }
    const t = withJoins(task);
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Message>📋 Your current task:\n\n*${t.title}*\nStatus: ${t.status}\nPriority: ${t.priority}${t.due_date ? '\nDue: ' + t.due_date : ''}\n\nReply: START, DONE, or DELAY to update.</Message></Response>`);
  }

  if (!task) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Message>You have no active tasks to update. Contact your manager.</Message></Response>`);
  }

  const t = withJoins(task);
  const prevStatus = task.status;
  let newStatus = null;
  let replyMsg = '';

  // Map keywords to status transitions
  const transitions = {
    'START':  { from: ['Created', 'Delayed'], to: 'In Progress' },
    'ACCEPT': { from: ['Created'],            to: 'In Progress' },
    'DONE':   { from: ['Created', 'In Progress', 'Delayed'], to: 'Complete' },
    'DELAY':  { from: ['Created', 'In Progress'], to: 'Delayed' },
  };

  const transition = transitions[body];

  if (!transition) {
    // Unknown keyword
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Message>❓ Unknown command.\n\nYour task: *${t.title}* (${t.status})\n\nValid replies:\n▶️ START\n✅ DONE\n⚠️ DELAY\n❓ STATUS</Message></Response>`);
  }

  if (!transition.from.includes(prevStatus)) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Message>⚠️ Cannot use ${body} when task is already "${prevStatus}".\n\nTry: ${prevStatus === 'Complete' ? 'Task is already complete!' : 'STATUS to check options.'}</Message></Response>`);
  }

  // Apply the status update
  newStatus = transition.to;
  task.status = newStatus;
  task.updated_at = now();
  tasksCol.update(task);
  logsCol.insert({ id: uuidv4(), task_id: task.id, changed_by: user.id, field_changed: 'status', old_value: prevStatus, new_value: newStatus, created_at: now() });
  db.saveDatabase();

  console.log(`✅ Task "${task.title}" updated: ${prevStatus} → ${newStatus} by ${user.name}`);

  // Build reply to assignee
  const statusEmoji = { 'In Progress': '▶️', 'Complete': '✅', 'Delayed': '⚠️' };
  replyMsg = `${statusEmoji[newStatus] || '🔄'} Got it, *${user.name}*!\n\nTask *${task.title}* is now *${newStatus}*.\n\nThank you for updating!`;
  if (newStatus === 'In Progress') replyMsg += `\n\nReply *DONE* when complete or *DELAY* if blocked.`;
  if (newStatus === 'Delayed') replyMsg += `\n\nReply *START* when you resume.`;

  // Notify creator/manager
  if (t.creator_phone) {
    const creatorMsg = `🔔 Task Update!\n\n*${user.name}* updated task:\n*${task.title}*\n${prevStatus} → *${newStatus}*\n\nUpdated at: ${new Date().toLocaleString('en-IN')}`;
    sendWhatsApp(t.creator_phone, creatorMsg).catch(console.error);
  }

  // Also notify all managers/supervisors who have a phone set
  const managers = usersCol.chain().data()
    .map(cleanDoc)
    .filter(u => ['manager', 'supervisor'].includes(u.role) && u.phone && u.id !== t.created_by);
  for (const mgr of managers) {
    const mgrMsg = `🔔 *${user.name}* updated task *${task.title}*: ${prevStatus} → *${newStatus}*`;
    sendWhatsApp(mgr.phone, mgrMsg).catch(console.error);
  }

  // Respond to Twilio with TwiML
  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${replyMsg}</Message></Response>`);
});

// ─── Debug: Test translation ──────────────────────────────────────────────────
app.get('/api/test-translate', async (req, res) => {
  const lang = req.query.lang || 'hi';
  const text = req.query.text || 'Hello! Your task has been assigned. Please complete it urgently.';
  const translated = await translateText(text, lang);
  res.json({ original: text, translated, lang, lang_name: LANG_NAMES[lang]||lang, translation_worked: text !== translated });
});

// ─── Image Upload ─────────────────────────────────────────────────────────────
app.post('/api/upload', (req, res) => {
  if (!upload) return res.status(500).json({ error: 'Upload not available — multer not installed' });
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const relativeUrl = `/uploads/${req.file.filename}`;
    res.json({
      url: relativeUrl,
      full_url: PUBLIC_BASE_URL ? PUBLIC_BASE_URL + relativeUrl : relativeUrl
    });
  });
});

// ─── Users ────────────────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json(usersCol.chain().data().map(cleanDoc).sort((a,b) => a.name.localeCompare(b.name)));
});
app.post('/api/users', (req, res) => {
  const { name, role, phone, language } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name and role required' });
  const user = usersCol.insert({ id: uuidv4(), name, role, phone: phone||'', language: language||'en', created_at: now() });
  db.saveDatabase();
  res.json(cleanDoc(user));
});
app.put('/api/users/:id', (req, res) => {
  const user = usersCol.findOne({ id: req.params.id });
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { name, role, phone, language } = req.body;
  Object.assign(user, { name, role, phone: phone||'', language: language||'en' });
  usersCol.update(user);
  db.saveDatabase();
  res.json(cleanDoc(user));
});
app.delete('/api/users/:id', (req, res) => {
  const user = usersCol.findOne({ id: req.params.id });
  if (user) { usersCol.remove(user); db.saveDatabase(); }
  res.json({ ok: true });
});

// ─── Tasks ────────────────────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  res.json(tasksCol.chain().data().map(withJoins).sort((a,b) => b.created_at.localeCompare(a.created_at)));
});
app.get('/api/tasks/:id', (req, res) => {
  const task = tasksCol.findOne({ id: req.params.id });
  if (!task) return res.status(404).json({ error: 'Not found' });
  const logs = logsCol.find({ task_id: req.params.id })
    .map(l => { const u = l.changed_by ? cleanDoc(usersCol.findOne({ id: l.changed_by })) : null; return { ...cleanDoc(l), changed_by_name: u?.name||'System' }; })
    .sort((a,b) => b.created_at.localeCompare(a.created_at));
  res.json({ ...withJoins(task), logs });
});
app.post('/api/tasks', async (req, res) => {
  const { title, description, priority, assignee_id, created_by, due_date, image_url } = req.body;
  if (!title || !created_by) return res.status(400).json({ error: 'title and created_by required' });
  const creator = cleanDoc(usersCol.findOne({ id: created_by }));
  if (!creator || !['manager','supervisor'].includes(creator.role))
    return res.status(403).json({ error: 'Only managers or supervisors can create tasks' });
  const id = uuidv4();
  const task = tasksCol.insert({ id, title, description: description||'', status: 'Created',
    priority: priority||'Medium', assignee_id: assignee_id||null, created_by,
    due_date: due_date||null, image_url: image_url||null, created_at: now(), updated_at: now() });
  logsCol.insert({ id: uuidv4(), task_id: id, changed_by: created_by, field_changed: 'status', old_value: null, new_value: 'Created', created_at: now() });
  db.saveDatabase();
  const result = withJoins(task);
  if (result.assignee_phone) {
    const msgEN = buildTaskMessage(result, creator.name, 'assigned');
    translateText(msgEN, result.assignee_language)
      .then(msg => sendWhatsApp(result.assignee_phone, msg, result.image_full_url).catch(console.error));
  }
  res.json(result);
});
app.put('/api/tasks/:id', async (req, res) => {
  const task = tasksCol.findOne({ id: req.params.id });
  if (!task) return res.status(404).json({ error: 'Not found' });
  const prev = { ...task };
  const { title, description, status, priority, assignee_id, due_date, updated_by, image_url } = req.body;
  if (title !== undefined) task.title = title;
  if (description !== undefined) task.description = description;
  if (status !== undefined) task.status = status;
  if (priority !== undefined) task.priority = priority;
  if (assignee_id !== undefined) task.assignee_id = assignee_id||null;
  if (due_date !== undefined) task.due_date = due_date||null;
  if (image_url !== undefined) task.image_url = image_url||null;
  task.updated_at = now();
  tasksCol.update(task);
  for (const field of ['status','priority','assignee_id','title']) {
    if (req.body[field] !== undefined && req.body[field] !== prev[field]) {
      logsCol.insert({ id: uuidv4(), task_id: task.id, changed_by: updated_by||null,
        field_changed: field, old_value: prev[field], new_value: req.body[field], created_at: now() });
    }
  }
  db.saveDatabase();
  const result = withJoins(task);
  if (status && status !== prev.status && result.assignee_phone) {
    const msgEN = buildTaskMessage(result, result.creator_name, 'status_changed');
    translateText(msgEN, result.assignee_language)
      .then(msg => sendWhatsApp(result.assignee_phone, msg, result.image_full_url).catch(console.error));
  }
  res.json(result);
});
app.delete('/api/tasks/:id', (req, res) => {
  const task = tasksCol.findOne({ id: req.params.id });
  if (task) { logsCol.removeWhere({ task_id: req.params.id }); tasksCol.remove(task); db.saveDatabase(); }
  res.json({ ok: true });
});

// ─── Notify (manual WhatsApp with action buttons + optional image) ───────────
app.post('/api/tasks/:id/notify', async (req, res) => {
  const task = tasksCol.findOne({ id: req.params.id });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const t = withJoins(task);
  const { message, lang, include_image } = req.body;
  const targetLang = lang || t.assignee_language || 'en';
  const baseMsg = message || buildTaskMessage(t, t.creator_name, 'reminder');
  console.log(`📱 Notify: lang=${targetLang}, image=${include_image ? t.image_full_url : 'none'}`);
  const translated = await translateText(baseMsg, targetLang);
  try {
    const mediaUrl = include_image ? t.image_full_url : null;
    const result = await sendWhatsApp(t.assignee_phone, translated, mediaUrl);
    res.json({ ok: true, original: baseMsg, translated, lang_used: targetLang, simulated: result.simulated||false, image_sent: !!mediaUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const all = tasksCol.data;
  const by_status = {};
  all.forEach(t => { by_status[t.status] = (by_status[t.status]||0) + 1; });
  const today = new Date().toISOString().split('T')[0];
  const overdue = all.filter(t => t.due_date && t.due_date < today && t.status !== 'Complete').length;
  res.json({ total: all.length, by_status: Object.entries(by_status).map(([status,count]) => ({status,count})), overdue });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 TaskFlow running on http://localhost:${PORT}`);
    console.log(`📱 WhatsApp webhook: POST /webhook/whatsapp`);
  });
});
