/** What the properties of domain.test.ts read: the domain entry's program, its run, and the zones it may load. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { probedRun } from "#test/support/process.ts"

/** The program a case runs: a module of fixtures/ importing the domain entry alone, as a boundary that parses does. */
const programModule = "test/unit/entry/fixtures/domain-entry.ts"

/** The domain entry's program run as probedRun runs a module: what it did, and every module it loaded. */
export const probedDomainProgram = (checkout: string) => probedRun(checkout, programModule, [])

/**
 * The zones the domain entry may load, in code point order, and none else: its own (domain-entry, adapter-domain,
 * plan-contract, contract), the text-language analysis its checker is typed by, whose bytes a check prints in are data
 * of its own (dsl-text-language), and the runtime's zones beneath the runtime's judgment of a value's domain, which the
 * parse runs, and beneath the shell's spelling of a Result (adapter-runtime): the core, the IR, the scalars with their
 * predicate lowering, the codecs, the decode sites, the served forms and the live model they share. No SQL printer, no
 * schema builder, check, analysis, laws, logical, query, lower, write, physical, deploy, program or install zone.
 */
export const domainZones = [
	"adapter-decode",
	"adapter-domain",
	"adapter-runtime",
	"browser-core",
	"codec",
	"contract",
	"core",
	"credential",
	"decode",
	"domain-entry",
	"dsl-core",
	"dsl-ir",
	"dsl-runtime",
	"dsl-scalar",
	"dsl-text-language",
	"grizzle-text",
	"ir",
	"live",
	"live-model",
	"live-served",
	"live-wire",
	"plan-contract",
	"plan-runtime",
	"reader",
	"runtime",
	"scalar",
	"served",
	"values"
] as const

export const domainZoneGen: Gen<(typeof domainZones)[number]> = element(domainZones)
