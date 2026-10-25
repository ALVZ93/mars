/** Compares two SemVer 2.0.0 versions. Returns -1, 0 or 1. Build metadata (+...) is ignored. */
export function compareVersions(a, b) {
  const parse = version => {
    const withoutBuild = version.split("+")[0];
    const dash = withoutBuild.indexOf("-");
    const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
    const pre = dash === -1 ? [] : withoutBuild.slice(dash + 1).split(".");
    return { core: core.split(".").map(Number), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  const numeric = id => /^\d+$/.test(id);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (numeric(p) && numeric(q)) return Number(p) < Number(q) ? -1 : 1;
    if (numeric(p)) return -1;
    if (numeric(q)) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
