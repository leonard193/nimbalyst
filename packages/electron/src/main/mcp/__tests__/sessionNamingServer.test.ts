// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildSessionMetaToolSchemas,
  dispatchSessionMetaTool,
  setGetSessionTitleFn,
  setUpdateSessionTitleFn,
} from "../sessionNamingServer";

describe("buildSessionMetaToolSchemas", () => {
  it("keeps the eager schema byte-stable across sessions and tag mutations", async () => {
    const before = await buildSessionMetaToolSchemas("session-before-tags");
    const after = await buildSessionMetaToolSchemas("session-after-tags");

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    const addDescription = before[0].inputSchema.properties.add.description;
    expect(addDescription).toBe(
      "Tags to add: lowercase hyphen-separated type of work (bug-fix, feature, refactor) and area/module (electron, runtime, ios). Reuse existing workspace tags when known."
    );
    expect(addDescription).not.toMatch(/\(\d+\)/);
  });
});

describe("update_session_meta name", () => {
  // A session named from its tracker card (or by the user) keeps that name;
  // the tool reports it instead of claiming a rename.
  it("reports an unchanged name when the session name follows its card", async () => {
    const title = "LEO-20 · Keep card-linked chat names correct automatically — Implementation";
    setGetSessionTitleFn(async () => title);
    setUpdateSessionTitleFn(async () => false);

    const result = await dispatchSessionMetaTool("update_session_meta", { name: "Card naming work" }, "s1");

    const { summary } = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(false);
    expect(summary).toContain("Name unchanged");
    expect(summary).not.toContain("Set name");
  });

  it("reports the new name when the write is applied", async () => {
    setGetSessionTitleFn(async () => "Card naming work");
    setUpdateSessionTitleFn(async () => true);

    const result = await dispatchSessionMetaTool("update_session_meta", { name: "Card naming work" }, "s1");

    expect(JSON.parse(result.content[0].text).summary).toContain('Set name: "Card naming work"');
  });
});
