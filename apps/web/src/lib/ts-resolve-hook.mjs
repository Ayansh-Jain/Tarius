/**
 * Minimal ESM resolve hook so the headless smoke can run the project's TS source
 * directly with Node's built-in type stripping.
 *
 * The shared package (@ice/shared) imports its siblings with `.js` specifiers
 * that actually point at `.ts` files (the standard NodeNext/TS convention). Node
 * resolves those literally and 404s. This hook rewrites a `.js` specifier to the
 * adjacent `.ts` file when the `.js` doesn't exist on disk. No dependencies; used
 * only by tree.smoke.ts via `node --import`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    try {
      const resolved = new URL(specifier, context.parentURL);
      const jsPath = fileURLToPath(resolved);
      if (!existsSync(jsPath)) {
        const tsPath = jsPath.slice(0, -3) + '.ts';
        if (existsSync(tsPath)) {
          return { url: pathToFileURL(tsPath).href, shortCircuit: true };
        }
      }
    } catch {
      // fall through to default resolution
    }
  }
  return nextResolve(specifier, context);
}
