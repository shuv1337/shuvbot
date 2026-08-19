import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("dashboard migration creates the complete read model", async () => {
  const sql = await readFile(join(import.meta.dir, "../migrations/0001_initial.sql"), "utf8");
  const db = new Database(":memory:");
  try {
    db.exec(sql);
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all()
      .map(({ name }) => name);
    expect(tables).toEqual([
      "artifact_references",
      "findings",
      "repositories",
      "session_summaries",
      "subjects",
      "workflow_runs"
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
