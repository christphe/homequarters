// Lets a test load a web/src module whose imports leave out the ".ts" extension (Vite resolves them; node does
// not): import this file first, then the module with a dynamic import(). Only relative imports are touched.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return next(specifier + ".ts", context);
      } catch {
        // not a .ts file: resolved as written below
      }
    }
    return next(specifier, context);
  },
});
