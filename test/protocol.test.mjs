import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const serverEntry = path.resolve("dist/index.js");

async function connect(mode) {
  const client = new Client(
    { name: `wcl-test-${mode}`, version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(
    new StdioClientTransport({
      args: [serverEntry],
      command: process.execPath,
      env: { ...process.env },
      stderr: "pipe",
    }),
    { timeout: 10_000 },
  );
  return client;
}

for (const mode of ["auto", "legacy"]) {
  test(`lists all schema-backed tools for ${mode} clients`, async () => {
    const client = await connect(mode);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 13);
      assert.ok(tools.every((tool) => tool.outputSchema?.type === "object"));
      const playerSummary = tools.find(
        (tool) => tool.name === "wcl_get_player_fight_summary",
      );
      assert.equal(
        playerSummary?.inputSchema.properties.includeRankings.default,
        true,
      );
      const fightSet = tools.find(
        (tool) => tool.name === "wcl_analyze_fight_set",
      );
      assert.equal(fightSet?.inputSchema.properties.fightIDs.maxItems, 50);
      assert.equal(fightSet?.inputSchema.properties.views.maxItems, 4);
      const rawGraphql = tools.find((tool) => tool.name === "wcl_graphql");
      assert.equal(rawGraphql?.annotations, undefined);
      for (const tool of tools.filter((tool) => tool.name !== "wcl_graphql")) {
        assert.deepEqual(
          tool.annotations,
          { destructiveHint: false, readOnlyHint: true },
          tool.name,
        );
      }
      for (const name of [
        "wcl_get_table",
        "wcl_get_events",
        "wcl_get_fight_context",
        "wcl_get_fight_overview",
        "wcl_rank_damage_taken_by_ability",
      ]) {
        const tool = tools.find((candidate) => candidate.name === name);
        assert.equal(tool?.inputSchema.properties.refresh.default, false, name);
      }
      assert.equal(
        client.getProtocolEra(),
        mode === "auto" ? "modern" : "legacy",
      );
    } finally {
      await client.close();
    }
  });
}

test("returns structured errors without dropping legacy text", async () => {
  const client = await connect("auto");
  try {
    const result = await client.callTool({
      arguments: {},
      name: "wcl_get_fights",
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      error: 'Argument "reportCode" must be a non-empty string',
    });
    assert.match(result.content[0]?.text ?? "", /^Error:/);
  } finally {
    await client.close();
  }
});

test("preserves non-model-visible result metadata through the pinned protocol stack", async () => {
  const server = new Server(
    { name: "meta-test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/call", async () => ({
    _meta: {
      "raidlens/cache": {
        events: [{ operation: "context", outcome: "hit", source: "wcl" }],
      },
    },
    content: [{ type: "text", text: "ok" }],
  }));
  const client = new Client(
    { name: "meta-test-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    const result = await client.callTool({ arguments: {}, name: "meta" });
    assert.deepEqual(result._meta?.["raidlens/cache"], {
      events: [{ operation: "context", outcome: "hit", source: "wcl" }],
    });
    assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
