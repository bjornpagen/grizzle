/** What the properties of runtime.test.ts read: the runtime entries' programs, the run of one, and the runtime's zones. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { probedRun } from "#test/support/process.ts"

/**
 * The programs a case runs, each a module of fixtures/ importing a runtime entry as a served application does:
 * @bjornpagen/grizzle/runtime alone and @bjornpagen/grizzle/http alone.
 */
export type RuntimeProgram = "the runtime entry alone" | "the http entry alone"

const programModules: Readonly<Record<RuntimeProgram, string>> = {
	"the runtime entry alone": "test/unit/entry/fixtures/runtime-entry.ts",
	"the http entry alone": "test/unit/entry/fixtures/http-entry.ts"
}

export const runtimeProgramGen: Gen<RuntimeProgram> = element([
	"the runtime entry alone",
	"the http entry alone"
] as const)

/** `program` of the checkout at `checkout` run as probedRun runs a module: what it did, and every module it loaded. */
export const probedRuntimeProgram = (checkout: string, program: RuntimeProgram) =>
	probedRun(checkout, programModules[program], [])

/**
 * The runtime's zones, in code point order: every zone of .fallowrc.json a module the runtime entries load lies in, the
 * entries' own (runtime-entry, http), the shell's runtime and decode sites, the engine's runtime facade and the modules
 * it re-exports from (runtime, served, decode, reader, codec, live and its model, wire and served members), the parts
 * of the core, the IR and the scalars they read (core, browser-core, dsl-core, ir, dsl-ir, scalar, dsl-scalar,
 * values), the CredentialError a session's password Effect fails with, and grizzle-text. None is the compiler's or the
 * DSL builders': no schema, check, analysis, laws, logical, query, lower, write, physical, deploy, program, SQL or
 * install zone, and of the DSL only the core, IR and scalar parts its descriptors share with the runtime.
 */
export const runtimeZones = [
	"adapter-decode",
	"adapter-runtime",
	"browser-core",
	"codec",
	"core",
	"credential",
	"decode",
	"dsl-core",
	"dsl-ir",
	"dsl-scalar",
	"grizzle-text",
	"http",
	"ir",
	"live",
	"live-model",
	"live-served",
	"live-wire",
	"plan-runtime",
	"reader",
	"runtime",
	"runtime-entry",
	"scalar",
	"served",
	"values"
] as const

export const runtimeZoneGen: Gen<(typeof runtimeZones)[number]> = element(runtimeZones)
