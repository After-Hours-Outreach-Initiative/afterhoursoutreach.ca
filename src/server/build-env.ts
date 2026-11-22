// Read build flags only as `import.meta.env.X`, which Vite replaces with each
// value. Any other use of `import.meta.env` (including `?.`) inlines the whole
// build environment, local secrets included. Outside Vite, such as in tsx
// scripts, `import.meta.env` is undefined and the flags are unset.

export function buildMode(): string | undefined {
  try {
    return import.meta.env.MODE;
  } catch {
    return undefined;
  }
}

export function developmentBuild(): boolean {
  try {
    return Boolean(import.meta.env.DEV);
  } catch {
    return false;
  }
}
