// Build claims identify an artifact; they do not attest to its authenticity.
export function buildIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["id", "commit", "dirty", "builtAt"].includes(key)) ||
      typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
      (value.commit !== undefined && (typeof value.commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.commit))) ||
      (value.dirty !== undefined && typeof value.dirty !== "boolean") ||
      (value.builtAt !== undefined && (typeof value.builtAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.builtAt) ||
        !Number.isFinite(Date.parse(value.builtAt)) || new Date(value.builtAt).toISOString() !== value.builtAt))) return null;
  return { id: value.id, ...(value.commit !== undefined ? { commit: value.commit } : {}),
    ...(value.dirty !== undefined ? { dirty: value.dirty } : {}),
    ...(value.builtAt !== undefined ? { builtAt: value.builtAt } : {}) };
}
