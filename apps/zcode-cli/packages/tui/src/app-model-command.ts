import React from "react";
import {
  filterModelOptions,
  modelCommandQuery,
  reconcileModelCommandSelection,
  selectedModelOption,
} from "./app-input.js";
import type { ModelCommandSelectionState } from "./app-model.js";
import type { TuiModelOption, TuiOptions } from "./types.js";

export function useModelCommandController(
  draft: string,
  options: Pick<TuiOptions, "modelOptions" | "initialResult" | "listModelOptions">,
): {
  filteredOptions: readonly TuiModelOption[];
  // Local patch (model-effort-status-switcher): the full unfiltered catalog is
  // exposed so the status-row model switcher can cycle models at any time.
  modelOptions: readonly TuiModelOption[];
  reconcileDraft: (value: string) => ModelCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiModelOption | undefined;
  selection: ModelCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<ModelCommandSelectionState | undefined>>;
  setModelOptions: React.Dispatch<React.SetStateAction<readonly TuiModelOption[]>>;
} {
  const [modelOptions, setModelOptions] = React.useState<readonly TuiModelOption[]>(
    () => options.initialResult?.modelOptions ?? options.modelOptions ?? [],
  );
  const listModelOptions = options.listModelOptions;
  const [selection, setSelection] = React.useState<ModelCommandSelectionState | undefined>();
  const active = modelCommandQuery(draft) !== undefined;
  React.useEffect(() => {
    if (!active || !listModelOptions) return;
    let cancelled = false;
    void listModelOptions()
      .then((models) => {
        if (!cancelled) setModelOptions(models);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, listModelOptions]);
  // Opening from an empty catalog must admit selection when the fresh catalog arrives.
  React.useEffect(() => {
    setSelection((current) =>
      active && modelOptions.length > 0 ? (current ?? { selectedIndex: 0 }) : undefined,
    );
  }, [active, modelOptions]);
  const filteredOptions = React.useMemo(
    () => filterModelOptions(draft, modelOptions),
    [draft, modelOptions],
  );
  const reconcileDraft = React.useCallback(
    (value: string) => {
      const nextSelection = reconcileModelCommandSelection(value, modelOptions);
      setSelection(nextSelection);
      return nextSelection;
    },
    [modelOptions],
  );
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedModelOption(submittedValue, selection, filteredOptions),
    [filteredOptions, selection],
  );

  // Local patch (panel-memo): the same object for as long as its members are.
  // The app builds the setter of the composer draft from it, and that setter
  // is a prop of the memoized composer.
  return React.useMemo(
    () => ({
      filteredOptions,
      modelOptions,
      reconcileDraft,
      selectedOption,
      selection,
      setSelection,
      setModelOptions,
    }),
    [
      filteredOptions,
      modelOptions,
      reconcileDraft,
      selectedOption,
      selection,
      setSelection,
      setModelOptions,
    ],
  );
}
