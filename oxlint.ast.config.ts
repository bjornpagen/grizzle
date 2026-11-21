import { astOnly } from "@bjornpagen/devtools/preset"
import { defineConfig } from "oxlint"
import config from "#oxlint.config.ts"

/** The commit gate's oxlint: the full configuration without its type-aware rules, over every file. */
export default defineConfig(astOnly(config))
