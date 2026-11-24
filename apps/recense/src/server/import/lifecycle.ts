import { ApiError } from "../http/errors.ts";
export function checkImportSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new ApiError("invalid_request", "import_aborted");
}

/** Import never queues behind another import, nor takes publishing/reviewer capacity. */
export function createImportSlot() {
  let active = false;
  return (signal?: AbortSignal) => {
    checkImportSignal(signal);
    if (active) throw new ApiError("rate_limited", "import_busy");
    active = true;
    return () => {
      active = false;
    };
  };
}
export const acquireImport = createImportSlot();
