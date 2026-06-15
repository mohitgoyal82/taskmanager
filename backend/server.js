require('dotenv').config();
const express = require('express');
const cors = require('cors');
const loki = require('lokijs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

let twilio = null;
try { twilio = require('twilio'); } catch(e) {}
let fetch = null;
try { fetch = require('node-fetch'); } catch(e) {}

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || './taskflow.json';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

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
  return { ...t, assignee_name: assignee?.name||null, assignee_phone: assignee?.phone||null, assignee_language: assignee?.language||'en', creator_name: creator?.name||null };
}

// ─── Translation ──────────────────────────────────────────────────────────────
const LANG_NAMES = {
  en:'English', hi:'Hindi', es:'Spanish', fr:'French', ar:'Arabic',
  zh:'Chinese', pt:'Portuguese', de:'German', ja:'Japanese', ko:'Korean',
  ru:'Russian', bn:'Bengali', ta:'Tamil', te:'Telugu', mr:'Marathi'
};


async function translateText(text, targetLang) {
  if (!targetLang || targetLang === "en") return text;
  const langName = LANG_NAMES[targetLang] || targetLang;
  console.log(`🌐 Translating to ${langName}...`);
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.responseStatus !== 200) { console.error("❌ MyMemory error:", data.responseDetails); return text; }
    const translated = data.responseData?.translatedText?.trim();
    console.log(`✅ Translated to ${langName}: ${translated?.slice(0,80)}`);
    return translated || text;
  } catch (err) {
    console.error("❌ Translation error:", err.message);
    return text;
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
async function sendWhatsApp(toPhone, message) {
  if (!process.env.TWILIO_ACCOUNT_SID || !toPhone || !twilio) {
    console.log('📱 WhatsApp (simulated):', message.slice(0, 100));
    return { simulated: true };
  }
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    to: `whatsapp:${toPhone}`,
    body: message
  });
}

// ─── Debug: Test translation ──────────────────────────────────────────────────
app.get('/api/test-translate', async (req, res) => {
  const lang = req.query.lang || 'hi';
  const text = req.query.text || 'Hello! Your task has been assigned. Please complete it urgently.';
  console.log(`🧪 Test translate → ${lang}, API key set: ${!!process.env.ANTHROPIC_API_KEY}`);
  const translated = await translateText(text, lang);
  res.json({
    original: text,
    translated,
    lang,
    lang_name: LANG_NAMES[lang] || lang,
    api_key_set: !!process.env.ANTHROPIC_API_KEY,
    translation_worked: text !== translated
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
  const { title, description, priority, assignee_id, created_by, due_date } = req.body;
  if (!title || !created_by) return res.status(400).json({ error: 'title and created_by required' });
  const creator = cleanDoc(usersCol.findOne({ id: created_by }));
  if (!creator || !['manager','supervisor'].includes(creator.role))
    return res.status(403).json({ error: 'Only managers or supervisors can create tasks' });
  const id = uuidv4();
  const task = tasksCol.insert({ id, title, description: description||'', status: 'Created', priority: priority||'Medium', assignee_id: assignee_id||null, created_by, due_date: due_date||null, created_at: now(), updated_at: now() });
  logsCol.insert({ id: uuidv4(), task_id: id, changed_by: created_by, field_changed: 'status', old_value: null, new_value: 'Created', created_at: now() });
  db.saveDatabase();
  const result = withJoins(task);
  if (result.assignee_phone) {
    const msgEN = `📋 New task assigned to you!\n\n*${title}*\nPriority: ${priority||'Medium'}\nStatus: Created\nCreated by: ${creator.name}${due_date ? '\nDue: '+due_date : ''}\n\n${description||''}`;
    translateText(msgEN, result.assignee_language).then(msg => sendWhatsApp(result.assignee_phone, msg).catch(console.error));
  }
  res.json(result);
});
app.put('/api/tasks/:id', async (req, res) => {
  const task = tasksCol.findOne({ id: req.params.id });
  if (!task) return res.status(404).json({ error: 'Not found' });
  const prev = { ...task };
  const { title, description, status, priority, assignee_id, due_date, updated_by } = req.body;
  if (title !== undefined) task.title = title;
  if (description !== undefined) task.description = description;
  if (status !== undefined) task.status = status;
  if (priority !== undefined) task.priority = priority;
  if (assignee_id !== undefined) task.assignee_id = assignee_id||null;
  if (due_date !== undefined) task.due_date = due_date||null;
  task.updated_at = now();
  tasksCol.update(task);
  for (const field of ['status','priority','assignee_id','title']) {
    if (req.body[field] !== undefined && req.body[field] !== prev[field]) {
      logsCol.insert({ id: uuidv4(), task_id: task.id, changed_by: updated_by||null, field_changed: field, old_value: prev[field], new_value: req.body[field], created_at: now() });
    }
  }
  db.saveDatabase();
  const result = withJoins(task);
  if (status && status !== prev.status && result.assignee_phone) {
    const msgEN = `🔄 Task status updated!\n\n*${task.title}*\nStatus: ${prev.status} → *${status}*\nPriority: ${task.priority}`;
    translateText(msgEN, result.assignee_language).then(msg => sendWhatsApp(result.assignee_phone, msg).catch(console.error));
  }
  res.json(result);
});
app.delete('/api/tasks/:id', (req, res) => {
  const task = tasksCol.findOne({ id: req.params.id });
  if (task) { logsCol.removeWhere({ task_id: req.params.id }); tasksCol.remove(task); db.saveDatabase(); }
  res.json({ ok: true });
});

// ─── Notify (manual WhatsApp) ─────────────────────────────────────────────────
app.post('/api/tasks/:id/notify', async (req, res) => {
  const task = tasksCol.findOne({ id: req.params.id });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const t = withJoins(task);
  const { message, lang } = req.body;
  const targetLang = lang || t.assignee_language || 'en';
  const baseMsg = message || `📋 Task Reminder: *${t.title}*\nStatus: ${t.status}\nPriority: ${t.priority}`;
  console.log(`📱 Notify: assignee_language=${t.assignee_language}, lang param=${lang}, using=${targetLang}`);
  const translated = await translateText(baseMsg, targetLang);
  try {
    const result = await sendWhatsApp(t.assignee_phone, translated);
    res.json({ ok: true, original: baseMsg, translated, lang_used: targetLang, simulated: result.simulated||false });
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
  app.listen(PORT, () => console.log(`🚀 TaskFlow running on http://localhost:${PORT}`));
});
