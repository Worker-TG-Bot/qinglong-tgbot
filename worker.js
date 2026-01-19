

// ============================================================
// 青龙面板 Telegram Bot - Cloudflare Worker v3.3 性能优化版
// 优化: Token缓存 + 并行请求 + Durable Objects缓存
// ============================================================

const BOT_COMMANDS = [
  { command: 'start', description: '开始使用' },
  { command: 'tasks', description: '任务管理' },
  { command: 'envs', description: '环境变量' },
  { command: 'subs', description: '订阅管理' },
  { command: 'deps', description: '依赖管理' },
  { command: 'scripts', description: '脚本管理' },
  { command: 'help', description: '帮助信息' },
];

// 用户状态存储
const userStates = new Map();

// 青龙 Token 缓存 - 提前5分钟刷新
let qlTokenCache = { token: null, expiry: 0 };
const TOKEN_REFRESH_BUFFER = 300000; // 5分钟
const REQUEST_TIMEOUT = 10000; // 10秒超时

// 缓存配置
const CACHE_TTL = {
  tasks: 30000,      // 任务列表缓存 30秒
  envs: 60000,       // 环境变量缓存 60秒
  subs: 60000,       // 订阅缓存 60秒
  deps: 120000,      // 依赖缓存 2分钟
  scripts: 30000,    // 脚本列表缓存 30秒
};

// ==================== Durable Objects 缓存类 ====================
export class QlCache {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    if (url.pathname === '/get') {
      const key = url.searchParams.get('key');
      const cached = await this.state.storage.get(key);
      
      if (cached && cached.expiry > Date.now()) {
        return new Response(JSON.stringify({ 
          hit: true, 
          data: cached.data 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({ hit: false }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/set') {
      const key = url.searchParams.get('key');
      const ttl = parseInt(url.searchParams.get('ttl')) || 60000;
      const data = await request.json();
      
      await this.state.storage.put(key, {
        data: data,
        expiry: Date.now() + ttl
      });
      
      return new Response(JSON.stringify({ success: true }));
    }
    
    if (url.pathname === '/delete') {
      const key = url.searchParams.get('key');
      await this.state.storage.delete(key);
      return new Response(JSON.stringify({ success: true }));
    }
    
    if (url.pathname === '/clear') {
      const prefix = url.searchParams.get('prefix');
      if (prefix) {
        const keys = await this.state.storage.list({ prefix: prefix });
        await this.state.storage.delete(Array.from(keys.keys()));
      } else {
        await this.state.storage.deleteAll();
      }
      return new Response(JSON.stringify({ success: true }));
    }
    
    return new Response('Not Found', { status: 404 });
  }
}

// ==================== 缓存辅助函数 ====================
async function getCacheStub(env, chatId) {
  const id = env.QL_CACHE.idFromName('cache-' + chatId);
  return env.QL_CACHE.get(id);
}

async function getFromCache(env, chatId, key) {
  try {
    const stub = await getCacheStub(env, chatId);
    const resp = await stub.fetch('https://cache/get?key=' + encodeURIComponent(key));
    const result = await resp.json();
    
    if (result.hit) {
      console.log('Cache HIT:', key);
      return result.data;
    }
    console.log('Cache MISS:', key);
    return null;
  } catch (error) {
    console.error('Cache get error:', error);
    return null;
  }
}

async function setCache(env, chatId, key, data, ttl) {
  try {
    const stub = await getCacheStub(env, chatId);
    await stub.fetch('https://cache/set?key=' + encodeURIComponent(key) + '&ttl=' + ttl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    console.log('Cache SET:', key, 'TTL:', ttl);
  } catch (error) {
    console.error('Cache set error:', error);
  }
}

async function clearCache(env, chatId, prefix) {
  try {
    const stub = await getCacheStub(env, chatId);
    await stub.fetch('https://cache/clear?prefix=' + encodeURIComponent(prefix || ''));
    console.log('Cache CLEAR:', prefix || 'all');
  } catch (error) {
    console.error('Cache clear error:', error);
  }
}

// ==================== Worker 入口 ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 路由处理
    if (url.pathname === '/set-webhook') {
      return handleSetWebhook(url, env);
    }
    if (url.pathname === '/delete-webhook') {
      return handleDeleteWebhook(url, env);
    }
    if (url.pathname === '/set-commands') {
      return handleSetCommands(url, env);
    }
    if (url.pathname === '/health') {
      return new Response('OK - v3.3 Optimized');
    }
    
    // Webhook 处理
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        console.log('Received update:', JSON.stringify(update).slice(0, 500));
        ctx.waitUntil(processUpdate(update, env));
        return new Response('OK');
      } catch (e) {
        console.error('Webhook error:', e);
        return new Response('Error', { status: 500 });
      }
    }
    
    return new Response('Qinglong Bot v3.3 Optimized');
  }
};

// ==================== Webhook 管理 ====================
async function handleSetWebhook(url, env) {
  if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  const webhookUrl = url.origin + '/webhook';
  const resp = await tgApi(env.TG_BOT_TOKEN, 'setWebhook', { 
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query']
  });
  return new Response(JSON.stringify({ webhookUrl, result: resp }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleDeleteWebhook(url, env) {
  if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  const resp = await tgApi(env.TG_BOT_TOKEN, 'deleteWebhook');
  return new Response(JSON.stringify(resp, null, 2));
}

async function handleSetCommands(url, env) {
  if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  const resp = await tgApi(env.TG_BOT_TOKEN, 'setMyCommands', { commands: BOT_COMMANDS });
  return new Response(JSON.stringify(resp, null, 2));
}

// ==================== Telegram API ====================
async function tgApi(token, method, body = {}) {
  const resp = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.json();
}

async function sendMsg(env, chatId, text, opts = {}) {
  return tgApi(env.TG_BOT_TOKEN, 'sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    ...opts
  });
}

async function editMsg(env, chatId, msgId, text, opts = {}) {
  return tgApi(env.TG_BOT_TOKEN, 'editMessageText', {
    chat_id: chatId,
    message_id: msgId,
    text: text,
    parse_mode: 'HTML',
    ...opts
  });
}

async function answerCb(env, cbId, text) {
  return tgApi(env.TG_BOT_TOKEN, 'answerCallbackQuery', {
    callback_query_id: cbId,
    text: text || ''
  });
}

// ==================== 青龙 API (优化版) ====================
async function getQlToken(env) {
  const now = Date.now();
  
  // 提前刷新策略
  if (qlTokenCache.token && qlTokenCache.expiry > now + TOKEN_REFRESH_BUFFER) {
    return qlTokenCache.token;
  }
  
  console.log('Refreshing QL token...');
  const start = Date.now();
  
  const url = env.QL_BASE_URL + '/open/auth/token?client_id=' + env.QL_CLIENT_ID + '&client_secret=' + env.QL_CLIENT_SECRET;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    console.log('Token fetch time:', Date.now() - start, 'ms');
    
    const data = await resp.json();
    
    if (data.code === 200) {
      qlTokenCache.token = data.data.token;
      // 提前2分钟过期
      qlTokenCache.expiry = now + (data.data.expiration * 1000) - 120000;
      console.log('Token cached until:', new Date(qlTokenCache.expiry).toISOString());
      return qlTokenCache.token;
    }
    throw new Error('获取青龙Token失败: ' + (data.message || JSON.stringify(data)));
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Token请求超时');
    }
    throw error;
  }
}

async function qlApi(env, method, endpoint, body) {
  const start = Date.now();
  const token = await getQlToken(env);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const opts = {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      signal: controller.signal
    };
    
    if (body !== undefined && body !== null) {
      opts.body = JSON.stringify(body);
    }
    
    const resp = await fetch(env.QL_BASE_URL + endpoint, opts);
    clearTimeout(timeoutId);
    
    console.log('API', method, endpoint, 'took', Date.now() - start, 'ms');
    
    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status);
    }
    
    return resp.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('请求超时(' + (REQUEST_TIMEOUT/1000) + 's)');
    }
    throw error;
  }
}

// 带缓存的 API 调用
async function qlApiCached(env, chatId, cacheKey, ttl, method, endpoint, body) {
  // 只缓存 GET 请求
  if (method !== 'GET') {
    // 修改操作清除相关缓存
    const prefix = cacheKey.split(':')[0];
    await clearCache(env, chatId, prefix);
    return qlApi(env, method, endpoint, body);
  }
  
  // 尝试从缓存获取
  const cached = await getFromCache(env, chatId, cacheKey);
  if (cached) {
    return cached;
  }
  
  // 缓存未命中,请求 API
  const result = await qlApi(env, method, endpoint, body);
  
  // 只缓存成功的结果
  if (result && result.code === 200) {
    await setCache(env, chatId, cacheKey, result, ttl);
  }
  
  return result;
}

// 安全获取数组
function toArray(result) {
  if (!result || result.code !== 200) return [];
  const d = result.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  return [];
}

// ==================== 权限检查 ====================
function isAuth(userId, env) {
  if (!env.ADMIN_USER_IDS) return true;
  const allowed = env.ADMIN_USER_IDS.split(',').map(function(s) { return s.trim(); });
  return allowed.includes(String(userId));
}

// ==================== 主处理流程 ====================
async function processUpdate(update, env) {
  try {
    let userId, chatId;
    
    if (update.callback_query) {
      userId = update.callback_query.from.id;
      chatId = update.callback_query.message.chat.id;
    } else if (update.message) {
      userId = update.message.from.id;
      chatId = update.message.chat.id;
    } else {
      console.log('Unknown update type');
      return;
    }
    
    // 权限检查
    if (!isAuth(userId, env)) {
      await sendMsg(env, chatId, '⛔ 未授权用户 ID: <code>' + userId + '</code>');
      return;
    }
    
    // 处理回调
    if (update.callback_query) {
      await handleCallback(update.callback_query, env);
      return;
    }
    
    // 处理消息
    if (update.message) {
      await handleMessage(update.message, env);
      return;
    }
  } catch (error) {
    console.error('Process error:', error);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      await sendMsg(env, chatId, '❌ 错误: ' + error.message);
    }
  }
}

// ==================== 消息处理 ====================
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();
  
  console.log('Message from ' + userId + ': ' + text);
  
  // 检查用户状态
  const state = userStates.get(userId);
  if (state) {
    await handleStateInput(msg, state, env);
    return;
  }
  
  // 处理文件
  if (msg.document) {
    await handleDocument(msg, env);
    return;
  }
  
  // 处理文件链接
  if (text && (text.includes('github.com') || text.includes('raw.githubusercontent.com') || text.includes('gitee.com') || text.match(/https?:\/\/.*\.(js|py|sh|ts)$/i))) {
    await handleFileUrl(msg, env);
    return;
  }
  
  // 处理键盘按钮
  if (text.indexOf('任务管理') >= 0) {
    return await cmdTasks(chatId, 0, env, null);
  }
  if (text.indexOf('环境变量') >= 0) {
    return await cmdEnvs(chatId, 0, env, null);
  }
  if (text.indexOf('订阅管理') >= 0) {
    return await cmdSubs(chatId, 0, env, null);
  }
  if (text.indexOf('依赖管理') >= 0) {
    return await cmdDeps(chatId, env, null);
  }
  if (text.indexOf('脚本管理') >= 0) {
    return await cmdScripts(chatId, '', 0, env, null);
  }
  if (text.indexOf('帮助') >= 0 && text.length < 10) {
    return await cmdHelp(chatId, env);
  }
  
  // 处理命令
  if (text.startsWith('/')) {
    const cmd = text.split(' ')[0].split('@')[0];
    switch (cmd) {
      case '/start':
        return await cmdStart(chatId, env);
      case '/help':
        return await cmdHelp(chatId, env);
      case '/tasks':
        return await cmdTasks(chatId, 0, env, null);
      case '/envs':
        return await cmdEnvs(chatId, 0, env, null);
      case '/subs':
        return await cmdSubs(chatId, 0, env, null);
      case '/deps':
        return await cmdDeps(chatId, env, null);
      case '/scripts':
        return await cmdScripts(chatId, '', 0, env, null);
      case '/cancel':
        userStates.delete(userId);
        return await sendMsg(env, chatId, '❌ 已取消');
      case '/clearcache':
        await clearCache(env, chatId, '');
        return await sendMsg(env, chatId, '✅ 缓存已清除');
    }
  }
  
  console.log('No handler matched for: ' + text);
}

// ==================== 命令处理 ====================
async function cmdStart(chatId, env) {
  const keyboard = {
    keyboard: [
      [{ text: '📋 任务管理' }, { text: '🔑 环境变量' }],
      [{ text: '📦 订阅管理' }, { text: '📚 依赖管理' }],
      [{ text: '📁 脚本管理' }, { text: '❓ 帮助' }]
    ],
    resize_keyboard: true,
    persistent: true
  };
  
  await sendMsg(env, chatId, 
    '🐉 <b>青龙面板 Bot v3.3</b>\n\n✨ 性能优化版\n• Token 智能缓存\n• 数据自动缓存\n• 并行请求加速\n\n请选择操作或使用命令\n\n💡 转发脚本文件即可自动添加',
    { reply_markup: keyboard }
  );
}

async function cmdHelp(chatId, env) {
  const text = '🐉 <b>青龙面板 Bot 帮助</b>\n\n' +
    '/tasks - 📋 任务管理\n' +
    '/envs - 🔑 环境变量\n' +
    '/subs - 📦 订阅管理\n' +
    '/deps - 📚 依赖管理\n' +
    '/scripts - 📁 脚本管理\n' +
    '/clearcache - 🗑️ 清除缓存\n\n' +
    '<b>📤 添加脚本方式：</b>\n' +
    '1. 直接转发 .js/.py/.sh/.ts 文件\n' +
    '2. 发送 GitHub/Gitee 文件链接\n' +
    '3. 发送脚本直链（以 .js 等结尾）\n\n' +
    '💡 自动转换 GitHub blob 链接为 raw 链接\n' +
    '⚡ 数据自动缓存，响应更快';
  await sendMsg(env, chatId, text);
}

// ==================== 任务管理 (优化版) ====================
async function cmdTasks(chatId, page, env, msgId) {
  const cacheKey = 'tasks:list';
  const result = await qlApiCached(env, chatId, cacheKey, CACHE_TTL.tasks, 'GET', '/open/crons', null);
  const crons = toArray(result);
  
  if (crons.length === 0) {
    const text = '📋 <b>任务管理</b>\n\n暂无任务';
    const kb = { inline_keyboard: [[{ text: '➕ 新建任务', callback_data: 'task_new' }]] };
    if (msgId) {
      return await editMsg(env, chatId, msgId, text, { reply_markup: kb });
    }
    return await sendMsg(env, chatId, text, { reply_markup: kb });
  }
  
  const pageSize = 8;
  const totalPages = Math.ceil(crons.length / pageSize);
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const items = crons.slice(p * pageSize, (p + 1) * pageSize);
  
  const running = crons.filter(function(c) { return c.isRunning; }).length;
  const enabled = crons.filter(function(c) { return !c.isDisabled; }).length;
  
  const keyboard = [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    let icon = c.isDisabled ? '🔕' : (c.isRunning ? '🏃' : '✅');
    let name = (c.name || '未命名').slice(0, 22);
    keyboard.push([{ text: icon + ' ' + name, callback_data: 'cron_' + c.id }]);
  }
  
  // 分页导航
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: 'tasks_' + (p - 1) });
  nav.push({ text: (p + 1) + '/' + totalPages, callback_data: 'noop' });
  if (p < totalPages - 1) nav.push({ text: '➡️', callback_data: 'tasks_' + (p + 1) });
  keyboard.push(nav);
  
  keyboard.push([
    { text: '🔄 刷新', callback_data: 'tasks_refresh_' + p },
    { text: '➕ 新建', callback_data: 'task_new' }
  ]);
  
  const text = '📋 <b>任务管理</b>\n\n共 ' + crons.length + ' 个 | ✅' + enabled + ' 🏃' + running + ' 🔕' + (crons.length - enabled);
  
  if (msgId) {
    return await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
  return await sendMsg(env, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showCron(chatId, msgId, cronId, env) {
  const cacheKey = 'tasks:detail:' + cronId;
  const result = await qlApiCached(env, chatId, cacheKey, CACHE_TTL.tasks, 'GET', '/open/crons/' + cronId, null);
  
  if (result.code !== 200 || !result.data) {
    return await editMsg(env, chatId, msgId, '❌ 任务不存在', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ 返回', callback_data: 'tasks_0' }]] }
    });
  }
  
  const c = result.data;
  const status = c.isDisabled ? '🔕 已禁用' : (c.isRunning ? '🏃 运行中' : '✅ 已启用');
  
  let text = '📋 <b>' + (c.name || '未命名') + '</b>\n\n';
  text += '状态: ' + status + '\n';
  text += '定时: <code>' + (c.schedule || '无') + '</code>\n';
  text += '命令: <code>' + (c.command || '无') + '</code>';
  
  const kb = [];
  
  if (c.isRunning) {
    kb.push([{ text: '⏹️ 停止运行', callback_data: 'cron_stop_' + cronId }]);
  } else {
    kb.push([{ text: '▶️ 运行任务', callback_data: 'cron_run_' + cronId }]);
  }
  
  const row2 = [];
  if (c.isDisabled) {
    row2.push({ text: '✅ 启用', callback_data: 'cron_en_' + cronId });
  } else {
    row2.push({ text: '🔕 禁用', callback_data: 'cron_dis_' + cronId });
  }
  row2.push({ text: '✏️ 编辑定时', callback_data: 'cron_edit_' + cronId });
  kb.push(row2);
  
  kb.push([
    { text: '📄 查看日志', callback_data: 'cron_log_' + cronId },
    { text: '🗑️ 删除', callback_data: 'cron_del_' + cronId }
  ]);
  
  kb.push([{ text: '⬅️ 返回列表', callback_data: 'tasks_0' }]);
  
  await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: kb } });
}

// ==================== 环境变量 (优化版) ====================
async function cmdEnvs(chatId, page, env, msgId) {
  const cacheKey = 'envs:list';
  const result = await qlApiCached(env, chatId, cacheKey, CACHE_TTL.envs, 'GET', '/open/envs', null);
  const envs = toArray(result);
  
  if (envs.length === 0) {
    const text = '🔑 <b>环境变量</b>\n\n暂无变量';
    const kb = { inline_keyboard: [[{ text: '➕ 添加变量', callback_data: 'env_add' }]] };
    if (msgId) return await editMsg(env, chatId, msgId, text, { reply_markup: kb });
    return await sendMsg(env, chatId, text, { reply_markup: kb });
  }
  
  const pageSize = 8;
  const totalPages = Math.ceil(envs.length / pageSize);
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const items = envs.slice(p * pageSize, (p + 1) * pageSize);
  
  const keyboard = [];
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    const icon = e.status === 0 ? '✅' : '🔕';
    const name = (e.name || '未命名').slice(0, 22);
    keyboard.push([{ text: icon + ' ' + name, callback_data: 'env_' + e.id }]);
  }
  
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: 'envs_' + (p - 1) });
  nav.push({ text: (p + 1) + '/' + totalPages, callback_data: 'noop' });
  if (p < totalPages - 1) nav.push({ text: '➡️', callback_data: 'envs_' + (p + 1) });
  keyboard.push(nav);
  
  keyboard.push([
    { text: '➕ 添加', callback_data: 'env_add' },
    { text: '🔄 刷新', callback_data: 'envs_refresh_' + p }
  ]);
  
  const text = '🔑 <b>环境变量</b>\n\n共 ' + envs.length + ' 个';
  
  if (msgId) return await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
  return await sendMsg(env, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showEnv(chatId, msgId, envId, env) {
  const cacheKey = 'envs:list';
  const result = await qlApiCached(env, chatId, cacheKey, CACHE_TTL.envs, 'GET', '/open/envs', null);
  const envs = toArray(result);
  const e = envs.find(function(x) { return String(x.id) === String(envId); });
  
  if (!e) {
    return await editMsg(env, chatId, msgId, '❌ 变量不存在', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ 返回', callback_data: 'envs_0' }]] }
    });
  }
  
  const status = e.status === 0 ? '✅ 已启用' : '🔕 已禁用';
  let text = '🔑 <b>' + e.name + '</b>\n\n';
  text += '状态: ' + status + '\n';
  text += '值: <code>' + (e.value || '') + '</code>';
  if (e.remarks) text += '\n备注: ' + e.remarks;
  
  const kb = [];
  if (e.status === 0) {
    kb.push([{ text: '🔕 禁用', callback_data: 'env_dis_' + envId }]);
  } else {
    kb.push([{ text: '✅ 启用', callback_data: 'env_en_' + envId }]);
  }
  kb.push([
    { text: '✏️ 编辑', callback_data: 'env_edit_' + envId },
    { text: '🗑️ 删除', callback_data: 'env_del_' + envId }
  ]);
  kb.push([{ text: '⬅️ 返回列表', callback_data: 'envs_0' }]);
  
  await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: kb } });
}

// ==================== 订阅管理 (优化版) ====================
async function cmdSubs(chatId, page, env, msgId) {
  const cacheKey = 'subs:list';
  const result = await qlApiCached(env, chatId, cacheKey, CACHE_TTL.subs, 'GET', '/open/subscriptions', null);
  const subs = toArray(result);
  
  if (subs.length === 0) {
    const text = '📦 <b>订阅管理</b>\n\n暂无订阅';
    const kb = { inline_keyboard: [[{ text: '➕ 添加订阅', callback_data: 'sub_add' }]] };
    if (msgId) return await editMsg(env, chatId, msgId, text, { reply_markup: kb });
    return await sendMsg(env, chatId, text, { reply_markup: kb });
  }
  
  const pageSize = 8;
  const totalPages = Math.ceil(subs.length / pageSize);
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const items = subs.slice(p * pageSize, (p + 1) * pageSize);
  
  const keyboard = [];
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const icon = s.is_disabled ? '🔕' : '✅';
    const name = (s.name || '未命名').slice(0, 22);
    keyboard.push([{ text: icon + ' ' + name, callback_data: 'sub_' + s.id }]);
  }
  
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: 'subs_' + (p - 1) });
  nav.push({ text: (p + 1) + '/' + totalPages, callback_data: 'noop' });
  if (p < totalPages - 1) nav.push({ text: '➡️', callback_data: 'subs_' + (p + 1) });
  keyboard.push(nav);
  
  keyboard.push([
    { text: '➕ 添加', callback_data: 'sub_add' },
    { text: '🔄 刷新', callback_data: 'subs_refresh_' + p }
  ]);
  
  const text = '📦 <b>订阅管理</b>\n\n共 ' + subs.length + ' 个';
  
  if (msgId) return await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
  return await sendMsg(env, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showSub(chatId, msgId, subId, env) {
  const cacheKey = 'subs:list';
  const result = await qlApiCached(env, chatId, cacheKey, CACHE_TTL.subs, 'GET', '/open/subscriptions', null);
  const subs = toArray(result);
  const s = subs.find(function(x) { return String(x.id) === String(subId); });
  
  if (!s) {
    return await editMsg(env, chatId, msgId, '❌ 订阅不存在', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ 返回', callback_data: 'subs_0' }]] }
    });
  }
  
  const status = s.is_disabled ? '🔕 已禁用' : '✅ 已启用';
  let text = '📦 <b>' + s.name + '</b>\n\n';
  text += '状态: ' + status + '\n';
  text += '定时: <code>' + (s.schedule || '无') + '</code>\n';
  text += 'URL: <code>' + (s.url || '') + '</code>';
  if (s.branch) text += '\n分支: ' + s.branch;
  
  const kb = [];
  kb.push([{ text: '▶️ 立即运行', callback_data: 'sub_run_' + subId }]);
  if (s.is_disabled) {
    kb.push([{ text: '✅ 启用', callback_data: 'sub_en_' + subId }]);
  } else {
    kb.push([{ text: '🔕 禁用', callback_data: 'sub_dis_' + subId }]);
  }
  kb.push([
    { text: '✏️ 编辑', callback_data: 'sub_edit_' + subId },
    { text: '🗑️ 删除', callback_data: 'sub_del_' + subId }
  ]);
  kb.push([{ text: '⬅️ 返回列表', callback_data: 'subs_0' }]);
  
  await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: kb } });
}

// ==================== 依赖管理 (优化版 - 并行请求) ====================
async function cmdDeps(chatId, env, msgId) {
  const cacheKeys = ['deps:python3', 'deps:nodejs', 'deps:linux'];
  
  // 并行请求三种类型的依赖
  const results = await Promise.allSettled([
    qlApiCached(env, chatId, cacheKeys[0], CACHE_TTL.deps, 'GET', '/open/dependencies?type=python3', null),
    qlApiCached(env, chatId, cacheKeys[1], CACHE_TTL.deps, 'GET', '/open/dependencies?type=nodejs', null),
    qlApiCached(env, chatId, cacheKeys[2], CACHE_TTL.deps, 'GET', '/open/dependencies?type=linux', null)
  ]);
  
  const pythonDeps = results[0].status === 'fulfilled' ? toArray(results[0].value) : [];
  const nodeDeps = results[1].status === 'fulfilled' ? toArray(results[1].value) : [];
  const linuxDeps = results[2].status === 'fulfilled' ? toArray(results[2].value) : [];
  
  const total = pythonDeps.length + nodeDeps.length + linuxDeps.length;
  
  const kb = [
    [{ text: '🐍 Python (' + pythonDeps.length + ')', callback_data: 'dep_list_python3' }],
    [{ text: '📦 Node.js (' + nodeDeps.length + ')', callback_data: 'dep_list_nodejs' }],
    [{ text: '🐧 Linux (' + linuxDeps.length + ')', callback_data: 'dep_list_linux' }],
    [{ text: '🔄 刷新', callback_data: 'deps_refresh' }]
  ];
  
  const text = '📚 <b>依赖管理</b>\n\n共 ' + total + ' 个依赖\n\n点击分类查看详情';
  
  if (msgId) return await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: kb } });
  return await sendMsg(env, chatId, text, { reply_markup: { inline_keyboard: kb } });
}

async function showDepList(chatId, msgId, type, page, env) {
  const cacheKey = 'deps:' + type;
  const result = await qlApiCached(env, chatId, cacheKey, CACHE_TTL.deps, 'GET', '/open/dependencies?type=' + type, null);
  const deps = toArray(result);
  
  const typeNames = {
    'python3': '🐍 Python',
    'nodejs': '📦 Node.js', 
    'linux': '🐧 Linux'
  };
  const typeName = typeNames[type] || type;
  
  if (deps.length === 0) {
    const kb = [
      [{ text: '➕ 添加依赖', callback_data: 'dep_add_' + type }],
      [{ text: '⬅️ 返回', callback_data: 'deps_main' }]
    ];
    return await editMsg(env, chatId, msgId, typeName + ' <b>依赖</b>\n\n暂无依赖', { reply_markup: { inline_keyboard: kb } });
  }
  
  const pageSize = 6;
  const totalPages = Math.ceil(deps.length / pageSize);
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const items = deps.slice(p * pageSize, (p + 1) * pageSize);
  
  const keyboard = [];
  for (let i = 0; i < items.length; i++) {
    const d = items[i];
    let icon = d.status === 0 ? '✅' : (d.status === 1 ? '⏳' : '❌');
    let name = (d.name || '未知').slice(0, 14);
    keyboard.push([
      { text: icon + ' ' + name, callback_data: 'noop' },
      { text: '🔄', callback_data: 'dep_reinstall_' + d.id + '_' + type },
      { text: '🗑️', callback_data: 'dep_del_' + d.id + '_' + type }
    ]);
  }
  
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: 'dep_page_' + type + '_' + (p - 1) });
  nav.push({ text: (p + 1) + '/' + totalPages, callback_data: 'noop' });
  if (p < totalPages - 1) nav.push({ text: '➡️', callback_data: 'dep_page_' + type + '_' + (p + 1) });
  keyboard.push(nav);
  
  keyboard.push([
    { text: '➕ 添加', callback_data: 'dep_add_' + type },
    { text: '🔄 刷新', callback_data: 'dep_refresh_' + type }
  ]);
  keyboard.push([{ text: '⬅️ 返回分类', callback_data: 'deps_main' }]);
  
  const text = typeName + ' <b>依赖</b>\n\n共 ' + deps.length + ' 个\n\n✅已安装 ⏳安装中 ❌失败';
  
  await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ==================== 脚本管理 (优化版) ====================
async function cmdScripts(chatId, folder, page, env, msgId) {
  console.log('cmdScripts called with folder: "' + folder + '", page: ' + page);
  
  try {
    const cacheKey = 'scripts:tree';
    const result = await qlApiCached(env, chatId, cacheKey, CACHE_TTL.scripts, 'GET', '/open/scripts', null);
    console.log('Scripts API result code: ' + result.code);
    
    if (result.code !== 200) {
      const text = '❌ 获取失败: ' + (result.message || '未知错误');
      if (msgId) return await editMsg(env, chatId, msgId, text);
      return await sendMsg(env, chatId, text);
    }
    
    const data = result.data || [];
    console.log('Scripts data length: ' + data.length);
    
    // 解析脚本树
    let folders = [];
    let files = [];
    
    if (!folder || folder === '') {
      // 根目录
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (item.children && item.children.length > 0) {
          folders.push(item.title);
        } else if (item.title) {
          files.push(item.title);
        }
      }
    } else {
      // 子目录
      const findNode = function(items, target) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.title === target) return item;
          if (item.children) {
            const found = findNode(item.children, target);
            if (found) return found;
          }
        }
        return null;
      };
      
      const node = findNode(data, folder);
      if (node && node.children) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          if (child.children && child.children.length > 0) {
            folders.push(child.title);
          } else if (child.title) {
            files.push(child.title);
          }
        }
      }
    }
    
    console.log('Folders: ' + folders.length + ', Files: ' + files.length);
    
    const keyboard = [];
    
    // 返回按钮
    if (folder && folder !== '') {
      keyboard.push([{ text: '⬅️ 返回根目录', callback_data: 'scripts_root_0' }]);
    }
    
    // 文件夹始终全部显示
    for (let i = 0; i < folders.length; i++) {
      const fname = folders[i];
      const cbData = 'sdir_' + encodeURIComponent(fname).slice(0, 50);
      keyboard.push([{ text: '📂 ' + fname.slice(0, 28), callback_data: cbData }]);
    }
    
    // 文件分页显示
    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
    const p = Math.min(Math.max(0, page || 0), totalPages - 1);
    const startIdx = p * pageSize;
    const pageFiles = files.slice(startIdx, startIdx + pageSize);
    
    for (let i = 0; i < pageFiles.length; i++) {
      const f = pageFiles[i];
      const displayName = f.length > 18 ? f.slice(0, 18) + '..' : f;
      const path = folder ? folder + '/' + f : f;
      const encodedPath = encodeURIComponent(path).slice(0, 40);
      keyboard.push([
        { text: '📄 ' + displayName, callback_data: 'noop' },
        { text: '▶️', callback_data: 'scrrun_' + encodedPath },
        { text: '🗑️', callback_data: 'scrdel_' + encodedPath }
      ]);
    }
    
    // 分页导航
    if (files.length > pageSize) {
      const nav = [];
      const folderParam = folder ? encodeURIComponent(folder).slice(0, 30) : '';
      if (p > 0) nav.push({ text: '⬅️ 上一页', callback_data: 'scrp_' + folderParam + '_' + (p - 1) });
      nav.push({ text: (p + 1) + '/' + totalPages, callback_data: 'noop' });
      if (p < totalPages - 1) nav.push({ text: '下一页 ➡️', callback_data: 'scrp_' + folderParam + '_' + (p + 1) });
      keyboard.push(nav);
    }
    
    // 刷新按钮
    const refreshCb = folder ? 'scr_refresh_' + encodeURIComponent(folder).slice(0, 40) : 'scr_refresh_root';
    keyboard.push([{ text: '🔄 刷新', callback_data: refreshCb }]);
    
    const title = folder || '根目录';
    const NL = String.fromCharCode(10);
    const msgText = '📁 <b>脚本管理 - ' + title + '</b>' + NL + NL + '📂 ' + folders.length + ' 文件夹 | 📄 ' + files.length + ' 文件' + NL + (files.length > pageSize ? '(第 ' + (p+1) + '/' + totalPages + ' 页)' : '') + NL + NL + '▶️ 添加到运行列表 | 🗑️ 删除';
    
    console.log('Sending scripts message, keyboard buttons: ' + keyboard.length);
    
    let sendResult;
    if (msgId) {
      sendResult = await editMsg(env, chatId, msgId, msgText, { reply_markup: { inline_keyboard: keyboard } });
    } else {
      sendResult = await sendMsg(env, chatId, msgText, { reply_markup: { inline_keyboard: keyboard } });
    }
    
    console.log('Send result ok: ' + sendResult.ok);
    if (!sendResult.ok) {
      console.log('Send error: ' + JSON.stringify(sendResult));
    }
    
    return sendResult;
  } catch (error) {
    console.log('cmdScripts error: ' + error.message);
    return await sendMsg(env, chatId, '❌ 脚本管理错误: ' + error.message);
  }
}

// ==================== 处理文件链接 ====================
async function handleFileUrl(msg, env) {
  const chatId = msg.chat.id;
  let url = (msg.text || '').trim();
  
  // 提取 URL（如果消息中包含其他文字）
  const urlMatch = url.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) {
    return await sendMsg(env, chatId, '❌ 无法识别链接');
  }
  url = urlMatch[0];
  
  // 转换 GitHub blob 链接为 raw 链接
  if (url.includes('github.com') && url.includes('/blob/')) {
    url = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
  }
  
  // 转换 Gitee blob 链接为 raw 链接
  if (url.includes('gitee.com') && url.includes('/blob/')) {
    url = url.replace('/blob/', '/raw/');
  }
  
  // 从 URL 中提取文件名
  const urlParts = url.split('/');
  let fileName = urlParts[urlParts.length - 1];
  
  // 移除查询参数
  if (fileName.includes('?')) {
    fileName = fileName.split('?')[0];
  }
  
  // 检查文件扩展名
  const validExts = ['.js', '.py', '.sh', '.ts'];
  const lastDot = fileName.lastIndexOf('.');
  const ext = lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : '';
  
  if (validExts.indexOf(ext) < 0) {
    return await sendMsg(env, chatId, '❌ 不支持的文件类型: ' + (ext || '无扩展名') + '\n\n支持: ' + validExts.join(', ') + '\n\n💡 请确保链接指向脚本文件');
  }
  
  await sendMsg(env, chatId, '⏳ 正在下载: ' + fileName + '\n\n<code>' + url.slice(0, 60) + (url.length > 60 ? '...' : '') + '</code>');
  
  try {
    // 下载文件内容
    const fileResp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!fileResp.ok) {
      throw new Error('下载失败: HTTP ' + fileResp.status);
    }
    
    const content = await fileResp.text();
    
    if (content.length > 1024 * 1024) {
      throw new Error('文件过大 (最大 1MB)');
    }
    
    if (content.length < 10) {
      throw new Error('文件内容为空或太小');
    }
    
    // 上传到青龙（清除脚本缓存）
    const uploadResult = await qlApiCached(env, chatId, 'no-cache', 0, 'POST', '/open/scripts', {
      filename: fileName,
      content: content,
      path: ''
    });
    
    if (uploadResult.code !== 200) {
      throw new Error(uploadResult.message || '上传失败');
    }
    
    const kb = { inline_keyboard: [[
      { text: '✅ 创建定时任务', callback_data: 'newcron_' + encodeURIComponent(fileName) },
      { text: '❌ 仅保存', callback_data: 'noop' }
    ]] };
    
    await sendMsg(env, chatId, '✅ <b>' + fileName + '</b> 上传成功！\n\n📁 大小: ' + (content.length / 1024).toFixed(1) + ' KB\n🔗 来源: ' + (url.includes('github') ? 'GitHub' : (url.includes('gitee') ? 'Gitee' : '直链')) + '\n\n是否创建定时任务？', { reply_markup: kb });
  } catch (error) {
    await sendMsg(env, chatId, '❌ 处理失败: ' + error.message);
  }
}

// ==================== 文件上传 ====================
async function handleDocument(msg, env) {
  const chatId = msg.chat.id;
  const doc = msg.document;
  const fileName = doc.file_name;
  
  const validExts = ['.js', '.py', '.sh', '.ts'];
  const lastDot = fileName.lastIndexOf('.');
  const ext = lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : '';
  
  if (validExts.indexOf(ext) < 0) {
    return await sendMsg(env, chatId, '❌ 不支持的文件类型 ' + ext + '\n\n支持: ' + validExts.join(', '));
  }
  
  if (doc.file_size > 1024 * 1024) {
    return await sendMsg(env, chatId, '❌ 文件过大 (最大 1MB)');
  }
  
  await sendMsg(env, chatId, '⏳ 正在上传: ' + fileName);
  
  try {
    const fileInfo = await tgApi(env.TG_BOT_TOKEN, 'getFile', { file_id: doc.file_id });
    if (!fileInfo.ok) throw new Error('获取文件信息失败');
    
    const fileUrl = 'https://api.telegram.org/file/bot' + env.TG_BOT_TOKEN + '/' + fileInfo.result.file_path;
    const fileResp = await fetch(fileUrl);
    const content = await fileResp.text();
    
    // 上传到青龙（清除脚本缓存）
    const uploadResult = await qlApiCached(env, chatId, 'no-cache', 0, 'POST', '/open/scripts', {
      filename: fileName,
      content: content,
      path: ''
    });
    
    if (uploadResult.code !== 200) {
      throw new Error(uploadResult.message || '上传失败');
    }
    
    const kb = { inline_keyboard: [[
      { text: '✅ 创建定时任务', callback_data: 'newcron_' + encodeURIComponent(fileName) },
      { text: '❌ 仅保存', callback_data: 'noop' }
    ]] };
    
    await sendMsg(env, chatId, '✅ <b>' + fileName + '</b> 上传成功！\n\n是否创建定时任务？', { reply_markup: kb });
  } catch (error) {
    await sendMsg(env, chatId, '❌ 上传失败: ' + error.message);
  }
}

// ==================== 回调处理 (优化版) ====================
async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const userId = cb.from.id;
  const data = cb.data;
  
  console.log('Callback data: ' + data);
  
  // 立即响应，显示处理状态
  await answerCb(env, cb.id, '⏳ 处理中...');
  
  if (data === 'noop') return;
  
  // ===== 刷新操作 - 清除缓存 =====
  if (data.startsWith('tasks_refresh_')) {
    await clearCache(env, chatId, 'tasks');
    const page = parseInt(data.slice(14)) || 0;
    return await cmdTasks(chatId, page, env, msgId);
  }
  
  if (data.startsWith('envs_refresh_')) {
    await clearCache(env, chatId, 'envs');
    const page = parseInt(data.slice(13)) || 0;
    return await cmdEnvs(chatId, page, env, msgId);
  }
  
  if (data.startsWith('subs_refresh_')) {
    await clearCache(env, chatId, 'subs');
    const page = parseInt(data.slice(13)) || 0;
    return await cmdSubs(chatId, page, env, msgId);
  }
  
  if (data === 'deps_refresh') {
    await clearCache(env, chatId, 'deps');
    return await cmdDeps(chatId, env, msgId);
  }
  
  if (data.startsWith('dep_refresh_')) {
    const type = data.slice(12);
    await clearCache(env, chatId, 'deps:' + type);
    return await showDepList(chatId, msgId, type, 0, env);
  }
  
  if (data.startsWith('scr_refresh_')) {
    await clearCache(env, chatId, 'scripts');
    const folderPart = data.slice(12);
    const folder = folderPart === 'root' ? '' : decodeURIComponent(folderPart);
    return await cmdScripts(chatId, folder, 0, env, msgId);
  }
  
  // ===== 任务相关 =====
  if (data.startsWith('tasks_')) {
    const page = parseInt(data.slice(6)) || 0;
    return await cmdTasks(chatId, page, env, msgId);
  }
  
  if (data.startsWith('cron_run_')) {
    const id = data.slice(9);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/crons/run', [parseInt(id)]);
    await clearCache(env, chatId, 'tasks');
    return await showCron(chatId, msgId, id, env);
  }
  
  if (data.startsWith('cron_stop_')) {
    const id = data.slice(10);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/crons/stop', [parseInt(id)]);
    await clearCache(env, chatId, 'tasks');
    return await showCron(chatId, msgId, id, env);
  }
  
  if (data.startsWith('cron_en_')) {
    const id = data.slice(8);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/crons/enable', [parseInt(id)]);
    await clearCache(env, chatId, 'tasks');
    return await showCron(chatId, msgId, id, env);
  }
  
  if (data.startsWith('cron_dis_')) {
    const id = data.slice(9);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/crons/disable', [parseInt(id)]);
    await clearCache(env, chatId, 'tasks');
    return await showCron(chatId, msgId, id, env);
  }
  
  if (data.startsWith('cron_del_')) {
    const id = data.slice(9);
    await qlApiCached(env, chatId, 'no-cache', 0, 'DELETE', '/open/crons', [parseInt(id)]);
    await clearCache(env, chatId, 'tasks');
    return await cmdTasks(chatId, 0, env, msgId);
  }
  
  if (data.startsWith('cron_edit_')) {
    const id = data.slice(10);
    userStates.set(userId, { action: 'edit_cron', cronId: id, chatId: chatId, msgId: msgId });
    return await editMsg(env, chatId, msgId, 
      '✏️ <b>编辑定时</b>\n\n请输入新的 cron 表达式\n例: <code>0 8 * * *</code>\n\n/cancel 取消',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'tasks_0' }]] } }
    );
  }
  
  if (data.startsWith('cron_log_')) {
    const id = data.slice(9);
    const cronRes = await qlApiCached(env, chatId, 'tasks:detail:' + id, CACHE_TTL.tasks, 'GET', '/open/crons/' + id, null);
    const logRes = await qlApi(env, 'GET', '/open/crons/' + id + '/log', null);
    
    let logContent = logRes.code === 200 ? (logRes.data || '暂无日志') : '获取日志失败';
    if (logContent.length > 3000) {
      logContent = '...(已截取)\n' + logContent.slice(-3000);
    }
    
    const name = cronRes.data?.name || '任务';
    const text = '📄 <b>' + name + '</b> 日志\n\n<pre>' + escapeHtml(logContent) + '</pre>';
    
    const kb = [[
      { text: '🔄 刷新', callback_data: 'cron_log_' + id },
      { text: '⬅️ 返回', callback_data: 'cron_' + id }
    ]];
    
    return await editMsg(env, chatId, msgId, text, { reply_markup: { inline_keyboard: kb } });
  }
  
  if (data === 'task_new') {
    userStates.set(userId, { action: 'new_cron', chatId: chatId, msgId: msgId });
    return await editMsg(env, chatId, msgId,
      '➕ <b>新建任务</b>\n\n格式: <code>名称|命令|定时</code>\n例: <code>测试|task test.js|0 8 * * *</code>\n\n/cancel 取消',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'tasks_0' }]] } }
    );
  }
  
  if (data.startsWith('cron_')) {
    const id = data.slice(5);
    return await showCron(chatId, msgId, id, env);
  }
  
  if (data.startsWith('newcron_')) {
    const fileName = decodeURIComponent(data.slice(8));
    userStates.set(userId, { action: 'create_cron', fileName: fileName, chatId: chatId, msgId: msgId });
    return await sendMsg(env, chatId,
      '⏰ 为 <b>' + fileName + '</b> 设置定时\n\n输入 cron 表达式\n或输入 <code>default</code> 使用默认(每天0点)\n\n/cancel 取消'
    );
  }
  
  // ===== 环境变量相关 =====
  if (data.startsWith('envs_')) {
    const page = parseInt(data.slice(5)) || 0;
    return await cmdEnvs(chatId, page, env, msgId);
  }
  
  if (data.startsWith('env_en_')) {
    const id = data.slice(7);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/envs/enable', [parseInt(id)]);
    await clearCache(env, chatId, 'envs');
    return await showEnv(chatId, msgId, id, env);
  }
  
  if (data.startsWith('env_dis_')) {
    const id = data.slice(8);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/envs/disable', [parseInt(id)]);
    await clearCache(env, chatId, 'envs');
    return await showEnv(chatId, msgId, id, env);
  }
  
  if (data.startsWith('env_del_')) {
    const id = data.slice(8);
    await qlApiCached(env, chatId, 'no-cache', 0, 'DELETE', '/open/envs', [parseInt(id)]);
    await clearCache(env, chatId, 'envs');
    return await cmdEnvs(chatId, 0, env, msgId);
  }
  
  if (data === 'env_add') {
    userStates.set(userId, { action: 'add_env', chatId: chatId, msgId: msgId });
    return await editMsg(env, chatId, msgId,
      '➕ <b>添加变量</b>\n\n格式: <code>名称=值</code>\n\n/cancel 取消',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'envs_0' }]] } }
    );
  }
  
  if (data.startsWith('env_edit_')) {
    const id = data.slice(9);
    userStates.set(userId, { action: 'edit_env', envId: id, chatId: chatId, msgId: msgId });
    return await editMsg(env, chatId, msgId,
      '✏️ <b>编辑变量</b>\n\n格式: <code>名称=值</code>\n\n/cancel 取消',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'env_' + id }]] } }
    );
  }
  
  if (data.startsWith('env_')) {
    const id = data.slice(4);
    return await showEnv(chatId, msgId, id, env);
  }
  
  // ===== 订阅相关 =====
  if (data.startsWith('subs_')) {
    const page = parseInt(data.slice(5)) || 0;
    return await cmdSubs(chatId, page, env, msgId);
  }
  
  if (data.startsWith('sub_run_')) {
    const id = data.slice(8);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/subscriptions/run', [parseInt(id)]);
    await clearCache(env, chatId, 'subs');
    return await showSub(chatId, msgId, id, env);
  }
  
  if (data.startsWith('sub_en_')) {
    const id = data.slice(7);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/subscriptions/enable', [parseInt(id)]);
    await clearCache(env, chatId, 'subs');
    return await showSub(chatId, msgId, id, env);
  }
  
  if (data.startsWith('sub_dis_')) {
    const id = data.slice(8);
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/subscriptions/disable', [parseInt(id)]);
    await clearCache(env, chatId, 'subs');
    return await showSub(chatId, msgId, id, env);
  }
  
  if (data.startsWith('sub_del_')) {
    const id = data.slice(8);
    await qlApiCached(env, chatId, 'no-cache', 0, 'DELETE', '/open/subscriptions', [parseInt(id)]);
    await clearCache(env, chatId, 'subs');
    return await cmdSubs(chatId, 0, env, msgId);
  }
  
  if (data === 'sub_add') {
    userStates.set(userId, { action: 'add_sub', chatId: chatId, msgId: msgId });
    return await editMsg(env, chatId, msgId,
      '➕ <b>添加订阅</b>\n\n格式: <code>名称|URL|定时|分支</code>\n例: <code>Repo|https://github.com/x/y|0 0 * * *|main</code>\n\n/cancel 取消',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'subs_0' }]] } }
    );
  }
  
  if (data.startsWith('sub_edit_')) {
    const id = data.slice(9);
    userStates.set(userId, { action: 'edit_sub', subId: id, chatId: chatId, msgId: msgId });
    return await editMsg(env, chatId, msgId,
      '✏️ <b>编辑订阅</b>\n\n格式: <code>名称|URL|定时|分支</code>\n留空保持不变: <code>||0 8 * * *|</code>\n\n/cancel 取消',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'sub_' + id }]] } }
    );
  }
  
  if (data.startsWith('sub_')) {
    const id = data.slice(4);
    return await showSub(chatId, msgId, id, env);
  }
  
  // ===== 依赖相关 =====
  if (data === 'deps_main') {
    return await cmdDeps(chatId, env, msgId);
  }
  
  if (data.startsWith('dep_list_')) {
    const type = data.slice(9);
    return await showDepList(chatId, msgId, type, 0, env);
  }
  
  if (data.startsWith('dep_page_')) {
    const rest = data.slice(9);
    const parts = rest.split('_');
    const type = parts[0];
    const page = parseInt(parts[1]) || 0;
    return await showDepList(chatId, msgId, type, page, env);
  }
  
  if (data.startsWith('dep_reinstall_')) {
    const rest = data.slice(14);
    const parts = rest.split('_');
    const id = parts[0];
    const type = parts[1];
    await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/dependencies/reinstall', [parseInt(id)]);
    await clearCache(env, chatId, 'deps:' + type);
    return await showDepList(chatId, msgId, type, 0, env);
  }
  
  if (data.startsWith('dep_del_')) {
    const rest = data.slice(8);
    const parts = rest.split('_');
    const id = parts[0];
    const type = parts[1];
    await qlApiCached(env, chatId, 'no-cache', 0, 'DELETE', '/open/dependencies', [parseInt(id)]);
    await clearCache(env, chatId, 'deps:' + type);
    return await showDepList(chatId, msgId, type, 0, env);
  }
  
  if (data.startsWith('dep_add_')) {
    const type = data.slice(8);
    userStates.set(userId, { action: 'add_dep', type: type, chatId: chatId, msgId: msgId });
    const typeNames = { 'python3': 'Python', 'nodejs': 'Node.js', 'linux': 'Linux' };
    return await editMsg(env, chatId, msgId,
      '➕ <b>添加 ' + (typeNames[type] || type) + ' 依赖</b>\n\n输入依赖名（多个用空格分隔）\n\n/cancel 取消',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'dep_list_' + type }]] } }
    );
  }
  
  // ===== 脚本相关 =====
  if (data.startsWith('scripts_root_')) {
    const page = parseInt(data.slice(13)) || 0;
    return await cmdScripts(chatId, '', page, env, msgId);
  }
  
  if (data.startsWith('sdir_')) {
    const folder = decodeURIComponent(data.slice(5));
    return await cmdScripts(chatId, folder, 0, env, msgId);
  }
  
  if (data.startsWith('scrp_')) {
    const rest = data.slice(5);
    const lastUnderscore = rest.lastIndexOf('_');
    const folderEncoded = rest.slice(0, lastUnderscore);
    const page = parseInt(rest.slice(lastUnderscore + 1)) || 0;
    const folder = folderEncoded ? decodeURIComponent(folderEncoded) : '';
    return await cmdScripts(chatId, folder, page, env, msgId);
  }
  
  if (data.startsWith('scrrun_')) {
    const path = decodeURIComponent(data.slice(7));
    const lastSlash = path.lastIndexOf('/');
    const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    
    userStates.set(userId, { action: 'add_script_cron', filename: filename, path: path, chatId: chatId, msgId: msgId });
    return await editMsg(env, chatId, msgId,
      '⏰ <b>添加到运行列表</b>\n\n脚本: <code>' + filename + '</code>\n\n请输入 cron 表达式\n例: <code>0 8 * * *</code> (每天8点)\n或输入 <code>d</code> 使用默认(每天0点)\n\n/cancel 取消',
      { reply_markup: { inline_keyboard: [[{ text: '❌ 取消', callback_data: 'scripts_root_0' }]] } }
    );
  }
  
  if (data.startsWith('scrdel_')) {
    const path = decodeURIComponent(data.slice(7));
    const lastSlash = path.lastIndexOf('/');
    const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '';
    
    await qlApiCached(env, chatId, 'no-cache', 0, 'DELETE', '/open/scripts', { filename: filename, path: dir });
    await clearCache(env, chatId, 'scripts');
    return await cmdScripts(chatId, dir, 0, env, msgId);
  }
  
  console.log('Unhandled callback: ' + data);
}

// HTML 转义
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ==================== 状态输入处理 (优化版) ====================
async function handleStateInput(msg, state, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();
  const msgId = state.msgId;
  
  if (text === '/cancel') {
    userStates.delete(userId);
    return await sendMsg(env, chatId, '❌ 已取消');
  }
  
  try {
    if (state.action === 'edit_cron') {
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/crons', {
        id: parseInt(state.cronId),
        schedule: text
      });
      userStates.delete(userId);
      await clearCache(env, chatId, 'tasks');
      if (result.code === 200) {
        await sendMsg(env, chatId, '✅ 定时已更新为: <code>' + text + '</code>');
        return await showCron(chatId, msgId, state.cronId, env);
      }
      return await sendMsg(env, chatId, '❌ 更新失败: ' + (result.message || '未知错误'));
    }
    
    if (state.action === 'create_cron') {
      const schedule = text.toLowerCase() === 'default' ? '0 0 * * *' : text;
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'POST', '/open/crons', {
        name: state.fileName,
        command: 'task ' + state.fileName,
        schedule: schedule
      });
      userStates.delete(userId);
      await clearCache(env, chatId, 'tasks');
      if (result.code === 200) {
        return await sendMsg(env, chatId, '✅ <b>任务已创建</b>\n\n名称: <code>' + state.fileName + '</code>\n定时: <code>' + schedule + '</code>');
      }
      return await sendMsg(env, chatId, '❌ 创建失败: ' + (result.message || '未知错误'));
    }
    
    if (state.action === 'new_cron') {
      const parts = text.split('|');
      if (parts.length < 3) {
        return await sendMsg(env, chatId, '❌ 格式错误，请使用: 名称|命令|定时');
      }
      const name = parts[0].trim();
      const command = parts[1].trim();
      const schedule = parts[2].trim();
      
      if (!name || !command || !schedule) {
        return await sendMsg(env, chatId, '❌ 名称、命令和定时都不能为空');
      }
      
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'POST', '/open/crons', {
        name: name,
        command: command,
        schedule: schedule
      });
      userStates.delete(userId);
      await clearCache(env, chatId, 'tasks');
      if (result.code === 200) {
        await sendMsg(env, chatId, '✅ <b>任务创建成功</b>\n\n名称: <code>' + name + '</code>\n命令: <code>' + command + '</code>\n定时: <code>' + schedule + '</code>');
        return await cmdTasks(chatId, 0, env, null);
      }
      return await sendMsg(env, chatId, '❌ 创建失败: ' + (result.message || '未知错误'));
    }
    
    if (state.action === 'add_env') {
      const eqIndex = text.indexOf('=');
      if (eqIndex < 0) {
        return await sendMsg(env, chatId, '❌ 格式错误，请使用: 名称=值');
      }
      const name = text.slice(0, eqIndex).trim();
      const value = text.slice(eqIndex + 1).trim();
      
      if (!name || !value) {
        return await sendMsg(env, chatId, '❌ 名称或值不能为空');
      }
      
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'POST', '/open/envs', [{ name: name, value: value }]);
      userStates.delete(userId);
      await clearCache(env, chatId, 'envs');
      
      if (result.code === 200) {
        await sendMsg(env, chatId, '✅ <b>环境变量添加成功</b>\n\n名称: <code>' + name + '</code>\n值: <code>' + value + '</code>');
        return await cmdEnvs(chatId, 0, env, null);
      }
      return await sendMsg(env, chatId, '❌ 添加失败: ' + (result.message || '未知错误'));
    }
    
    if (state.action === 'edit_env') {
      const eqIndex = text.indexOf('=');
      if (eqIndex < 0) {
        return await sendMsg(env, chatId, '❌ 格式错误，请使用: 名称=值');
      }
      const name = text.slice(0, eqIndex).trim();
      const value = text.slice(eqIndex + 1).trim();
      
      if (!name || !value) {
        return await sendMsg(env, chatId, '❌ 名称或值不能为空');
      }
      
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/envs', {
        id: parseInt(state.envId),
        name: name,
        value: value
      });
      userStates.delete(userId);
      await clearCache(env, chatId, 'envs');
      if (result.code === 200) {
        await sendMsg(env, chatId, '✅ <b>环境变量更新成功</b>\n\n名称: <code>' + name + '</code>\n值: <code>' + value + '</code>');
        return await showEnv(chatId, msgId, state.envId, env);
      }
      return await sendMsg(env, chatId, '❌ 更新失败: ' + (result.message || '未知错误'));
    }
    
    if (state.action === 'add_sub') {
      const parts = text.split('|');
      if (parts.length < 2) {
        return await sendMsg(env, chatId, '❌ 格式错误，请使用: 名称|URL|定时|分支');
      }
      const name = parts[0].trim();
      const url = parts[1].trim();
      const schedule = parts[2] ? parts[2].trim() : '0 0 * * *';
      const branch = parts[3] ? parts[3].trim() : '';
      
      if (!name || !url) {
        return await sendMsg(env, chatId, '❌ 名称和URL不能为空');
      }
      
      const body = { name: name, url: url, schedule: schedule, type: 'public-repo' };
      if (branch) body.branch = branch;
      
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'POST', '/open/subscriptions', body);
      userStates.delete(userId);
      await clearCache(env, chatId, 'subs');
      if (result.code === 200) {
        await sendMsg(env, chatId, '✅ <b>订阅添加成功</b>\n\n名称: <code>' + name + '</code>\n定时: <code>' + schedule + '</code>');
        return await cmdSubs(chatId, 0, env, null);
      }
      return await sendMsg(env, chatId, '❌ 添加失败: ' + (result.message || '未知错误'));
    }
    
    if (state.action === 'edit_sub') {
      const subRes = await qlApiCached(env, chatId, 'subs:list', CACHE_TTL.subs, 'GET', '/open/subscriptions', null);
      const subs = toArray(subRes);
      const sub = subs.find(function(s) { return String(s.id) === String(state.subId); });
      
      if (!sub) {
        userStates.delete(userId);
        return await sendMsg(env, chatId, '❌ 订阅不存在');
      }
      
      const parts = text.split('|');
      const updateData = Object.assign({}, sub);
      if (parts[0] && parts[0].trim()) updateData.name = parts[0].trim();
      if (parts[1] && parts[1].trim()) updateData.url = parts[1].trim();
      if (parts[2] && parts[2].trim()) updateData.schedule = parts[2].trim();
      if (parts[3] && parts[3].trim()) updateData.branch = parts[3].trim();
      
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'PUT', '/open/subscriptions', updateData);
      userStates.delete(userId);
      await clearCache(env, chatId, 'subs');
      if (result.code === 200) {
        await sendMsg(env, chatId, '✅ <b>订阅更新成功</b>');
        return await showSub(chatId, msgId, state.subId, env);
      }
      return await sendMsg(env, chatId, '❌ 更新失败: ' + (result.message || '未知错误'));
    }
    
    if (state.action === 'add_dep') {
      const depNames = text.split(/\s+/);
      const typeMap = { 'python3': 0, 'nodejs': 1, 'linux': 2 };
      const typeNum = typeMap[state.type];
      if (typeNum === undefined) {
        userStates.delete(userId);
        return await sendMsg(env, chatId, '❌ 未知的依赖类型');
      }
      
      const body = [];
      for (let i = 0; i < depNames.length; i++) {
        const n = depNames[i].trim();
        if (n) body.push({ name: n, type: typeNum });
      }
      
      if (body.length === 0) {
        return await sendMsg(env, chatId, '❌ 请输入至少一个依赖名称');
      }
      
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'POST', '/open/dependencies', body);
      userStates.delete(userId);
      await clearCache(env, chatId, 'deps:' + state.type);
      if (result.code === 200) {
        await sendMsg(env, chatId, '✅ <b>依赖添加成功</b>\n\n已添加 ' + body.length + ' 个依赖');
        return await showDepList(chatId, msgId, state.type, 0, env);
      }
      return await sendMsg(env, chatId, '❌ 添加失败: ' + (result.message || '未知错误'));
    }
    
    if (state.action === 'add_script_cron') {
      const schedule = (text.toLowerCase() === 'd' || text.toLowerCase() === 'default') ? '0 0 * * *' : text;
      const result = await qlApiCached(env, chatId, 'no-cache', 0, 'POST', '/open/crons', {
        name: state.filename,
        command: 'task ' + state.path,
        schedule: schedule
      });
      userStates.delete(userId);
      await clearCache(env, chatId, 'tasks');
      if (result.code === 200) {
        await sendMsg(env, chatId, '✅ <b>已添加到运行列表</b>\n\n脚本: <code>' + state.filename + '</code>\n定时: <code>' + schedule + '</code>');
        return await cmdScripts(chatId, '', 0, env, null);
      }
      return await sendMsg(env, chatId, '❌ 添加失败: ' + (result.message || '未知错误'));
    }
    
  } catch (error) {
    userStates.delete(userId);
    return await sendMsg(env, chatId, '❌ 错误: ' + error.message);
  }
}