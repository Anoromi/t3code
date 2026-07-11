// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

const CORKDIFF_GHOSTTY_CLASS_PREFIX = "dev.t3tools.t3code.corkdiff";

export function createCorkdiffGhosttyClassName(threadId: string): string {
  const suffix = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 12);
  return `${CORKDIFF_GHOSTTY_CLASS_PREFIX}.t${suffix}`;
}

export function buildCorkdiffGhosttyArgs(input: {
  readonly className: string;
  readonly threadId: string;
}): readonly string[] {
  return [
    "--gtk-single-instance=false",
    `--class=${input.className}`,
    `--title=T3 Code Corkdiff ${input.threadId}`,
    "-e",
    "nvim",
    "-c",
    "lua require('codediff.config').options.t3code.server_url=vim.env.T3CODE_SERVER_URL",
    "-c",
    "lua vim.api.nvim_cmd({cmd='CorkDiff',args={'t3code',vim.env.T3CODE_THREAD_ID}}, {})",
  ];
}
