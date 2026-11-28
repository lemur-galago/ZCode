// Local patch (marked-output): the stdout of a helper process is not a private
// channel. On a machine where an API-hooking DLL is injected into every
// process (mhook prints "[0x7FF...] ANOMALY: meaningless REX prefix used"),
// foreign lines appear in the output of powershell.exe before and after what
// the script wrote. A helper writes its result between the markers of its
// call and the reader takes only what sits between them: no markers, no result.
import { randomBytes } from "node:crypto";

const MARKER_BYTES = 16;

export interface OutputMarkers {
  close: string;
  open: string;
}

/** Markers of one call. Unguessable, so no result contains them by chance. */
export function createOutputMarkers(): OutputMarkers {
  const token = randomBytes(MARKER_BYTES).toString("hex");
  return { close: `zcode-end-${token}`, open: `zcode-begin-${token}` };
}

/** The text the script wrote between its markers; undefined when it wrote none. */
export function readMarkedOutput(stdout: string, markers: OutputMarkers): string | undefined {
  const start = stdout.indexOf(markers.open);
  if (start < 0) return undefined;
  const from = start + markers.open.length;
  const end = stdout.indexOf(markers.close, from);
  return end < 0 ? undefined : stdout.slice(from, end);
}
