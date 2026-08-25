/**
 * auto-router.js — 均衡模型路由器 (纯 Node, Termux 非 proot 友好)
 *
 * 前端统一暴露虚拟模型 "auto" (OpenAI 兼容, 端口 3650)。
 * 用商汤免费小模型做难度分类器，把请求按难度路由到不同上游：
 *   SIMPLE   -> sensenova-6.7-flash-lite (免费)
 *   STANDARD -> sensenova-u1-fast        (免费, 失败降级 6.7)
 *   COMPLEX  -> hy3        (cloudbase 3640)
 *   CODE     -> hy3-preview(cloudbase 3640)
 * 所有上游均为 free 模型 (商汤 token-plan pricing=0) + CloudBase 免费渠道。
 * 任一上游失败自动 fallback 到下一个可用 free 模型 / hy3。
 *
 * 启动: TCB_TOKEN=... SENSENOVA_KEY=... node auto-router.js
 * 也可不传 SENSENOVA_KEY, 自动读 HERMES_CUSTOM_TOKEN_SENSENOVA_CN_API_KEY。
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const PORT = parseInt(process.env.ROUTER_PORT || '3650', 10);

// 解析 key: 优先 env, 否则从 ~/.hermes/.env 读取 (Hermes 存 key 的地方)
function loadSensenovaKey() {
  if (process.env.SENSENOVA_KEY) return process.env.SENSENOVA_KEY;
  if (process.env.HERMES_CUSTOM_TOKEN_SENSENOVA_CN_API_KEY) return process.env.HERMES_CUSTOM_TOKEN_SENSENOVA_CN_API_KEY;
  const envPath = require('path').join(process.env.HOME || '/data/data/com.termux/files/home', '.hermes', '.env');
  try {
    const txt = fs.readFileSync(envPath, 'utf-8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*HERMES_CUSTOM_TOKEN_SENSENOVA_CN_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ignore */ }
  return '';
}
const SENSENOVA_KEY = loadSensenovaKey();
const CLOUDBASE_URL = 'http://127.0.0.1:3640/v1/chat/completions';
const SENSENOVA_URL = 'https://token.sensenova.cn/v1/chat/completions';

// ── 路由表 (可见回复模型: 全部走干净的 hy3 通道, 无 reasoning 污染) ──
// 商汤 6.7-flash-lite 只在分类器(单次调用, 响应丢弃)中使用, 不进路由表:
//   它的流式会把思维链+正文都塞进 delta.reasoning, 直接连会造成历史洪水。
const TIERS = {
  // SIMPLE/STANDARD 也走 hy3(主模型), 分类器负责区分; hy3 免费且干净
  SIMPLE:   [{ url: CLOUDBASE_URL, key: '', model: 'hy3' }],
  STANDARD: [{ url: CLOUDBASE_URL, key: '', model: 'hy3' }],
  COMPLEX:  [{ url: CLOUDBASE_URL, key: '', model: 'hy3' }],
  CODE:     [{ url: CLOUDBASE_URL, key: '', model: 'hy3-preview' }],
};
const FALLBACK_ORDER = ['SIMPLE', 'STANDARD', 'COMPLEX', 'CODE'];

// ── 工具 ──
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
// 剥离 reasoning 字段族, 防止商汤/hy3 的思维链污染会话历史
function scrub(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const out = Object.assign({}, msg);
  delete out.reasoning;
  delete out['thinking'];
  delete out.reasoning_content;
  const c = out.content;
  if (typeof c === 'string') {
    const cleaned = c.replace(/Thinking Process:\s*[\s\S]*?(\d+\.|\*\*Analyze)/i, '')
                     .replace(/```.*?```/gs, '')
                     .replace(/\s*\n{2,}\s*/g, '\n').trim();
    if (cleaned !== c) out.content = cleaned;
  }
  return out;
}
function cleanBody(b) {
  if (!b) return b;
  const out = Object.assign({}, b);
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map(scrub);
  }
  return out;
}
function pickTierByHeuristic(messages) {
  // 无分类器或分类失败时用的规则兜底
  const last = messages[messages.length - 1];
  const text = (last?.content || '');
  const txt = typeof text === 'string' ? text : JSON.stringify(text);
  const lower = txt.toLowerCase();
  const codeSignals = /```|def |function |class |import |```\w*|python|javascript|typescript|rust|java\b|sql\b|regex|algorithm|bug|debug|refactor|编译|代码|报错|函数|类 |报错|编译错误/i;
  const complexSignals = /分析|推理|为什么|设计|架构|方案|总结.*篇|对比|评估|规划|论证|解释.*原理|步骤|策略|agent|multi-?step|reason|analyze|design|explain|compare|evaluate|plan/i;
  if (codeSignals.test(txt)) return 'CODE';
  if (complexSignals.test(txt) || txt.length > 400) return 'COMPLEX';
  if (txt.length > 120) return 'STANDARD';
  return 'SIMPLE';
}

// 调用商汤小模型做难度分类 (JSON 模式)
async function classify(messages) {
  const sys = { role: 'system', content:
    'You are a routing classifier. Given the conversation, output ONLY a JSON object: ' +
    '{"tier":"SIMPLE|STANDARD|COMPLEX|CODE","reason":"<5 words>"}. ' +
    'SIMPLE=greeting/short factual/translation/draft; STANDARD=paraphrase/summarize short/extraction; ' +
    'COMPLEX=multi-step reasoning/analysis/long; CODE=any programming/coding/debug task.' };
  const payload = JSON.stringify({
    model: 'sensenova-6.7-flash-lite',
    messages: [sys, ...messages.slice(-4)],
    temperature: 0,
    stream: false,
    response_format: { type: 'json_object' },
  });
  const u = new URL(SENSENOVA_URL);
  return new Promise((resolve) => {
    const r = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SENSENOVA_KEY}`,
        'Content-Length': Buffer.byteLength(payload) },
      timeout: 8000,
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          const content = j.choices?.[0]?.message?.content || '';
          const m = content.match(/\{[\s\S]*\}/);
          const obj = m ? JSON.parse(m[0]) : {};
          const tier = ['SIMPLE','STANDARD','COMPLEX','CODE'].includes(obj.tier) ? obj.tier : null;
          resolve(tier);
        } catch (e) { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(payload); r.end();
  });
}

// 向上游发请求并取原始响应体 (非流式)
function upstreamNonStream(up, body) {
  return new Promise((resolve, reject) => {
    const isHttps = up.url.startsWith('https');
    const u = new URL(up.url);
    const isSensenova = up.url === SENSENOVA_URL;
    const payload = JSON.stringify({ ...body, model: up.model, stream: false, ...(isSensenova ? { reasoning_config: { disabled: true } } : {}) });
    const port = u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80);
    const opt = {
      method: 'POST', hostname: u.hostname, port, path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 60000,
    };
    if (up.key) opt.headers['Authorization'] = `Bearer ${up.key}`;
    const req = (isHttps ? https : http).request(opt, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`upstream ${res.statusCode}: ${b.slice(0,120)}`));
        else resolve({ status: res.statusCode, body: b, isSensenova });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload); req.end();
  });
}

// 向上游发请求并流式转发 SSE
function forwardStream(res, up, body) {
  return new Promise((resolve, reject) => {
    const isHttps = up.url.startsWith('https');
    const u = new URL(up.url);
    const isSensenova = up.url === SENSENOVA_URL;
    const payload = JSON.stringify({ ...body, model: up.model, stream: true, ...(isSensenova ? { reasoning_config: { disabled: true } } : {}) });
    const port = u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80);
    const opt = {
      method: 'POST', hostname: u.hostname, port, path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 60000,
    };
    if (up.key) opt.headers['Authorization'] = `Bearer ${up.key}`;
    const req = (isHttps ? https : http).request(opt, (upRes) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
        'X-Routed-Model': up.model,
      });
      // 剥离 SSE chunk 里的 delta.reasoning, 防止思维链进入 Hermes 会话历史
      const stripReasoning = (chunk) => {
        if (!chunk) return chunk;
        const ch = Object.assign({}, chunk);
        if (ch.choices) {
          ch.choices = ch.choices.map(c => {
            const nc = Object.assign({}, c);
            if (nc.delta) { delete nc.delta.reasoning; delete nc.delta.thinking; delete nc.delta.reasoning_content; }
            if (nc.message) { delete nc.message.reasoning; delete nc.message.thinking; delete nc.message.reasoning_content; }
            return nc;
          });
        }
        return ch;
      };
      upRes.on('data', (c) => {
        const txt = c.toString();
        const lines = txt.split('\n');
        for (const ln of lines) {
          if (ln.startsWith('data: ')) {
            try {
              const obj = JSON.parse(ln.slice(6));
              res.write(`data: ${JSON.stringify(stripReasoning(obj))}\n\n`);
            } catch { res.write(ln + '\n\n'); }
          } else { res.write(ln + '\n'); }
        }
      });
      upRes.on('end', () => { if (!res.writableEnded) res.end(); resolve(up.model); });
      upRes.on('error', (e) => { if (!res.writableEnded) { res.write(`data: [DONE]\n\n`); res.end(); } reject(e); });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// 清洗响应体: 删除 choice.message 里的 reasoning/thinking 字段
function scrubResponse(parsed) {
  if (!parsed || !parsed.choices) return parsed;
  parsed.choices = parsed.choices.map(ch => {
    const n = Object.assign({}, ch);
    if (n.message) { delete n.message.reasoning; delete n.message.thinking; delete n.message.reasoning_content; }
    return n;
  });
  return parsed;
}
async function tryTier(tierName, body, res, isStream) {
  const candidates = TIERS[tierName] || TIERS.SIMPLE;
  let lastErr;
  for (const up of candidates) {
    try {
      if (isStream) {
        await forwardStream(res, up, body);
        return up.model;
      } else {
        const r = await upstreamNonStream(up, body);
        return { model: up.model, status: r.status, body: r.body };
      }
    } catch (e) { lastErr = e; console.warn(`[router] ${tierName} candidate ${up.model} failed: ${e.message}`); }
  }
  throw lastErr || new Error('no candidates');
}

async function route(body, res) {
  const isStream = body.stream === true;
  // 清洗入站 messages: 剥离前几轮残留的 reasoning/thinking, 防止历史被思维链撑爆
  body = cleanBody(body);
  const messages = body.messages || [];

  // 1) 分类
  let tier = null;
  if (SENSENOVA_KEY) tier = await classify(messages);
  if (!tier) tier = pickTierByHeuristic(messages);
  console.log(`[router] tier=${tier} (model=${body.model})`);

  // 2) 主 tier 优先
  try {
    const r = await tryTier(tier, body, res, isStream);
    if (!isStream) {
      const parsed = scrubResponse(JSON.parse(r.body));
      parsed.model = r.model;
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'X-Routed-Model': r.model });
      res.end(JSON.stringify(parsed));
    }
    return;
  } catch (e) { console.warn(`[router] primary tier ${tier} exhausted: ${e.message}`); }

  // 3) 跨 tier fallback (保持 free 优先, hy3 殿后)
  for (const t of FALLBACK_ORDER) {
    if (t === tier) continue;
    try {
      const r = await tryTier(t, body, res, isStream);
      if (!isStream) {
        const parsed = JSON.parse(r.body);
        parsed.model = r.model;
        res.writeHead(r.status, { 'Content-Type': 'application/json', 'X-Routed-Model': r.model });
        res.end(JSON.stringify(parsed));
      }
      return;
    } catch (e) { console.warn(`[router] fallback tier ${t} failed: ${e.message}`); }
  }
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'all upstreams failed', type: 'router_error' } }));
}

// ── HTTP 服务 ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && req.url === '/health') {
    return res.writeHead(200, { 'Content-Type': 'application/json' }),
      res.end(JSON.stringify({ status: 'ok', router: 'auto', tiers: Object.keys(TIERS) }));
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    return res.writeHead(200, { 'Content-Type': 'application/json' }),
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'auto', object: 'model', created: Date.now(), owned_by: 'router' },
      ] }));
  }
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    try {
      const body = await bodyJson(req);
      if (body.model && body.model !== 'auto') {
        // 显式真实模型名透传: 直接走对应上游 (若匹配已知模型)
        const known = Object.values(TIERS).flat().find(u => u.model === body.model);
        if (known) {
          const isStream = body.stream === true;
          try {
            const r = await tryTier(Object.keys(TIERS).find(t => TIERS[t].some(u=>u.model===body.model)), body, res, isStream);
            if (!isStream) { const p=scrubResponse(JSON.parse(r.body)); p.model=r.model; res.writeHead(r.status,{'Content-Type':'application/json','X-Routed-Model':r.model}); res.end(JSON.stringify(p)); }
            return;
          } catch (e) { /* fall through to auto */ }
        }
      }
      await route(body, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'router_error' } }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`auto-router listening on http://127.0.0.1:${PORT}  (model: "auto")`);
  console.log(`classifier: ${SENSENOVA_KEY ? 'sensenova-6.7-flash-lite' : 'heuristic-only'}`);
});
