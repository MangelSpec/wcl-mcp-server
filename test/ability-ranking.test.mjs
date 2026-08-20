import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateAbilityDamageEvents,
  buildAbilityRankings,
  mapWithConcurrency,
} from "../dist/tools/rankDamageTakenByAbility.js";

test("bounds ability event concurrency and preserves result order", async () => {
  let active = 0;
  let maximumActive = 0;
  const values = Array.from({ length: 12 }, (_, index) => index);

  const results = await mapWithConcurrency(values, 4, async (value) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });

  assert.equal(maximumActive, 4);
  assert.deepEqual(
    results,
    values.map((value) => value * 2),
  );
});

test("withholds per-ability hit shares when any event stream is truncated", () => {
  const ability = { gameID: 42, name: "Test Quill" };
  const players = aggregateAbilityDamageEvents(
    [
      {
        ability,
        events: [{ amount: 100, targetID: 1, timestamp: 1_000 }],
        fightID: 1,
        truncated: true,
      },
    ],
    {
      actorName: () => "Player",
      actorType: () => "Warrior",
    },
  );

  const [ranking] = buildAbilityRankings(players, [ability], "truncated");
  assert.equal(ranking.rankings[0].hitSharePercent, null);
});
