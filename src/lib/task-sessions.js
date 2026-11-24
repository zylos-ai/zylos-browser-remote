// Which Core session group owns each browser task (multi-session Core).
// In memory only: after a relay restart, tasks fall back to the browser
// connection's own group. Bounded so a long-lived relay cannot grow it.
const GROUP_RE = /^[a-z][a-z0-9_-]{0,31}(?::[A-Za-z0-9][A-Za-z0-9_.:-]{0,94})?$|^origin$/;
const LIMIT = 256;

function validFullGroup(value) {
  return typeof value === "string" && value.length <= 128 && GROUP_RE.test(value);
}

class TaskSessions {
  constructor({ limit = LIMIT } = {}) {
    this.limit = limit;
    this.tasks = new Map();
  }
  key(endpointId, taskId) {
    return `${endpointId}\n${taskId}`;
  }
  get(endpointId, taskId) {
    return taskId ? this.tasks.get(this.key(endpointId, taskId)) : undefined;
  }
  /**
   * origin "agent": started by scripts/task-start.js from a Core session.
   * origin "extension": started in the browser; owned by the browser's group.
   * An agent record is never replaced by an extension record for the same task.
   */
  record(endpointId, taskId, { origin, group }) {
    if (!taskId || !validFullGroup(group)) return undefined;
    const key = this.key(endpointId, taskId);
    const previous = this.tasks.get(key);
    if (previous?.origin === "agent" && origin !== "agent") return previous;
    const entry = { origin, group, notified: previous?.notified || new Set() };
    this.tasks.delete(key);
    this.tasks.set(key, entry);
    while (this.tasks.size > this.limit) this.tasks.delete(this.tasks.keys().next().value);
    return entry;
  }
  /** True the first time `id` is marked for this task: dedupes C4 notices. */
  firstNotice(endpointId, taskId, id) {
    let entry = this.get(endpointId, taskId);
    if (!entry) {
      entry = { origin: "unknown", group: null, notified: new Set() };
      this.tasks.set(this.key(endpointId, taskId), entry);
      while (this.tasks.size > this.limit) this.tasks.delete(this.tasks.keys().next().value);
    }
    if (entry.notified.has(id)) return false;
    entry.notified.add(id);
    if (entry.notified.size > 64) entry.notified.delete(entry.notified.values().next().value);
    return true;
  }
}

export { TaskSessions, validFullGroup };
