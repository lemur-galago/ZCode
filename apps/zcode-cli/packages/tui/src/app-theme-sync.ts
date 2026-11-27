import React from "react";
import { activeTuiTheme, resolveTuiThemeMode, setActiveTuiThemeMode } from "./theme/index.js";
import type { TuiThemeTokens } from "./theme/index.js";
import type { TuiOptions } from "./types.js";

/**
 * Local patch (transcript-row-memo): returns the theme the view is drawn in, so
 * that the view hands it to its memoized parts as a prop. It is the built-in
 * theme object of the resolved mode: the same object for as long as the mode
 * does not change, and a new one on a switch, which is what makes a memoized
 * part draw itself again then.
 */
export function useTuiThemeSync(options: TuiOptions): TuiThemeTokens {
  const [terminalThemeMode, setTerminalThemeMode] = React.useState(options.initialThemeMode);
  const resolvedThemeMode = resolveTuiThemeMode(options.theme, terminalThemeMode);
  setActiveTuiThemeMode(resolvedThemeMode);

  React.useEffect(() => options.subscribeThemeMode?.(setTerminalThemeMode), [options]);

  React.useEffect(() => {
    options.setTerminalBackgroundColor?.(activeTuiTheme(resolvedThemeMode).background);
  }, [options, resolvedThemeMode]);

  return activeTuiTheme(resolvedThemeMode);
}
