import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterDeps } from "../types.js";

// Local patch (adddir-command): /adddir appends a working directory to the
// live session. The path is resolved and validated by the wired dep (it owns
// the session cwd and the process-level list that survives /new and /resume);
// the runtime config swap makes the core announce the addition to the model
// on the next turn (buildEnvironmentAnnouncement).
export async function handleAddDirCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const current = deps.getMode?.();
  if (!deps.addWorkingDirectory || !deps.listWorkingDirectories) {
    return {
      mode: current,
      response: "Adding working directories is not available in this client.",
    };
  }

  const directories = deps.listWorkingDirectories();
  if (args.trim().length === 0) {
    return {
      mode: current,
      response: formatAddDirListing(deps.getWorkingDirectoryBase?.(), directories),
    };
  }

  const outcome = await deps.addWorkingDirectory({ path: args });
  if (outcome.outcome === "error") {
    return { mode: current, response: outcome.message };
  }
  if (outcome.outcome === "duplicate") {
    return {
      mode: current,
      response: `Already an additional working directory: ${outcome.path}`,
    };
  }
  return {
    mode: current,
    response: [
      `Added working directory: ${outcome.path}`,
      formatAddDirListing(deps.getWorkingDirectoryBase?.(), outcome.directories),
    ].join("\n"),
  };
}

function formatAddDirListing(workingDirectory: string | undefined, directories: string[]): string {
  const lines = [`Working directory: ${workingDirectory ?? "(unknown)"}`];
  if (directories.length === 0) {
    lines.push("Additional directories: none. Usage: /adddir <directory>");
  } else {
    lines.push(`Additional directories (${directories.length}):`);
    lines.push(...directories.map((directory) => `- ${directory}`));
  }
  return lines.join("\n");
}
