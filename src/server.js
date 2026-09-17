import http from 'node:http';
import { createActorContext } from './actor-context.js';
import { AgentHarness } from './harness.js';
import { modelAdapterFromEnvironment } from './openai-compatible-model.js';
import { PluginRegistry } from './plugins.js';
import { PromptAssembler } from './prompt.js';
import { PostgresDatabase, requireDatabaseUrl } from './postgres.js';
import { CapabilityBroker } from './capability-broker.js';
import { TenantStore } from './tenant-store.js';
import { PostgresMemoryStore, PostgresSessionEventLog, TenantRegistry } from './postgres-state.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const database = new PostgresDatabase({ databaseUrl: requireDatabaseUrl() });
const modelAdapter = modelAdapterFromEnvironment();
const tenantRegistry = new TenantRegistry({ database });
const eventLog = new PostgresSessionEventLog({ database });
const resourceStore = new TenantStore();
const memoryStore = new PostgresMemoryStore({ database });
const harness = new AgentHarness({
  eventLog,
  capabilityBroker: new CapabilityBroker({ resourceStore, allowedTools: new Set() }),
  pluginRegistry: new PluginRegistry({ allowUnverifiedPlugins: true }),
  resourceStore,
  memoryStore,
  promptAssembler: new PromptAssembler({
    systemInstructions: 'You are a data analysis assistant. Only use the current tenant context and never expose secrets.',
  }),
  modelAdapter,
});

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function developmentActor(request) {
  if (process.env.APP_ENV !== 'development') return null;
  const actorId = request.headers['x-dev-actor-id'] ?? 'local-user';
  const tenantId = request.headers['x-dev-tenant-id'] ?? process.env.DEV_DEFAULT_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
  if (Array.isArray(actorId) || Array.isArray(tenantId)) return null;
  try {
    if (!(await tenantRegistry.exists(tenantId))) return null;
    return createActorContext({ actorId, tenantId, scopes: ['agent:run'] });
  } catch {
    return null;
  }
}

async function sessionFor(actor, requestedSessionId) {
  if (requestedSessionId) {
    return (await eventLog.ownsSession(actor, requestedSessionId)) ? requestedSessionId : null;
  }
  return harness.createSession(actor);
}

function readJson(request, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function applicationHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Data Agent</title><style>
body{margin:0;background:#f4f6f8;color:#17212b;font:15px/1.5 system-ui,sans-serif}.app{max-width:1050px;margin:0 auto;padding:28px 20px}.top{display:flex;gap:18px;justify-content:space-between;align-items:center;border-bottom:1px solid #ccd3d8;padding-bottom:14px}.state{color:#56616b;font-size:13px}.workspace{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:600px}.history{border-right:1px solid #ccd3d8;padding:16px 14px 16px 0}.new{width:100%;margin-bottom:12px}.sessions{display:flex;flex-direction:column;gap:4px}.session{width:100%;border:0;border-left:3px solid transparent;background:transparent;text-align:left;padding:8px;color:#34414b;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session:hover,.session.active{background:#e4ecee;border-left-color:#177e89}.chat{padding-left:20px;display:flex;flex-direction:column}.messages{flex:1;min-height:420px;padding:12px 0}.message{padding:12px 14px;margin:10px 0;border:1px solid #d5dce1;border-radius:6px;background:#fff;white-space:pre-wrap}.user{border-left:4px solid #177e89}.assistant{border-left:4px solid #c58b28}.error{border-left:4px solid #bd3a3a}.composer{display:flex;gap:8px;border-top:1px solid #ccd3d8;padding-top:16px}textarea{flex:1;min-height:52px;resize:vertical;padding:10px;border:1px solid #aeb8bf;border-radius:4px;font:inherit}button{align-self:flex-end;background:#177e89;color:#fff;border:0;border-radius:4px;padding:11px 16px;font:inherit;cursor:pointer}button:disabled{opacity:.6;cursor:wait}@media(max-width:700px){.app{padding:18px 12px}.workspace{grid-template-columns:1fr}.history{border-right:0;border-bottom:1px solid #ccd3d8;padding-right:0}.chat{padding-left:0}.sessions{max-height:150px;overflow:auto}}</style></head>
<body><main class="app"><div class="top"><div><strong>Data Agent</strong><div class="state" id="state">Checking model configuration</div></div><label class="state">租户 <select id="tenant"></select></label><a href="/health">Health</a></div><div class="workspace"><aside class="history"><button class="new" id="new" type="button">新对话</button><div class="sessions" id="sessions"></div></aside><section class="chat"><section class="messages" id="messages"></section><form class="composer" id="composer"><textarea id="message" placeholder="输入数据分析问题" required></textarea><button id="send" type="submit">发送</button></form></section></div></main>
<script>const box=document.querySelector('#messages'),form=document.querySelector('#composer'),input=document.querySelector('#message'),send=document.querySelector('#send'),state=document.querySelector('#state'),tenant=document.querySelector('#tenant'),sessions=document.querySelector('#sessions'),newButton=document.querySelector('#new');let sessionId;function headers(){return{'content-type':'application/json','x-dev-tenant-id':tenant.value}}function add(role,text){const e=document.createElement('div');e.className='message '+role;e.textContent=text;box.append(e)}function render(events){box.replaceChildren();events.filter(e=>e.type==='user.message'||e.type==='assistant.message').forEach(e=>add(e.type==='user.message'?'user':'assistant',e.content));box.lastElementChild?.scrollIntoView({block:'end'})}async function refreshSessions(){const r=await fetch('/api/agent/sessions',{headers:headers()});const data=await r.json();sessions.replaceChildren();data.forEach(item=>{const b=document.createElement('button');b.className='session'+(item.sessionId===sessionId?' active':'');b.type='button';b.title=item.preview||'空会话';b.textContent=item.preview||'新对话';b.onclick=()=>loadSession(item.sessionId);sessions.append(b)})}async function loadSession(id){const r=await fetch('/api/agent/sessions/'+id+'/events',{headers:headers()});if(!r.ok)return;sessionId=id;render(await r.json());refreshSessions()}async function config(){const r=await fetch('/api/agent/config');const d=await r.json();state.textContent=d.modelConfigured?'模型已连接':'未配置 MODEL_API_KEY 或 MODEL_BASE_URL';const t=await fetch('/api/development/tenants');const tenants=await t.json();tenants.forEach(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=x.displayName;tenant.append(o)});refreshSessions()}config();tenant.addEventListener('change',()=>{sessionId=undefined;box.replaceChildren();refreshSessions()});newButton.onclick=()=>{sessionId=undefined;box.replaceChildren();input.focus()};form.addEventListener('submit',async e=>{e.preventDefault();const message=input.value.trim();if(!message)return;add('user',message);input.value='';send.disabled=true;try{const r=await fetch('/api/agent/messages',{method:'POST',headers:headers(),body:JSON.stringify({message,sessionId})});const d=await r.json();if(!r.ok)throw new Error(d.error||'请求失败');sessionId=d.sessionId;add('assistant',d.message);refreshSessions()}catch(err){add('error',err.message)}finally{send.disabled=false;input.focus()}});</script></body></html>`;
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(applicationHtml());
    return;
  }

  if (request.method === 'GET' && request.url === '/health') {
    try {
      const connection = await database.healthcheck();
      sendJson(response, 200, { status: 'ok', database: connection.database_name });
    } catch {
      sendJson(response, 503, { status: 'degraded', database: 'unavailable' });
    }
    return;
  }

  if (request.method === 'GET' && request.url === '/api/agent/config') {
    sendJson(response, 200, { modelConfigured: modelAdapter !== null, developmentMode: process.env.APP_ENV === 'development' });
    return;
  }

  if (request.method === 'GET' && request.url === '/api/agent/sessions') {
    const actor = await developmentActor(request);
    if (!actor) {
      sendJson(response, 403, { error: 'This development endpoint requires a valid development tenant.' });
      return;
    }
    sendJson(response, 200, await eventLog.listSessions(actor));
    return;
  }

  const sessionEventsMatch = request.method === 'GET' && request.url?.match(/^\/api\/agent\/sessions\/([0-9a-f-]+)\/events$/i);
  if (sessionEventsMatch) {
    const actor = await developmentActor(request);
    if (!actor) {
      sendJson(response, 403, { error: 'This development endpoint requires a valid development tenant.' });
      return;
    }
    try {
      const events = await eventLog.list(actor, sessionEventsMatch[1]);
      sendJson(response, 200, events
        .filter((event) => event.type === 'user.message' || event.type === 'assistant.message')
        .map((event) => ({ type: event.type, content: event.payload.content, timestamp: event.timestamp })));
    } catch {
      sendJson(response, 404, { error: 'Session not found.' });
    }
    return;
  }

  if (request.method === 'GET' && request.url === '/api/development/tenants') {
    if (process.env.APP_ENV !== 'development') {
      sendJson(response, 403, { error: 'Development mode is required.' });
      return;
    }
    sendJson(response, 200, await tenantRegistry.list());
    return;
  }

  if (request.method === 'POST' && request.url === '/api/agent/messages') {
    const actor = await developmentActor(request);
    if (!actor) {
      sendJson(response, 403, { error: 'This development endpoint requires APP_ENV=development.' });
      return;
    }
    if (!modelAdapter) {
      sendJson(response, 503, { error: 'Model is not configured. Set MODEL_API_KEY, MODEL_BASE_URL, and MODEL_NAME.' });
      return;
    }
    try {
      const { message, sessionId: requestedSessionId } = await readJson(request);
      const sessionId = await sessionFor(actor, requestedSessionId);
      if (!sessionId) {
        sendJson(response, 404, { error: 'Session not found.' });
        return;
      }
      const result = await harness.runModelTurn(actor, { sessionId, userMessage: message });
      sendJson(response, 200, { sessionId, message: result.message, memoryIds: result.memoryIds });
    } catch (error) {
      sendJson(response, 400, { error: error.name === 'ValidationError' ? error.message : 'Model request failed.' });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Tenant Data Agent Harness listening on http://127.0.0.1:${port}`);
});

async function shutdown() {
  server.close(() => undefined);
  await database.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
