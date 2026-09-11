/*
 * Task sessions: which tab we drive, and the tab group that shows the owner
 * what we are doing.
 *
 * This module replaces the arm gate. The owner asked for "if a tab is already
 * on that site use it, otherwise open one, and don't make me authorize it" --
 * so the question "may we drive this?" is no longer "did you arm it?" but
 * "does the guard allow this URL?". guard.js and policy.js are unchanged and
 * still run on every command; this file only decides WHICH tab.
 *
 * Two constraints shape it:
 *  1. Module scope does not survive an MV3 worker recycle, so the active task
 *     lives in chrome.storage.local and every call re-reads it.
 *  2. Tab groups are the owner's UI, not ours. We only ever group tabs WE
 *     opened -- moving a tab he already had would reshuffle his tab strip --
 *     and we never close a tab, only ungroup ones we finished with.
 */

import { screen } from './guard.js';
import { tabAttachAllowed } from './policy.js';

// Chrome's named group colours. The owner picked the mapping.
const STATE_STYLE = {
  working: { color: 'green', title: 'Zylos · 工作中' },
  waiting: { color: 'yellow', title: 'Zylos · 等待你' },
  stopped: { color: 'grey', title: 'Zylos · 已停止' },
};

export const TASK_STATES = Object.keys(STATE_STYLE);

// Marks a group as ours. clearFinished() will only ever touch groups whose
// title starts with this, so a group the owner made by hand is never disturbed.
const GROUP_PREFIX = 'Zylos · ';

async function getTask() {
  const t = await chrome.storage.local.get(['taskTabId', 'taskGroupId', 'taskState']);
  return {
    tabId: t.taskTabId ?? null,
    groupId: t.taskGroupId ?? null,
    state: t.taskState ?? 'idle',
  };
}

async function setTask(patch) {
  const cur = await getTask();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({
    taskTabId: next.tabId,
    taskGroupId: next.groupId,
    taskState: next.state,
  });
  return next;
}

/**
 * Origin of a URL, or '' if it is not absolute/parseable.
 *
 * Host equality is deliberately origin-based rather than host-based: driving
 * an http:// tab when the agent asked for https:// is not "the same site".
 */
function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** www. is the one alias worth ignoring; anything cleverer starts guessing. */
function sameSite(a, b) {
  const strip = (o) => o.replace('://www.', '://');
  return Boolean(a) && strip(a) === strip(b);
}

/**
 * Find a tab already showing `url`'s site, preferring the one the owner is
 * looking at. Returns null when nothing matches.
 */
async function findExistingTab(targetOrigin) {
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((t) => sameSite(originOf(t.url || ''), targetOrigin));
  if (!matches.length) return null;
  // The tab he is actually looking at wins; otherwise the most recently used.
  const active = matches.find((t) => t.active);
  if (active) return active;
  return matches.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

/**
 * Resolve (or create) the tab for `url` and make it the active task.
 *
 * Refuses BEFORE opening anything: a blocklisted URL must not even become a
 * tab, or we would have navigated the owner's browser to a checkout page and
 * only then declined to click on it.
 */
export async function openTarget({ url } = {}) {
  if (typeof url !== 'string' || !url) throw new Error('_br.openTarget requires a url');

  const refusal = screen({ method: '_br.openTarget', params: { url }, tabUrl: url });
  if (refusal) throw new Error(refusal);
  const schemeRefusal = tabAttachAllowed(url);
  if (schemeRefusal) throw new Error(schemeRefusal);

  const targetOrigin = originOf(url);
  if (!targetOrigin) throw new Error(`_br.openTarget: not an absolute http(s) URL: ${url.slice(0, 80)}`);

  const existing = await findExistingTab(targetOrigin);
  let tab;
  let reused;
  let groupId = null;

  if (existing) {
    // His tab, his layout: use it where it sits, do not group or move it.
    tab = existing;
    reused = true;
    await chrome.tabs.update(tab.id, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* window gone */ }
  } else {
    tab = await chrome.tabs.create({ url, active: true });
    reused = false;
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { ...STATE_STYLE.working, collapsed: false });
  }

  await setTask({ tabId: tab.id, groupId, state: 'working' });
  const fresh = await chrome.tabs.get(tab.id);
  return { tabId: fresh.id, url: fresh.url, title: fresh.title, reused, groupId };
}

/**
 * Move the task between working/waiting/stopped, recolouring the group.
 *
 * The group is best-effort: if the owner ungrouped or closed it we keep the
 * state (the side panel still shows it) rather than failing the call.
 */
export async function setState({ state } = {}) {
  if (!TASK_STATES.includes(state)) {
    throw new Error(`_br.setState: state must be one of ${TASK_STATES.join('/')}`);
  }
  const task = await getTask();
  if (task.groupId != null) {
    try {
      await chrome.tabGroups.update(task.groupId, STATE_STYLE[state]);
    } catch {
      await setTask({ groupId: null });
    }
  }
  await setTask({ state });
  return { state, groupId: task.groupId };
}

/**
 * End the task: the caller detaches CDP, we grey the group and forget the tab.
 *
 * The tab and the group stay on screen deliberately -- the owner asked to
 * decide himself when they go away.
 */
export async function endTask() {
  const task = await getTask();
  if (task.groupId != null) {
    try { await chrome.tabGroups.update(task.groupId, STATE_STYLE.stopped); } catch { /* gone */ }
  }
  await setTask({ tabId: null, state: 'stopped' });
  return { stopped: true, groupId: task.groupId, tabId: task.tabId };
}

/**
 * Ungroup our finished groups. Never closes a tab, never touches a group the
 * owner made himself, never touches one still working or waiting.
 */
export async function clearFinished() {
  if (!chrome.tabGroups?.query) return { cleared: 0 };
  const groups = await chrome.tabGroups.query({});
  const finished = groups.filter(
    (g) => typeof g.title === 'string' &&
      g.title.startsWith(GROUP_PREFIX) &&
      g.title === STATE_STYLE.stopped.title
  );

  let cleared = 0;
  for (const g of finished) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const ids = tabs.map((t) => t.id);
    if (!ids.length) continue;
    try {
      await chrome.tabs.ungroup(ids);
      cleared += 1;
    } catch { /* the owner closed it first; nothing to do */ }
  }

  const task = await getTask();
  if (task.groupId != null && finished.some((g) => g.id === task.groupId)) {
    await setTask({ groupId: null });
  }
  return { cleared };
}

/**
 * The tab a page command should drive: the active task tab, re-read fresh.
 *
 * Returns null (not an error) when there is no task, so the caller can give
 * the agent a message that says what to do about it.
 */
export async function currentTaskTab() {
  const task = await getTask();
  if (task.tabId == null) return null;
  try {
    return await chrome.tabs.get(task.tabId);
  } catch {
    await setTask({ tabId: null, state: 'stopped' });
    return null;
  }
}

export { getTask };
