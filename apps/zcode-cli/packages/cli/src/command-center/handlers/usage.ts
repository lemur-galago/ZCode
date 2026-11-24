import type { TuiSubmitPromptResult } from "@zcode/tui";
import {
  type AccountQuotaReadFailure,
  AccountQuotaReadError,
  formatAccountQuotaReport,
} from "../../account-quota.js";
import type { CommandCenterDeps } from "../types.js";

// Local patch (account-quota-indicator): /usage prints the used share of the
// Coding Plan credit pools into the transcript. It reads the account through
// the same reader as the quota segment of the status row and sends no prompt,
// so it works during a running turn as well.
export async function handleUsageCommand(
  deps: CommandCenterDeps,
  now: () => number = Date.now,
): Promise<TuiSubmitPromptResult> {
  const mode = deps.getMode?.();
  if (!deps.readAccountQuota) {
    return { mode, response: "Account usage is not available in this client." };
  }

  let snapshot;
  try {
    snapshot = await deps.readAccountQuota({});
  } catch (error) {
    return { mode, response: usageFailureMessage(error) };
  }
  if (!snapshot) {
    return {
      mode,
      response:
        "No Z.ai or BigModel Coding Plan API key is configured, so there is no plan usage to show. Set one up with /login.",
    };
  }
  return { mode, response: formatAccountQuotaReport(snapshot, now()) };
}

const READ_FAILURE_MESSAGES: Record<AccountQuotaReadFailure, string> = {
  offline: "The usage service cannot be reached. Check the connection and try again.",
  rejected: "The usage service rejected the request. Try again later.",
  server: "The usage service reports an error. Try again later.",
  timeout: "The usage service did not answer in time. Try again.",
  unauthorized: "The API key was rejected. Check it with /login.",
};

// The reason of a failed read in words; never the key or the response body.
function usageFailureMessage(error: unknown): string {
  const failure = error instanceof AccountQuotaReadError ? error : undefined;
  const message = failure ? READ_FAILURE_MESSAGES[failure.failure] : READ_FAILURE_MESSAGES.offline;
  const detail = failure?.detail ? ` (${failure.detail})` : "";
  return `Could not read the plan usage: ${failure?.failure ?? "offline"}${detail}. ${message}`;
}
