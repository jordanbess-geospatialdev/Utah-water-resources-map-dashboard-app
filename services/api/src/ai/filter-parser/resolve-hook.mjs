/**
 * Resolve hook for running the browser-safe parser core under
 * `node --test --experimental-strip-types` from the API package.
 *
 * The core modules import each other EXTENSIONLESS (the form tsc and Vite
 * resolve natively — required because apps/web bundles this core and its
 * orchestrator-owned tsconfig does not enable allowImportingTsExtensions).
 * Node's ESM loader does not append extensions, so this hook retries a
 * failed relative resolution with `.ts` appended — the same pattern as
 * apps/web/tests/ts-resolve-hook.mjs. Test files register() it before their
 * dynamic imports.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const retryable =
      (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') &&
      (specifier.startsWith('./') || specifier.startsWith('../'));
    if (retryable && !specifier.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
