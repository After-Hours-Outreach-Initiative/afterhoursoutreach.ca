/** Worker previews use an optimized build, never Vite's development output. */
export const isWorkerPreview = import.meta.env?.MODE === "preview";

/** Production stays on the existing public site until accounts are launched. */
export const accountsEnabled = isWorkerPreview || Boolean(import.meta.env?.DEV);
