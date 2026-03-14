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

// ── Keys stored SECURELY on backend ──
const KEYS = {
  groq:    process.env.GROQ_KEY    || '',
  netlify: process.env.NETLIFY_KEY || '',
  github:  process.env.GITHUB_KEY  || '',
};

// ── In-Memory Storage ──
const store = { memory:{}, todos:{}, history:{} };
function getObj(obj,s){ if(!obj[s])obj[s]={}; return obj[s]; }
function getArr(obj,s){ if(!obj[s])obj[s]=[]; return obj[s]; }

// ── Health ──
app.get('/', (req, res) => res.json({
  status: 'NEXUS Online',
  version: '4.0',
  features: ['groq-proxy','execute','memory','todos','history','fetch','build','git','netlify-proxy'],
}));

// ══════════════════════════════════════════
// GROQ PROXY — المتصفح يكلم Backend، Backend يكلم Groq
// ══════════════════════════════════════════
app.post('/ai/chat', async (req, res) => {
  const { messages, model, max_tokens=4000, temperature=0.72, stream=false } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KEYS.groq}`
      },
      body: JSON.stringify({
        model: model || 'llama-3.3-70b-versatile',
        messages,
        max_tokens,
        temperature,
        stream
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(()=>({}));
      return res.status(r.status).json({ error: err.error?.message || 'Groq error '+r.status });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const reader = r.body;
      reader.pipe(res);
    } else {
      const data = await r.json();
      res.json(data);
    }
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Groq Models (health check) ──
app.get('/ai/models', async (req, res) => {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${KEYS.groq}` }
    });
    const ok = r.ok;
    res.json({ ok, status: r.status });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// NETLIFY PROXY
// ══════════════════════════════════════════
app.post('/netlify/deploy', async (req, res) => {
  const { html, siteName } = req.body;
  if (!html) return res.status(400).json({ error: 'No HTML' });

  try {
    const name = siteName || ('nexus-'+Math.random().toString(36).slice(2,8));

    // Create site
    const sr = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${KEYS.netlify}` },
      body: JSON.stringify({ name })
    });
    if (!sr.ok) throw new Error('site create: '+sr.status);
    const site = await sr.json();

    // SHA1
    const crypto = require('crypto');
    const fileHash = crypto.createHash('sha1').update(html).digest('hex');

    // Create deploy
    const dr = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${KEYS.netlify}` },
      body: JSON.stringify({ files: { '/index.html': fileHash } })
    });
    if (!dr.ok) throw new Error('deploy create: '+dr.status);
    const dep = await dr.json();

    // Upload
    const ur = await fetch(`https://api.netlify.com/api/v1/deploys/${dep.id}/files/index.html`, {
      method: 'PUT',
      headers: { 'Content-Type':'application/octet-stream', 'Authorization':`Bearer ${KEYS.netlify}` },
      body: html
    });
    if (!ur.ok) throw new Error('upload: '+ur.status);

    // Poll for ready
    let finalUrl = site.ssl_url || `https://${site.subdomain}.netlify.app`;
    for (let i=0; i<15; i++) {
      await new Promise(r=>setTimeout(r,2000));
      try {
        const check = await fetch(`https://api.netlify.com/api/v1/deploys/${dep.id}`, {
          headers: { 'Authorization':`Bearer ${KEYS.netlify}` }
        });
        const d = await check.json();
        if (d.state==='ready'||d.state==='current') { finalUrl=d.ssl_url||finalUrl; break; }
        if (d.state==='error') throw new Error('deploy error: '+d.error_message);
      } catch(e) { if(e.message.startsWith('deploy error')) throw e; }
    }

    res.json({ success: true, url: finalUrl });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Netlify check ──
app.get('/netlify/check', async (req, res) => {
  try {
    const r = await fetch('https://api.netlify.com/api/v1/user', {
      headers: { 'Authorization': `Bearer ${KEYS.netlify}` }
    });
    res.json({ ok: r.ok, status: r.status });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════
// EXECUTE CODE
// ══════════════════════════════════════════
app.post('/execute', async (req, res) => {
  const { code, language, filename } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });
  const dir = path.join(WORK_DIR, Date.now().toString());
  fs.mkdirSync(dir, { recursive: true });
  const fname = filename||(language==='python'?'script.py':language==='node'?'script.js':'script.sh');
  const fp = path.join(dir, fname);
  fs.writeFileSync(fp, code);
  try {
    let stdout='', stderr='';
    const opts = { timeout:30000, cwd:dir };
    if(language==='python')    ({stdout,stderr}=await execAsync(`python3 "${fp}"`,opts));
    else if(language==='node') ({stdout,stderr}=await execAsync(`node "${fp}"`,opts));
    else if(language==='bash') ({stdout,stderr}=await execAsync(`bash "${fp}"`,opts));
    else stdout='File created';
    const files=fs.readdirSync(dir).map(f=>{
      const p=path.join(dir,f); let content='';
      try{content=fs.readFileSync(p,'utf8');}catch{}
      return{name:f,size:fs.statSync(p).size,content};
    });
    res.json({success:true,stdout,stderr,files});
  } catch(err){ res.json({success:false,stdout:'',stderr:err.message,files:[]}); }
});

// ── Fetch URL ──
app.post('/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL' });
  try {
    const {stdout} = await execAsync(
      `curl -s -L --max-time 15 --compressed -A "Mozilla/5.0" "${url.replace(/"/g,'')}" | head -c 80000`,
      {timeout:20000}
    );
    const clean=stdout.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,8000);
    res.json({success:true,content:stdout,text:clean});
  } catch(err){ res.json({success:false,error:err.message}); }
});

// ── Memory ──
app.post('/memory/set',(req,res)=>{ const{session='default',key,value}=req.body; if(!key)return res.status(400).json({error:'No key'}); getObj(store.memory,session)[key]=value; res.json({success:true}); });
app.post('/memory/get',(req,res)=>{ const{session='default',key}=req.body; res.json({success:true,value:getObj(store.memory,session)[key]??null}); });

// ── Todos ──
app.post('/todos/add',(req,res)=>{ const{session='default',task}=req.body; if(!task)return res.status(400).json({error:'No task'}); getArr(store.todos,session).push({task,done:false,ts:Date.now()}); res.json({success:true}); });
app.post('/todos/done',(req,res)=>{ const{session='default',task}=req.body; const t=getArr(store.todos,session).find(x=>x.task===task); if(t)t.done=true; res.json({success:true}); });
app.post('/todos/list',(req,res)=>{ const{session='default'}=req.body; res.json({success:true,todos:getArr(store.todos,session)}); });

// ── History ──
app.post('/history/add',(req,res)=>{ const{session='default',role,content}=req.body; const h=getArr(store.history,session); h.push({role,content,ts:Date.now()}); if(h.length>50)store.history[session]=h.slice(-50); res.json({success:true}); });
app.post('/history/get',(req,res)=>{ const{session='default',limit=20}=req.body; res.json({success:true,messages:getArr(store.history,session).slice(-limit)}); });
app.post('/history/clear',(req,res)=>{ const{session='default'}=req.body; store.history[session]=[]; store.todos[session]=[]; store.memory[session]={}; res.json({success:true}); });

// ── Build ──
app.post('/build', async (req, res) => {
  const { files, buildCmd } = req.body;
  if (!files) return res.status(400).json({ error: 'No files' });
  const buildDir = path.join(WORK_DIR, 'build_'+Date.now());
  fs.mkdirSync(buildDir, {recursive:true});
  try {
    for(const [name, content] of Object.entries(files)){
      const fp=path.join(buildDir,name); fs.mkdirSync(path.dirname(fp),{recursive:true}); fs.writeFileSync(fp,content);
    }
    let output='Files written';
    if(buildCmd){ const{stdout}=await execAsync(buildCmd,{cwd:buildDir,timeout:120000}); output=stdout; }
    const allFiles={};
    const walk=(dir)=>{ for(const f of fs.readdirSync(dir)){ const fp=path.join(dir,f); if(fs.statSync(fp).isDirectory()){walk(fp);continue;} try{allFiles[path.relative(buildDir,fp)]=fs.readFileSync(fp,'utf8');}catch{} } };
    walk(buildDir);
    res.json({success:true,output,files:allFiles});
  } catch(err){ res.json({success:false,error:err.message}); }
});

// ── Git Push ──
app.post('/git/push', async (req, res) => {
  const { repo, files, message='NEXUS commit' } = req.body;
  if (!repo||!files) return res.status(400).json({ error: 'Missing params' });
  const repoDir = path.join(WORK_DIR, 'git_'+Date.now());
  fs.mkdirSync(repoDir, {recursive:true});
  try {
    for(const [fname, content] of Object.entries(files)){
      const fp=path.join(repoDir,fname); fs.mkdirSync(path.dirname(fp),{recursive:true}); fs.writeFileSync(fp,content);
    }
    const remote=`https://${KEYS.github}@github.com/${repo}.git`;
    const {stdout}=await execAsync(['git init','git config user.email "nexus@agent.ai"','git config user.name "NEXUS"','git add .',`git commit -m "${message}"`,'git remote add origin '+remote,'git push -u origin main --force 2>&1 || git push -u origin master --force 2>&1'].join(' && '),{cwd:repoDir,timeout:60000});
    res.json({success:true,output:stdout});
  } catch(err){ res.json({success:false,error:err.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NEXUS v4.0 running on port ${PORT}`));
          
