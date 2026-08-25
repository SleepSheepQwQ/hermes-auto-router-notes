const http = require('http');
const cloudbase = require('@cloudbase/node-sdk');

// CloudBase 配置
const ENV_ID = 'termux-d6gzw6idcffeb1041';
const JWT = process.env.TCB_TOKEN;
const PORT = parseInt(process.env.PORT || '3640', 10);

// 初始化 CloudBase
const app = cloudbase.init({ env: ENV_ID, accessKey: JWT });
const ai = app.ai();

// 支持的模型列表
const SUPPORTED_MODELS = ['hy3', 'hy3-preview'];

// 解析请求 body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 从 OpenAI 请求体中挑选安全字段，映射为 CloudBase 网关参数
function buildCloudBaseData(body) {
  const data = {
    model: body.model || 'hy3',
    messages: body.messages || [],
  };
  if (body.max_tokens != null) data.max_tokens = body.max_tokens;
  if (body.temperature != null) data.temperature = body.temperature;
  if (body.top_p != null) data.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) data.tools = body.tools;
  if (body.tool_choice != null) data.tool_choice = body.tool_choice;
  return data;
}

// 解析 SSE 流，逐个 yield 解析后的 JSON chunk
async function* parseSSE(rawStream) {
  const reader = rawStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') return;
          if (payload) {
            try {
              yield JSON.parse(payload);
            } catch (e) {
              console.warn('SSE parse warning:', e.message, '| payload:', payload.slice(0, 100));
            }
          }
        }
      }
    }

    // 处理最后可能残留的 buffer
    if (buffer.startsWith('data: ')) {
      const payload = buffer.slice(6).trim();
      if (payload && payload !== '[DONE]') {
        try {
          yield JSON.parse(payload);
        } catch (e) {
          console.warn('SSE final parse warning:', e.message);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// 处理非流式调用 → 使用 ReactModel.generateText (maxSteps=1)
async function handleNonStream(model, body) {
  const m = ai.createModel('cloudbase');
  const input = {
    model: body.model || 'hy3',
    messages: body.messages || [],
    maxSteps: 1,
  };
  if (body.max_tokens != null) input.maxTokens = body.max_tokens;
  if (body.temperature != null) input.temperature = body.temperature;
  if (body.top_p != null) input.topP = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) input.tools = body.tools;
  if (body.tool_choice != null) input.toolChoice = body.tool_choice;

  // 超时 600 秒（网关可能慢）
  const res = await m.generateText(input, { timeout: 600000 });

  const raw = res.rawResponses?.[0] || res;
  const choice = raw?.choices?.[0];
  const message = choice?.message || {};

  return {
    id: raw?.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: raw?.created || Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: message.content != null ? message.content : (res.text ?? null),
        ...(Array.isArray(message.tool_calls) && message.tool_calls.length ? { tool_calls: message.tool_calls } : {}),
      },
      finish_reason: message.tool_calls?.length ? 'tool_calls' : (choice?.finish_reason || 'stop'),
    }],
    usage: raw?.usage || res.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// 处理流式调用 → 直接调用 CloudBase 网关原始 SSE 流，逐块转发
async function handleStream(res, model, body) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const m = ai.createModel('cloudbase');
  const data = buildCloudBaseData(body);
  data.stream = true;

  try {
    // 直接调用底层 req 获取原始 SSE 流（绕过 ReactModel 的工具循环）
    const rawStream = await m.model.req({
      url: m.model.url,
      data: data,
      stream: true,
    });

    // rawStream 是 ReadableStream<Uint8Array>，解析 SSE 并转发
    for await (const chunk of parseSSE(rawStream)) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }

    // 发结束标记
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (e) {
    console.error('Stream error:', e.message);
    if (!res.writableEnded) {
      // 发一个错误 chunk 以便 Hermes 的 openai SDK 能识别错误
      const errChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
      };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

// 创建 HTTP 服务
const server = http.createServer({
  // keep-alive 超时拉高到 61s(匹配上游 hy3 超时), 避免空闲连接被过早杀掉导致流式复用连接卡死
  keepAliveTimeout: 61000,
  headersTimeout: 61000,
}, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', models: SUPPORTED_MODELS }));
    return;
  }

  // 模型列表
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: SUPPORTED_MODELS.map(m => ({
        id: m, object: 'model', created: Date.now(), owned_by: 'cloudbase',
      })),
    }));
    return;
  }

  // Chat completions
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    try {
      const body = await parseBody(req);
      const model = SUPPORTED_MODELS.includes(body.model) ? body.model : 'hy3';

      const stream = body.stream === true;
      console.log(`Request: model=${model}, stream=${stream}, messages=${body.messages?.length || 0}, tools=${body.tools?.length || 0}`);

      if (stream) {
        await handleStream(res, model, body);
      } else {
        const result = await handleNonStream(model, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    } catch (e) {
      console.error('Error:', e.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        error: { message: e.message, type: 'server_error', code: 'internal_error' },
      }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CloudBase AI Proxy running on http://127.0.0.1:${PORT}`);
  console.log(`OpenAI-compatible endpoint: http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(`Supported models: ${SUPPORTED_MODELS.join(', ')}`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  process.exit(0);
});