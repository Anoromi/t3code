export const AGENT_HIGHLIGHT_LABELS = [
  "issue",
  "source",
  "suggestion",
  "alternative",
  "breakdown",
  "success",
  "info",
  "warning",
  "decision",
  "constraint",
  "action",
  "validation",
] as const;

export type AgentHighlightLabel = (typeof AGENT_HIGHLIGHT_LABELS)[number];

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
};

type MarkdownParent = MarkdownNode & {
  children: MarkdownNode[];
};

type MarkdownTransformer = (tree: MarkdownNode) => void;

const AGENT_HIGHLIGHT_LABEL_SET = new Set<string>(AGENT_HIGHLIGHT_LABELS);
const SPAN_OPEN_PATTERN = /^<span\s+class=(["'])([^"']*)\1\s*>$/i;
const SPAN_CLOSE_PATTERN = /^<\/span\s*>$/i;

function isParent(node: MarkdownNode): node is MarkdownParent {
  return Array.isArray(node.children);
}

function parseAgentHighlightOpen(node: MarkdownNode): AgentHighlightLabel | null {
  if (node.type !== "html" || typeof node.value !== "string") return null;

  const match = node.value.trim().match(SPAN_OPEN_PATTERN);
  if (!match) return null;

  const classes = match[2]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const labelClasses = classes.filter((className) => AGENT_HIGHLIGHT_LABEL_SET.has(className));
  const allowedClasses = classes.every(
    (className) => className === "agent-highlight" || AGENT_HIGHLIGHT_LABEL_SET.has(className),
  );
  if (!allowedClasses || labelClasses.length !== 1) return null;

  return labelClasses[0] as AgentHighlightLabel;
}

function isSpanClose(node: MarkdownNode): boolean {
  return node.type === "html" && SPAN_CLOSE_PATTERN.test(node.value?.trim() ?? "");
}

function createAgentHighlightNode(
  label: AgentHighlightLabel,
  children: MarkdownNode[],
): MarkdownNode {
  return {
    type: "agentHighlight",
    data: {
      hName: "span",
      hProperties: {
        className: ["agent-highlight", `agent-highlight-${label}`],
        "data-agent-highlight": label,
      },
    },
    children,
  };
}

function transformParent(parent: MarkdownParent): void {
  let index = 0;
  while (index < parent.children.length) {
    const child = parent.children[index];
    if (!child) break;

    const label = parseAgentHighlightOpen(child);
    if (!label) {
      index += 1;
      continue;
    }

    let closeIndex = -1;
    let nestedOpen = false;
    for (let scanIndex = index + 1; scanIndex < parent.children.length; scanIndex += 1) {
      const scannedChild = parent.children[scanIndex];
      if (!scannedChild) break;

      if (parseAgentHighlightOpen(scannedChild)) {
        nestedOpen = true;
        break;
      }
      if (isSpanClose(scannedChild)) {
        closeIndex = scanIndex;
        break;
      }
    }

    if (nestedOpen || closeIndex === -1) {
      index += 1;
      continue;
    }

    const innerChildren = parent.children.slice(index + 1, closeIndex);
    parent.children.splice(
      index,
      closeIndex - index + 1,
      createAgentHighlightNode(label, innerChildren),
    );
    index += 1;
  }
}

function visitParents(node: MarkdownNode): void {
  if (!isParent(node)) return;

  for (const child of node.children) {
    visitParents(child);
  }
  transformParent(node);
}

export function remarkAgentHighlightSpans(): MarkdownTransformer {
  return (tree) => {
    visitParents(tree);
  };
}
