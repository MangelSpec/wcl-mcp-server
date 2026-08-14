const REPORT_TIME_KEYS = new Set([
  "deathTime",
  "endTime",
  "startTime",
  "timestamp",
]);

function relativeKey(key: string): string {
  return `fightRelative${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`;
}

function reportRelativeKey(key: string): string {
  return `reportRelative${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`;
}

/** Make in-fight time fields safe by default while preserving WCL's raw value. */
export function addFightRelativeTimes(
  value: unknown,
  fightStartTime: number,
  fightEndTime: number,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      addFightRelativeTimes(item, fightStartTime, fightEndTime),
    );
  }
  if (typeof value !== "object" || value === null) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (
      REPORT_TIME_KEYS.has(key) &&
      typeof fieldValue === "number" &&
      fieldValue >= fightStartTime &&
      fieldValue <= fightEndTime
    ) {
      const fightRelativeTime = fieldValue - fightStartTime;
      normalized[key] = fightRelativeTime;
      normalized[relativeKey(key)] = fightRelativeTime;
      normalized[reportRelativeKey(key)] = fieldValue;
      continue;
    }
    normalized[key] = addFightRelativeTimes(
      fieldValue,
      fightStartTime,
      fightEndTime,
    );
  }
  return normalized;
}
