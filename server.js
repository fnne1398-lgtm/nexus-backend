const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const WORK_DIR = '/tmp/nexus_workspace';
const DB_PATH = '/tmp/nexus_memory.db';
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// \u2500\u2500 SQLite Memory \u2500\u2500
let db = null;
function initDB() {
  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT,
        key TEXT,
        value TEXT,
        ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT,
        task TEXT,
        done INTEGER DEFAULT 0,
        ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT,
        role TEXT,
        content TEXT,
        ts INTEGER
      );
    `);
    console.log('SQLite ready');
  } catch(e) {
    console.log('SQLite not available:', e.message);
    db = null;
  }
}

// \u2500\u2500 Health \u2500\u2500
app.get('/', (req, res) => res.json({
  status: 'NEXUS Online',
  version: '2.0',
  features: ['execute','memory','todos','history','fetch','build','git'],
  db: db ? 'sqlite' : 'none'
}));

// \u2500\u2500 Execute Code \u2500\u2500
app.post('/execute', async (req, res) => {
  const { code, language, filename } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });
  const sessionDir = path.join(WORK_DIR, Date.now().toString());
  fs.mkdirSync(sessionDir, { recursive: true });
  const fname = filename || (language === 'python' ? 'script.py' : language === 'node' ? 'script.js' : 'script.sh');
  const filePath = path.join(sessionDir, fname);
  fs.writeFileSync(filePath, code);
  try {
    let stdout = '', stderr = '';
    const opts = { timeout: 30000, cwd: sessionDir };
    if (language === 'python')      ({ stdout, stderr } = await execAsync(`python3 "${filePath}"`, opts));
    else if (language === 'node')   ({ stdout, stderr } = await execAsync(`node "${filePath}"`, opts));
    else if (language === 'bash')   ({ stdout, stderr } = await execAsync(`bash "${filePath}"`, opts));
    else stdout = 'File created';
    const files = fs.readdirSync(sessionDir).map(f => {
      const fp = path.join(sessionDir, f);
      let content = '';
      try { content = fs.readFileSync(fp, 'utf8'); } catch {}
      return { name: f, size: fs.statSync(fp).size, content };
    });
    res.json({ success: true, stdout, stderr, files });
  } catch (err) {
    res.json({ success: false, stdout: '', stderr: err.message, files: [] });
  }
});

// \u2500\u2500 Install Packages \u2500\u2500
app.post('/install', async (req, res) => {
  const { packages, manager } = req.body;
  if (!packages?.length) return res.status(400).json({ error: 'No packages' });
  try {
    const cmd = manager === 'pip'
      ? `pip install ${packages.join(' ')} --quiet 2>&1`
      : `npm install ${packages.join(' ')} 2>&1`;
    const { stdout } = await execAsync(cmd, { timeout: 120000 });
    res.json({ success: true, output: stdout });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// \u2500\u2500 Memory (SQLite) \u2500\u2500
app.post('/memory/set', (req, res) => {
  const { session='default', key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'No key' });
  if (!db) return res.json({ success: true, note: 'no db' });
  try {
    db.prepare('DELETE FROM memory WHERE session=? AND key=?').run(session, key);
    db.prepare('INSERT INTO memory (session,key,value,ts) VALUES (?,?,?,?)').run(session, key, JSON.stringify(value), Date.now());
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/memory/get', (req, res) => {
  const { session='default', key } = req.body;
  if (!db) return res.json({ success: true, value: null });
  try {
    const row = db.prepare('SELECT value FROM memory WHERE session=? AND key=?').get(session, key);
    res.json({ success: true, value: row ? JSON.parse(row.value) : null });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/memory/all', (req, res) => {
  const { session='default' } = req.body;
  if (!db) return res.json({ success: true, data: {} });
  try {
    const rows = db.prepare('SELECT key,value FROM memory WHERE session=?').all(session);
    const data = {};
    rows.forEach(r => { data[r.key] = JSON.parse(r.value); });
    res.json({ success: true, data });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// \u2500\u2500 Todo List (\u0632\u064a Manus) \u2500\u2500
app.post('/todos/add', (req, res) => {
  const { session='default', task } = req.body;
  if (!task) return res.status(400).json({ error: 'No task' });
  if (!db) return res.json({ success: true });
  try {
    db.prepare('INSERT INTO todos (session,task,done,ts) VALUES (?,?,0,?)').run(session, task, Date.now());
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/todos/done', (req, res) => {
  const { session='default', task } = req.body;
  if (!db) return res.json({ success: true });
  try {
    db.prepare('UPDATE todos SET done=1 WHERE session=? AND task=?').run(session, task);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/todos/list', (req, res) => {
  const { session='default' } = req.body;
  if (!db) return res.json({ success: true, todos: [] });
  try {
    const todos = db.prepare('SELECT task,done FROM todos WHERE session=? ORDER BY ts').all(session);
    res.json({ success: true, todos });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// \u2500\u2500 Chat History \u2500\u2500
app.post('/history/add', (req, res) => {
  const { session='default', role, content } = req.body;
  if (!db) return res.json({ success: true });
  try {
    db.prepare('INSERT INTO history (session,role,content,ts) VALUES (?,?,?,?)').run(session, role, content, Date.now());
    // keep last 50 messages only
    db.prepare('DELETE FROM history WHERE session=? AND id NOT IN (SELECT id FROM history WHERE session=? ORDER BY ts DESC LIMIT 50)').run(session, session);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/history/get', (req, res) => {
  const { session='default', limit=20 } = req.body;
  if (!db) return res.json({ success: true, messages: [] });
  try {
    const messages = db.prepare('SELECT role,content FROM history WHERE session=? ORDER BY ts DESC LIMIT ?').all(session, limit).reverse();
    res.json({ success: true, messages });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/history/clear', (req, res) => {
  const { session='default' } = req.body;
  if (!db) return res.json({ success: true });
  try {
    db.prepare('DELETE FROM history WHERE session=?').run(session);
    db.prepare('DELETE FROM todos WHERE session=?').run(session);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// \u2500\u2500 Fetch URL \u2500\u2500
app.post('/fetch', async (req, res) => {
  const { url, js=false } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL' });
  try {
    const { stdout } = await execAsync(
      `curl -s -L --max-time 15 --compressed -A "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" "${url}" | head -c 80000`,
      { timeout: 20000 }
    );
    // Clean HTML \u2014 remove scripts/styles for readability
    const clean = stdout
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/
