/** What the property of dsl.test.ts reads: its programs, the run of one, and the architecture's zones. */

import { matchesGlob } from "node:path"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Option, Order, String as Str } from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { probedRun } from "#test/support/process.ts"

/**
 * The programs a case runs, each a module of fixtures/ importing @bjornpagen/grizzle as an application does: the entry
 * alone, a one-relation grizzle.config.ts as the command line evaluates one, and a schema module over the builders.
 */
export type Program = "the entry alone" | "a one-relation grizzle.config.ts" | "a schema module"

const programModules: Readonly<Record<Program, string>> = {
	"the entry alone": "test/unit/entry/fixtures/entry.ts",
	"a one-relation grizzle.config.ts": "test/unit/entry/fixtures/one-relation.config.ts",
	"a schema module": "test/unit/entry/fixtures/notes.ts"
}

export const programGen: Gen<Program> = element([
	"the entry alone",
	"a one-relation grizzle.config.ts",
	"a schema module"
] as const)

/** `program` of the checkout at `checkout` run as probedRun runs a module: what it did, and every module it loaded. */
export const probedProgram = (checkout: string, program: Program) =>
	probedRun(checkout, programModules[program], [])

/** A zone of the checkout's .fallowrc.json: its name, and the globs of the files it holds. */
interface Zone {
	readonly name: string
	readonly patterns: ReadonlyArray<string>
}

/** A rule of the checkout's .fallowrc.json: the zone it is from, and the zones it allows a value import of. */
interface Rule {
	readonly from: string
	readonly allow: ReadonlyArray<string>
}

/**
 * The architecture of the checkout's .fallowrc.json: its zones, in its order, and its rules. Its comments are whole
 * lines, each `//` after its indent, which no JSON line is.
 */
const architectureOf = (checkout: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(`${checkout}/.fallowrc.json`)
		const json = Arr.join(
			Arr.filter(Str.split(text, "\n"), (line) => !Str.startsWith("//")(Str.trimStart(line))),
			"\n"
		)
		return trustedJson<{
			readonly boundaries: {
				readonly zones: ReadonlyArray<Zone>
				readonly rules: ReadonlyArray<Rule>
			}
		}>(json).boundaries
	}).pipe(Effect.orDie)

/** The zones of the checkout's .fallowrc.json, in its order. */
export const zonesOf = (checkout: string) => Effect.map(architectureOf(checkout), (a) => a.zones)

/** The rules of the checkout's .fallowrc.json, in its order. */
export const rulesOf = (checkout: string) => Effect.map(architectureOf(checkout), (a) => a.rules)

/** The zone fallow classifies `file` (a path in the checkout) into: the first whose glob matches, or none. */
export const zoneOf = (zones: ReadonlyArray<Zone>, file: string): string =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(zones, (zone) => Arr.some(zone.patterns, (glob) => matchesGlob(file, glob))),
			(zone) => zone.name
		),
		() => "no zone"
	)

/** The DSL's zones: dsl-<zone>, each the part of <zone> the authoring entry loads. */
export const isDslZone: (zone: string) => boolean = Str.startsWith("dsl-")

/**
 * The zones the DSL loads beside its own: the browser-safe core, the CredentialError a configuration's password
 * Effect fails with, the value core and grizzle-text.
 */
export const besideTheDsl: ReadonlyArray<string> = [
	"browser-core",
	"credential",
	"grizzle-text",
	"values"
]

/**
 * The one part of the compiler the DSL loads, the SQL printer, in code point order: a str.regex descriptor's admission
 * (text/refinement.ts analyzeText) analyzes its patterns once and chooses its CHECK, `VALUE IN (...)` or
 * `VALUE ~ 'ARE'`, by which prints shorter, so building the descriptor prints both; and the CHECK it keeps is part of
 * the text domain's identity digest, so the choice cannot wait for the compiler.
 */
export const printer: ReadonlyArray<string> = Arr.sort(
	[
		"packages/engine/src/sql/ast.ts",
		"packages/engine/src/sql/build.ts",
		"packages/engine/src/sql/catalog.ts",
		"packages/engine/src/sql/escape.ts",
		"packages/engine/src/sql/generation.ts",
		"packages/engine/src/sql/lexer.ts",
		"packages/engine/src/sql/print.ts",
		"packages/engine/src/sql/print-once.ts",
		"packages/engine/src/sql/pull-up.ts",
		"packages/engine/src/sql/scope.ts",
		"packages/engine/src/sql/transform.ts"
	],
	Order.String
)

/** Every TypeScript source of the checkout's packages, by its path in the checkout, in code point order. */
export const packageSources = (checkout: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const files = yield* fs.readDirectory(`${checkout}/packages`, { recursive: true })
		return Arr.sort(
			Arr.map(
				Arr.filter(
					files,
					(file) => Str.endsWith(".ts")(file) && !Str.includes("node_modules/")(file)
				),
				(file) => `packages/${file}`
			),
			Order.String
		)
	}).pipe(Effect.orDie)
