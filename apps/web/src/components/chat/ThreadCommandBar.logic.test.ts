import { assert, describe, it, vi } from "vitest";
import {
  dedupeThreadCommandBarItems,
  filterThreadCommandBarGroups,
  rankThreadCommandBarItem,
  type ThreadCommandBarItem,
} from "./ThreadCommandBar.logic";

function item(input: Partial<ThreadCommandBarItem> & Pick<ThreadCommandBarItem, "id" | "title">) {
  return {
    group: "actions",
    searchTerms: [],
    icon: null,
    run: vi.fn(),
    ...input,
  } satisfies ThreadCommandBarItem;
}

describe("ThreadCommandBar.logic", () => {
  it("ranks title matches before description matches", () => {
    const titleMatch = item({ id: "title", title: "Push branch", description: "Git action" });
    const descriptionMatch = item({
      id: "description",
      title: "Sync branch",
      description: "Push branch to upstream",
    });

    assert.isAbove(
      rankThreadCommandBarItem(titleMatch, "push"),
      rankThreadCommandBarItem(descriptionMatch, "push"),
    );
  });

  it("filters groups in command bar order", () => {
    const groups = filterThreadCommandBarGroups({
      query: "open",
      items: [
        item({ id: "git:push", group: "git", title: "Push", searchTerms: ["sync"] }),
        item({ id: "open-in:vscode", group: "open-in", title: "Open in VS Code" }),
        item({ id: "script:test", group: "actions", title: "Test", searchTerms: ["open test"] }),
      ],
    });

    assert.deepEqual(
      groups.map((group) => group.id),
      ["actions", "open-in"],
    );
  });

  it("deduplicates by stable item id and keeps the first item", () => {
    const first = item({ id: "git:push", title: "Push" });
    const second = item({ id: "git:push", title: "Push branch" });

    assert.deepEqual(dedupeThreadCommandBarItems([first, second]), [first]);
  });
});
