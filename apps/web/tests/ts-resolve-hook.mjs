/**
 * Resolve hook for the scaffold's test runner.
 *
 * The orchestrator-owned apps/web/tsconfig.json does not enable
 * allowImportingTsExtensions, so src modules import each other extensionless
 * (the form tsc and Vite resolve natively). Node's ESM loader, used by
 * `node --test --experimental-strip-types tests/*.test.ts`, does not append
 * extensions — this hook retries a failed relative resolution with `.ts`
 * appended so the shared src graph loads under the test runner unchanged.
 * Bare specifiers (node:*, react, @geolibre/*) and explicit paths are
 * unaffected: the fallback only runs when the default resolution failed.
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
