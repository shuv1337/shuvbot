import { describe, expect, test } from "bun:test";
import { isCommentableLine, mapDiffPositions, parseUnifiedDiff } from "../src/diff.ts";

describe("diff parser", () => {
  test("maps added, deleted, and context lines", () => {
    const hunks = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;`);
    const positions = mapDiffPositions(hunks);

    expect(isCommentableLine(positions, "src/a.ts", 2, "RIGHT")).toMatchObject({ position: 3 });
    expect(isCommentableLine(positions, "src/a.ts", 2, "LEFT")).toMatchObject({ position: 2 });
    expect(isCommentableLine(positions, "src/a.ts", 99, "RIGHT")).toBeUndefined();
  });
});
