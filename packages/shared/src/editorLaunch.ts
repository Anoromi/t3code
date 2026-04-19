import { EDITORS, type EditorId } from "@t3tools/contracts";

export interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

function parseTargetPathAndPosition(target: string): {
  readonly path: string;
  readonly line: string | undefined;
  readonly column: string | undefined;
} | null {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    path: match[1],
    line: match[2],
    column: match[3],
  };
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return parsedTarget ? ["--goto", target] : [target];
    case "line-column": {
      if (!parsedTarget) {
        return [target];
      }

      const { path, line, column } = parsedTarget;
      return [...(line ? ["--line", line] : []), ...(column ? ["--column", column] : []), path];
    }
  }
}

function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

export function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

export function resolveEditorLaunch(input: {
  readonly editor: EditorId;
  readonly target: string;
  readonly platform?: NodeJS.Platform;
}): EditorLaunch | null {
  const platform = input.platform ?? process.platform;
  const editor = EDITORS.find((candidate) => candidate.id === input.editor);
  if (!editor) {
    return null;
  }

  if (editor.commands) {
    return {
      command: editor.commands[0],
      args: resolveEditorArgs(editor, input.target),
    };
  }

  if (editor.id !== "file-manager") {
    return null;
  }

  return {
    command: fileManagerCommandForPlatform(platform),
    args: [input.target],
  };
}
