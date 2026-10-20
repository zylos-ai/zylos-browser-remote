#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { fetchDetail, parseDetailArgs } from "./detail-diagnostics.js";

export function incidentReport(result) {
  if (!result.ok) return result;
  const bundle = JSON.parse(result.text);
  const capture = bundle.schemaVersion === 2 ? bundle.capture : bundle;
  return { ...result, report: { source: { extensionVersion: capture.extensionVersion, build: capture.build,
    runtimeEpoch: capture.runtimeEpoch, captureId: capture.captureId },
    incidents: bundle.incidents || [], correlations: bundle.correlations || [],
    rejectedEventCounts: Object.fromEntries(["task-mismatch", "oversized", "malformed"].map(reason =>
      [reason, (result.remoteEvidence?.records || []).filter(record => record.kind === "rejected" && record.reason === reason).length])),
    complete: false, cause: "undetermined", gaps: [
      "Local capture is partial; missing records cannot establish absence of an event.",
      "Action completion, queue delivery, and transport receipt are distinct facts.",
      "Extension and Remote clocks are not aligned; cross-clock event order is unverified.",
      ...(result.remoteEvidence?.gaps || []),
      ...(result.remoteEvidenceGap ? [result.remoteEvidenceGap] : []),
      ...(bundle.schemaVersion === 2 ? bundle.limitations : []),
      ...(bundle.schemaVersion === 1 ? ["Legacy capture has no incident correlations."] : []),
      ...(!result.remoteEvidence ? ["No Remote companion evidence was available."] : []),
    ] } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = incidentReport(await fetchDetail(parseDetailArgs(process.argv.slice(2))));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error("Usage: incident-report.js <exact-endpointId>");
    process.exitCode = 1;
  }
}
