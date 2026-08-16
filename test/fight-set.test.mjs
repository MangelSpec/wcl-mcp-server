import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFightSetQuery,
  normalizeFightSetTable,
} from "../dist/tools/analyzeFightSet.js";
import { presentFight } from "../dist/tools/getFights.js";

test("builds one query containing only requested fight-set views", () => {
  const query = buildFightSetQuery(["deaths", "interrupts"]);

  assert.match(query, /\$fightIDs: \[Int!\]!/);
  assert.match(query, /view_deaths: table\(/);
  assert.match(query, /dataType: Deaths/);
  assert.match(query, /view_interrupts: table\(/);
  assert.match(query, /dataType: Interrupts/);
  assert.doesNotMatch(query, /dataType: DamageDone/);
});

test("normalizes aggregate row timestamps against their source fight", () => {
  const fights = new Map([
    [
      11,
      {
        id: 11,
        startTime: 100_000,
        endTime: 130_000,
      },
    ],
    [
      12,
      {
        id: 12,
        startTime: 200_000,
        endTime: 240_000,
      },
    ],
  ]);
  const normalized = normalizeFightSetTable(
    {
      data: {
        entries: [
          { deathTime: 112_500, fight: 11, name: "Alpha" },
          { deathTime: 207_000, fight: 12, name: "Beta" },
        ],
      },
    },
    fights,
  );

  assert.deepEqual(normalized.data.entries, [
    {
      deathTime: 12_500,
      fightRelativeDeathTime: 12_500,
      reportRelativeDeathTime: 112_500,
      fight: 11,
      name: "Alpha",
    },
    {
      deathTime: 7_000,
      fightRelativeDeathTime: 7_000,
      reportRelativeDeathTime: 207_000,
      fight: 12,
      name: "Beta",
    },
  ]);
});

test("presents phase transitions in fight-relative time", () => {
  const fight = presentFight({
    id: 11,
    startTime: 100_000,
    endTime: 130_000,
    phaseTransitions: [{ id: 2, startTime: 112_500 }],
  });

  assert.deepEqual(fight.phaseTransitions, [
    {
      fightRelativeStartTime: 12_500,
      id: 2,
      reportRelativeStartTime: 112_500,
      startTime: 12_500,
    },
  ]);
});
