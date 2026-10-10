import { createAppDeeplinks } from "../../src";
import type { AppDeeplinks } from "./contracts";

/**
 * Typed view of the shared registry. Every MFE can create its own; `createAppDeeplinks()`
 * returns the same object each time and talks to the same page-wide registry.
 * (In your SDK, import from wherever you copied the toolbox instead of `../../src`.)
 */
export const appDeeplinks = createAppDeeplinks<AppDeeplinks>();
