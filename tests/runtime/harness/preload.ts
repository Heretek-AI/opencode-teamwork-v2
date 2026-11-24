// Preload: fix the hermetic environment before any @opencode module is imported.
//
// Several host modules (notably @opencode/util/global-roots) read HOME/XDG once
// at module evaluation. Bun's preload runs before the test files' imports, so
// this is the only reliable place to set them.

import { createBaseEnvironment, cleanupProjects } from "./project"

createBaseEnvironment()
process.on("exit", cleanupProjects)
