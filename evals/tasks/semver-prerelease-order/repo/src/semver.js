/** Compares two SemVer 2.0.0 versions. Returns -1, 0 or 1. Build metadata (+...) is ignored. */
export function compareVersions(a, b) {
  const [coreA, preA] = a.split("+")[0].split("-");
  const [coreB, preB] = b.split("+")[0].split("-");
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (partsA[i] !== partsB[i]) return partsA[i] < partsB[i] ? -1 : 1;
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}
