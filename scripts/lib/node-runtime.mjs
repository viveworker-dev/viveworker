import process from "node:process";

// Oldest release on each supported Node.js line that ships the October 2026
// security fixes (https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
// Enforced at runtime only: do NOT mirror this into package.json "engines".
// npm then resolves a bare `npx viveworker` on an unpatched Node.js to the
// newest *engine-compatible* release, i.e. an older version without this gate.
export const PATCHED_NODE_RELEASES = Object.freeze(["22.23.4", "24.22.1", "26.12.1"]);
export const RECOMMENDED_NODE_RELEASE = "24.22.1";
export const NODE_SECURITY_ADVISORY_URL =
  "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases";

export function parseNodeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareNodeVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

export function otherPatchedNodeReleases(except = RECOMMENDED_NODE_RELEASE) {
  return PATCHED_NODE_RELEASES.filter((release) => release !== except).map((release) => `v${release}+`).join(" / ");
}

// reason: "" when supported, "unpatched" for an older release on a supported
// line, "unsupported-line" for EOL / odd lines, "unknown" when unparseable.
// Same semantics as semver: a prerelease of the minimum (24.22.1-rc.1) sorts
// before it and is not patched yet.
export function assessNodeRuntime(version = process.versions.node) {
  const parsed = parseNodeVersion(version);
  const isPrerelease = /^v?\d+\.\d+\.\d+-/u.test(String(version || "").trim());
  const base = {
    version: String(version || "").replace(/^v/u, ""),
    recommended: RECOMMENDED_NODE_RELEASE,
    advisoryUrl: NODE_SECURITY_ADVISORY_URL,
  };
  if (!parsed) {
    return { ...base, supported: false, reason: "unknown", minimum: RECOMMENDED_NODE_RELEASE };
  }
  const releases = PATCHED_NODE_RELEASES.map(parseNodeVersion);
  const sameLine = releases.find((release) => release[0] === parsed[0]);
  if (sameLine) {
    const minimum = sameLine.join(".");
    const comparison = compareNodeVersions(parsed, sameLine);
    return comparison > 0 || (comparison === 0 && !isPrerelease)
      ? { ...base, supported: true, reason: "", minimum }
      : { ...base, supported: false, reason: "unpatched", minimum };
  }
  if (parsed[0] > releases.at(-1)[0]) {
    return { ...base, supported: true, reason: "", minimum: "" };
  }
  return { ...base, supported: false, reason: "unsupported-line", minimum: RECOMMENDED_NODE_RELEASE };
}

export function describeNodeRuntimeProblem(runtime) {
  if (runtime.supported) {
    return "";
  }
  if (runtime.reason === "unpatched") {
    return `Node.js v${runtime.version} is missing the October 2026 security fixes. Upgrade to v${runtime.minimum} or later (recommended: v${runtime.recommended}). See ${runtime.advisoryUrl}`;
  }
  return `Node.js v${runtime.version || "unknown"} is end-of-life or not a supported release line and will not get the October 2026 security fixes. Install Node.js v${runtime.recommended} (or ${otherPatchedNodeReleases(runtime.recommended)}). See ${runtime.advisoryUrl}`;
}
