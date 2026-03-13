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
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ── In-Memory Storage (no external DB needed) ──
const store = {
  memory: {},   // session -> { key: value }
  todos: {},    // session -> [ {task, done, ts} ]
  history: {}   // session -> [ {role, content, ts} ]
};

function getSession(obj, session) {
  if (!obj[session]) obj[session] = [];
  return obj[session];
}
function getSessionObj(session) {
  if (!store.memory[session]) store.memory[session] = {};
  return store.memory[session];
}

// ── Health ──
app.get('/', (req, res) => res.json({
  status: 'NEXUS Online',
  version: '2.1',
  features: ['execute','memory','todos','history','fetch','build','git'],
  storage: 'in-memory'
}));

// ── Execute Code ──
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
    if (language === 'python')     ({ stdout, stderr } = await execAsync(`python3 "${filePath}"`, opts));
    else if (language === 'node')  ({ stdout, stderr } = await execAsync(`node "${filePath}"`, opts));
    else if (language === 'bash')  ({ stdout, stderr } = await execAsync(`bash "${filePath}"`, opts));
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

// ── Install Packages ──
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

// ── Memory ──
app.post('/memory/set', (req, res) => {
  const { session = 'default', key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'No key' });
  getSessionObj(session)[key] = value;
  res.json({ success: true });
});

app.post('/memory/get', (req, res) => {
  const { session = 'default', key } = req.body;
  const val = getSessionObj(session)[key] ?? null;
  res.json({ success: true, value: val });
});

app.post('/memory/all', (req, res) => {
  const { session = 'default' } = req.body;
  res.json({ success: true, data: getSessionObj(session) });
});

// ── Todo List (زي Manus) ──
app.post('/todos/add', (req, res) => {
  const { session = 'default', task } = req.body;
  if (!task) return res.status(400).json({ error: 'No task' });
  getSession(store.todos, session).push({ task, done: false, ts: Date.now() });
  res.json({ success: true });
});

app.post('/todos/done', (req, res) => {
  const { session = 'default', task } = req.body;
  const todos = getSession(store.todos, session);
  const t = todos.find(x => x.task === task);
  if (t) t.done = true;
  res.json({ success: true });
});

app.post('/todos/list', (req, res) => {
  const { session = 'default' } = req.body;
  res.json({ success: true, todos: getSession(store.todos, session) });
});

app.post('/todos/clear', (req, res) => {
  const { session = 'default' } = req.body;
  store.todos[session] = [];
  res.json({ success: true });
});

// ── Chat History ──
app.post('/history/add', (req, res) => {
  const { session = 'default', role, content } = req.body;
  const h = getSession(store.history, session);
  h.push({ role, content, ts: Date.now() });
  // keep last 50 only
  if (h.length > 50) store.history[session] = h.slice(-50);
  res.json({ success: true });
});

app.post('/history/get', (req, res) => {
  const { session = 'default', limit = 20 } = req.body;
  const h = getSession(store.history, session);
  res.json({ success: true, messages: h.slice(-limit) });
});

app.post('/history/clear', (req, res) => {
  const { session = 'default' } = req.body;
  store.history[session] = [];
  store.todos[session] = [];
  store.memory[session] = {};
  res.json({ success: true });
});

// ── Fetch URL ──
app.post('/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL' });
  try {
    const { stdout } = await execAsync(
      `curl -s -L --max-time 15 --compressed -A "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" "${url}" | head -c 80000`,
      { timeout: 20000 }
    );
    const clean = stdout
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 8000);
    res.json({ success: true, content: stdout, text: clean });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── File System ──
app.post('/files/write', (req, res) => {
  const { filePath, content } = req.body;
  try {
    const full = path.join(WORK_DIR, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.get('/files/read', (req, res) => {
  try {
    const content = fs.readFileSync(path.join(WORK_DIR, req.query.filePath), 'utf8');
    res.json({ success: true, content });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.get('/files/list', (req, res) => {
  try {
    const dir = req.query.dir ? path.join(WORK_DIR, req.query.dir) : WORK_DIR;
    const files = fs.readdirSync(dir).map(f => {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      return { name: f, size: stat.size, isDir: stat.isDirectory() };
    });
    res.json({ success: true, files });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Build Project ──
app.post('/build', async (req, res) => {
  const { files, buildCmd } = req.body;
  if (!files) return res.status(400).json({ error: 'No files' });
  const buildDir = path.join(WORK_DIR, 'build_' + Date.now());
  fs.mkdirSync(buildDir, { recursive: true });
  try {
    for (const [name, content] of Object.entries(files)) {
      const fp = path.join(buildDir, name);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    let output = 'Files written';
    if (buildCmd) {
      const { stdout } = await execAsync(buildCmd, { cwd: buildDir, timeout: 120000 });
      output = stdout;
    }
    const allFiles = {};
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).isDirectory()) { walk(fp); continue; }
        try { allFiles[path.relative(buildDir, fp)] = fs.readFileSync(fp, 'utf8'); } catch {}
      }
    };
    walk(buildDir);
    res.json({ success: true, output, files: allFiles });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Git Push ──
app.post('/git/push', async (req, res) => {
  const { token, repo, files, message = 'NEXUS commit' } = req.body;
  if (!token || !repo || !files) return res.status(400).json({ error: 'Missing params' });
  const repoDir = path.join(WORK_DIR, 'git_' + Date.now());
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    for (const [fname, content] of Object.entries(files)) {
      const fp = path.join(repoDir, fname);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    const remote = `https://${token}@github.com/${repo}.git`;
    const { stdout } = await execAsync([
      'git init',
      'git config user.email "nexus@agent.ai"',
      'git config user.name "NEXUS"',
      'git add .',
      `git commit -m "${message}"`,
      `git remote add origin ${remote}`,
      'git push -u origin main --force 2>&1 || git push -u origin master --force 2>&1'
    ].join(' && '), { cwd: repoDir, timeout: 60000 });
    res.json({ success: true, output: stdout });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NEXUS v2.1 running on port ${PORT}`));
         
