'use strict';

const $ = id => document.getElementById(id);
const states = { queuing: '正在投递', waiting: '等待下一步', running: '正在执行', uncertain: '投递待确认', delivery_failed: '投递失败', reply_pending: '等待回复送达', delivered: '已结束', interrupted: '服务重启 · 已中断' };
const stepStates = { success: '完成', returned: '已返回', running: '执行中', error: '失败', unknown: '待确认', waiting: '等待确认' };
const agentMethods = { exec_command: '执行命令', write_stdin: '继续或读取进程', view_image: '查看图片', apply_patch: '修改文件', tool_search: '查找可用工具', web_search: '搜索网页', 'functions.exec': '执行工具脚本', 'functions.wait': '等待工具返回', Read: '读取文件', Bash: '执行命令', Edit: '编辑文件', Write: '写入文件', Glob: '查找文件', Grep: '搜索文本' };
let runs = [], revision = '', selected = null, follow = true, connected = false, filter = 'all';
const expanded = new Map();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function time(value, full = false) { return new Date(value).toLocaleString('zh-CN', { ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', ...(full ? { second: '2-digit' } : {}), hour12: false }); }
function duration(ms) { if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`; if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`; return `${Math.floor(ms / 60000)} 分 ${Math.floor(ms % 60000 / 1000)} 秒`; }
function tone(status) { return status === 'delivered' ? 'success' : ['delivery_failed', 'interrupted'].includes(status) ? 'error' : status === 'running' ? 'running' : 'waiting'; }

function renderList() {
  $('run-count').textContent = runs.length;
  $('runs').replaceChildren();
  if (!runs.length) $('runs').append(el('p', 'blank-list', '还没有记录'));
  for (const run of runs) {
    const button = el('button', `run-card${run.id === selected ? ' selected' : ''}`);
    button.type = 'button'; button.setAttribute('aria-current', run.id === selected ? 'true' : 'false');
    button.append(el('div', 'run-card-title', run.question));
    const meta = el('div', 'run-card-meta');
    meta.append(el('span', '', time(run.startedAt)), el('span', `badge ${tone(run.status)}`, states[run.status] || run.status));
    button.append(meta);
    button.addEventListener('click', () => { selected = run.id; follow = run.id === runs[0]?.id; render(); });
    $('runs').append(button);
  }
}

function addDetail(parent, label, value) {
  if (value === undefined || value === null || value === '') return;
  parent.append(el('span', 'detail-label', label));
  let display = value;
  try { display = JSON.stringify(JSON.parse(value), null, 2); } catch { /* human-readable result */ }
  parent.append(el('pre', '', display));
}

function toolCounts(run, group) {
  if (run.toolCounts?.[group]) return run.toolCounts[group];
  const names = new Map();
  for (const step of run.steps) if (step.kind === (group === 'browser' ? 'command' : 'agent')) names.set(step.title, (names.get(step.title) || 0) + 1);
  return [...names].map(([name, count]) => ({ name, count }));
}

function renderTools(run, group) {
  const counts = [...toolCounts(run, group)].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  $(`${group}-total`).textContent = `${total} 次 · ${counts.length} 种`;
  const box = $(`${group}-tools`); box.replaceChildren();
  if (!counts.length) {
    box.append(el('p', 'tool-empty', group === 'agent' ? run.agentObserved ? 'Agent 已收到问题，尚未捕获工具调用。' : '尚未捕获关联到本轮的 Agent 工具。' : '本轮尚未调用浏览器工具。'));
    return total;
  }
  const table = el('table', 'tool-table'); table.setAttribute('aria-label', group === 'browser' ? '浏览器工具调用分布' : 'Agent 工具调用分布');
  const head = el('thead'), tr = el('tr');
  for (const name of ['工具', '占本类调用', '次数']) { const th = el('th', '', name); th.scope = 'col'; tr.append(th); }
  head.append(tr); table.append(head);
  const body = el('tbody');
  for (const item of counts) {
    const row = el('tr'), label = el('td'), bar = el('td'), count = el('td', 'tool-count', item.count);
    label.append(el('code', '', item.name));
    const description = (group === 'browser' ? {} : agentMethods)[item.name];
    if (description) label.append(el('span', 'tool-description', description));
    const meter = el('meter'); meter.min = 0; meter.max = total; meter.value = item.count; meter.setAttribute('aria-label', `${item.name}：${item.count} / ${total} 次`);
    bar.append(meter); row.append(label, bar, count); body.append(row);
  }
  table.append(body); box.append(table); return total;
}

function render() {
  if (follow || !runs.some(run => run.id === selected)) selected = runs[0]?.id || null;
  renderList();
  const run = runs.find(item => item.id === selected);
  $('empty').hidden = !!run; $('run-view').hidden = !run;
  if (!run) return;
  $('question').textContent = run.question;
  $('run-time').textContent = `${time(run.startedAt, true)} · ${run.label}`;
  $('run-status').textContent = states[run.status] || run.status;
  $('commands').textContent = renderTools(run, 'browser');
  $('agent-commands').textContent = renderTools(run, 'agent');
  $('errors').textContent = run.steps.filter(step => step.status === 'error').length;
  const failures = run.steps.filter(step => step.status === 'error');
  const browserFailures = failures.filter(step => step.kind === 'command').length;
  const agentFailures = failures.filter(step => step.kind === 'agent').length;
  $('error-note').textContent = `当前保留步骤中：浏览器失败 ${browserFailures} 条 · Agent 工具失败 ${agentFailures} 条 · 消息与状态失败 ${failures.length - browserFailures - agentFailures} 条。同一次浏览器失败可能同时产生 Agent 命令失败，两层未去重，合计不代表独立故障数。`;
  $('follow').setAttribute('aria-pressed', String(follow));
  let note = run.status === 'delivered' ? '插件已确认保存最终回复，本轮已结束。任务是否达成请查看回复内容。' : '等待期间会持续计时；工具返回后自动显示结果。';
  if (run.messages > 1) note += ` 本轮包含 ${run.messages} 条连续提问；当前协议无法逐条关联工具调用，因此合并展示。`;
  if (run.omittedSteps) note += ` 更早的 ${run.omittedSteps} 个步骤已省略。`;
  if (run.agentMixed) note += ' Agent 同一轮混入了其他来源的消息；无法明确归属的后续调用未分配到此问题。';
  $('run-note').textContent = note;
  const timeline = $('timeline'); timeline.replaceChildren();
  for (const button of $('filters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  for (const [index, step] of [...run.steps].sort((a, b) => a.startedAt - b.startedAt).entries()) {
    const category = ['command', 'agent'].includes(step.kind) ? step.kind : 'message';
    if (filter !== 'all' && filter !== category) continue;
    const li = el('li', `step ${step.status}`);
    li.append(el('span', 'step-icon', { success: '✓', returned: '✓', running: '•', error: '!', unknown: '?', waiting: '·' }[step.status] || '·'));
    const details = el('details'); details.open = expanded.has(step.id) ? expanded.get(step.id) : ['question', 'final'].includes(step.kind);
    details.addEventListener('toggle', () => { if (details.isConnected) expanded.set(step.id, details.open); });
    const summary = el('summary');
    const description = (step.kind === 'agent' ? agentMethods : {})[step.title];
    const title = description ? `${description} · ${step.title}` : step.title;
    summary.append(el('span', 'step-number', String(index + 1 + run.omittedSteps).padStart(2, '0')),
      el('span', `source-label ${category}`, { command: '浏览器', agent: 'Agent', message: '消息' }[category]), el('span', 'step-title', title));
    const timing = el('span', 'step-timing', step.durationMs !== undefined ? duration(step.durationMs) : time(step.startedAt));
    if (step.status === 'running') timing.dataset.startedAt = step.startedAt;
    summary.append(timing, el('span', `badge ${step.status}`, stepStates[step.status] || step.status));
    const content = el('div', 'step-content');
    content.append(el('p', 'muted', `开始于 ${time(step.startedAt, true)}${step.endedAt ? ` · 返回于 ${time(step.endedAt, true)}` : ''}`));
    if (step.text) content.append(el('p', '', step.text));
    if (step.error) content.append(el('p', '', `错误：${step.error}`));
    addDetail(content, '参数摘要', step.params);
    addDetail(content, '随消息附带的上下文', step.context);
    if (step.invocation) {
      let args;
      try { args = JSON.parse(step.invocation.json); } catch { /* older diagnostic format */ }
      if (typeof args?.cmd === 'string') addDetail(content, '执行命令 · cmd', args.cmd);
      addDetail(content, step.kind === 'agent-input' ? 'Agent 收到的消息文本' : '传给执行工具的参数 · JSON', typeof args === 'string' ? args : step.invocation.json);
      const notes = [];
      if (step.invocation.redacted) notes.push('识别到的凭证或图片编码已隐藏');
      if (step.invocation.truncated) notes.push(`参数过长，部分内容已截断（原始 ${step.invocation.originalBytes} 字节）`);
      if (step.kind === 'agent') notes.push('这些参数由 Agent 发给执行工具');
      if (notes.length) content.append(el('p', 'muted', notes.join('；') + '。'));
    } else if (step.kind === 'agent' && /(?:^|\.)exec_command$/.test(step.title)) {
      content.append(el('p', 'muted', '此旧记录只有摘要；若当前扫描的日志中能找到对应调用，会自动补充参数。'));
    }
    addDetail(content, '返回摘要', step.result);
    if (!content.children.length) content.append(el('p', 'muted', step.status === 'running' ? '请求已发出，等待返回。' : '此步骤没有附加内容。'));
    details.append(summary, content); li.append(details); timeline.append(li);
  }
  if (!timeline.children.length) timeline.append(el('li', 'tool-empty', '此类型暂无步骤。'));
  tick();
}

function tick() {
  const run = runs.find(item => item.id === selected);
  if (run) $('duration').textContent = duration((run.endedAt || Date.now()) - run.startedAt);
  if (connected) for (const node of document.querySelectorAll('[data-started-at]')) node.textContent = duration(Date.now() - Number(node.dataset.startedAt));
}

async function refresh() {
  try {
    const response = await fetch(`/monitor/api?revision=${encodeURIComponent(revision)}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json(); connected = true;
    const count = Object.keys(data.connections).length;
    $('connection').textContent = count ? `${count} 个浏览器已连接` : '服务在线 · 等待浏览器';
    $('connection').classList.toggle('offline', !count);
    const connections = $('connection-details'); connections.replaceChildren();
    for (const [id, item] of Object.entries(data.connections)) {
      connections.append(el('p', '', `${item.label || id} · 协议 ${item.version || '未上报'} · 连入于 ${time(item.since, true)} · 上报能力 ${item.capabilities?.length || 0} 项`));
    }
    if (!count) connections.append(el('p', '', '当前没有浏览器连接。'));
    $('updated').textContent = `更新于 ${time(data.now, true)}`;
    $('agent-source').textContent = data.agentSource?.message || 'Agent 工具采集未启用';
    $('agent-source').classList.toggle('source-warning', data.agentSource?.status !== 'connected');
    $('warning').hidden = !data.storageError; $('warning').textContent = data.storageError || '';
    if (!data.unchanged) { runs = data.runs; revision = data.revision; render(); }
  } catch {
    connected = false; $('connection').textContent = '监控连接中断'; $('connection').classList.add('offline');
    $('updated').textContent = '正在自动重连';
    $('warning').hidden = false; $('warning').textContent = '暂时无法连接本地 Relay。页面保留最后一次记录，恢复连接后自动更新。';
  } finally { setTimeout(refresh, 1000); }
}
$('follow').addEventListener('click', () => { follow = !follow; render(); });
for (const button of $('filters').querySelectorAll('button')) button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
render(); refresh(); setInterval(tick, 1000);
