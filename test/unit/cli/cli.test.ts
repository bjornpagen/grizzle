/**
 * The `grizzle` command line without a database: argument parsing, folder timestamps and the lean configuration file.
 * What its commands write is the project suite's (project.test.ts).
 *
 * - The grammar, generated: every line of it (generate and every command of CommandName beside it, check, migrate,
 *   drift, names, roles and uninstall, each over the configuration file its one argument names, and generate's flags --name, a folder's name, --custom, which needs
 *   --name, and --schema, in any order and as `--flag value` or `--flag=value`) is read as exactly what it says; one
 *   fault injected into a line, a --name of no folder name's shape among them, is a usage error naming that fault;
 *   --help or -h anywhere prints the usage.
 * - Folder timestamps, generated against day arithmetic of the proleptic Gregorian calendar: a timestamp is the UTC second as fourteen digits,
 *   read back as the second it names and as nothing when its digits name none; a new folder's is the current second or
 *   one second after the schema's newest folder, whichever is later, its digits counted on as a number when they name
 *   no second.
 * - The configuration, generated: defineConfig({ schemas, logins, migrations, connection }) over one to three
 *   schemas and any of their logins resolves to exactly its schemas, each with its PostgreSQL schema, its directory and
 *   its logins, the migrations directory against the configuration file's, and the connection kept unread; one fault
 *   planted into it is refused at stage config by its own reason, and no refusal names the password.
 * - The bin's loading of the configuration file, generated: a command naming no file is a usage error; a file that is
 *   missing, whose import throws, fails to parse, imports what does not exist or awaits a rejection, that exports no
 *   default, or whose default is any value but a configuration grizzle runs, built by defineConfig or not, is refused,
 *   writing nothing.
 *
 * Oracles: the grammar's meaning of each line and the fault each injection plants (specifications); day arithmetic of
 * the proleptic Gregorian calendar (a second implementation); the configuration's documented settings resolved by hand;
 * and the exit statuses run.ts documents.
 *
 * Features: each line of the grammar and each fault, --help, -h and no argument, the timestamps' calendar edges, each
 * configuration fault, and each way the bin's loading ends.
 */
import { inspect } from "node:util"
import { assert, lacksText } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Option,
	String as Str
} from "effect"
import { parseArgs } from "#cli/args.ts"
import { formatTimestamp, nextTimestamp, parseTimestamp } from "#cli/clock.ts"
import { cliStageFix } from "#cli/refusals.ts"
import {
	bin,
	configName,
	offlinePassword,
	resolvedConfig,
	workspace
} from "#test/pg/cli/support.ts"
import { refusedAt, succeeded } from "#test/support/assert.ts"
import {
	argvOf,
	type ConfigFeature,
	configFaultKinds,
	configFile,
	digitsOf,
	expectedOf,
	faultGen,
	type FaultKind,
	faultKinds,
	type GrammarFeature,
	grammarFeatures,
	grammarNotes,
	helpGen,
	type HelpFeature,
	type LoadingFeature,
	loadingFile,
	loadingNotes,
	loadingSpace,
	meaningOf,
	migrationsOf,
	millisOf,
	modelSchemas,
	namedBy,
	nextOf,
	resolvedSchemas,
	secondOfDigits,
	sketchGen,
	spelledGen,
	type StampFeature,
	stampingSpace,
	statusOf,
	valueOf
} from "#test/unit/cli/cli.fixtures.ts"

/**
 * The command line, generated, reads every line of the grammar as exactly what it says, its flags in any order and
 * either spelling.
 *
 * Budget: its suite's count before the conversion (unit/cli/grammar: 200 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theCommandLineGeneratedReadsEveryLineOfTheGrammarAsExactlyWhatItSaysItsFlagsInAnyOrderAndEitherSpelling =
	property.explore(spelledGen, {
		needs: {},
		situations: grammarFeatures satisfies ReadonlyArray<Reached<GrammarFeature>>,
		check: (_, c: Case<GrammarFeature>) => (s) =>
			Effect.sync(() => {
				c.noteAll(grammarNotes(s))
				const argv = argvOf(s.line.command, s.units)
				assert.deepEqual(succeeded(parseArgs(argv), Arr.join(argv, " ")), meaningOf(s.line))
			}),
		oracle: {
			kind: "specification",
			name: "the grammar's meaning of each line, whatever its flags' order and spelling"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/args.ts",
				original: "\tif (renames.length === 0 && drops.length === 0) {",
				replacement: "\tif (renames.length === 0 && drops.length !== 0) {",
				why: "Operator mutant (comparison) at packages/grizzle/src/cli/args.ts:250 in declaredOf: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The command line, generated, refuses one fault injected into a line of the grammar as a usage error naming that
 * fault.
 *
 * Budget: its suite's count before the conversion (unit/cli/grammar-faults: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theCommandLineGeneratedRefusesOneFaultInjectedIntoALineOfTheGrammarAsAUsageErrorNamingThatFault =
	property.explore(faultGen, {
		needs: {},
		situations: faultKinds satisfies ReadonlyArray<Reached<FaultKind>>,
		check: (_, c: Case<FaultKind>) => (f) =>
			Effect.sync(() => {
				c.note(f.kind)
				const literal = Formatter.format(f.argv)
				const refusal = refusedAt(parseArgs(f.argv), "stage", "usage", literal)
				const reason = refusal.reason
				assert.ok(
					f.kind === "MigrationNameRefused"
						? reason._tag === f.kind
						: reason._tag === "ArgumentsRefused" && reason.fault.kind === f.kind,
					`${literal} is refused for ${f.kind}, not: ${refusal.message}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the fault each injection plants into a line of the grammar"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/args.ts",
				original: `\t\tconst value = arg === \`--\${flag}\` ? rest[++i] : Str.slice(\`--\${flag}=\`.length)(arg)\n\t\tif (value === undefined || value.length === 0 || Str.startsWith("-")(value)) {\n\t\t\treturn malformed({ kind: "flagWithoutValue", flag })`,
				replacement: `\t\tconst value = arg === \`--\${flag}\` ? rest[++i] : Str.slice(\`--\${flag}=\`.length)(arg)\n\t\tif (value === undefined || value.length === (-1) || Str.startsWith("-")(value)) {\n\t\t\treturn malformed({ kind: "flagWithoutValue", flag })`,
				why: "Operator mutant (bound) at packages/grizzle/src/cli/args.ts:206 in scan: `0` becomes `(-1)`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The command line, generated, prints the usage for --help or -h anywhere, and for no argument at all.
 *
 * Budget: its suite's count before the conversion (unit/cli/grammar-help: 100 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theCommandLineGeneratedPrintsTheUsageForHelpOrHAnywhereAndForNoArgumentAtAll =
	property.explore(helpGen, {
		needs: {},
		situations: ["--help", "-h", "no argument"] satisfies ReadonlyArray<Reached<HelpFeature>>,
		check: (_, c: Case<HelpFeature>) => (help) =>
			Effect.sync(() => {
				c.note(help.kind)
				const argv = help.kind === "no argument" ? [] : help.argv
				assert.deepEqual(succeeded(parseArgs(argv), Arr.join(argv, " ")), { kind: "help" })
			}),
		oracle: {
			kind: "specification",
			name: "the usage for a line holding --help or -h anywhere, and for no argument"
		},
		budget: { runs: 100, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/args.ts",
				original: "\tif (command === undefined || Arr.some(argv, isHelp)) {",
				replacement: "\tif (command === undefined || isHelp(command)) {",
				why: "--help counts only as the command."
			},
			{
				file: "packages/grizzle/src/cli/args.ts",
				original: "\tif (command === undefined || Arr.some(argv, isHelp)) {",
				replacement: "\tif (command === undefined || Arr.every(argv, isHelp)) {",
				why: "Operator mutant (quantifier) at packages/grizzle/src/cli/args.ts:287 in parseArgs: `some` becomes `every`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Folder timestamps, generated, are the UTC second as fourteen digits, read back as the second they name, and a new
 * folder's sorts after every folder of its schema.
 *
 * Budget: its suite's count before the conversion (unit/cli/timestamps: 400 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (a timestamp past year
 * 9999; toolchain-test run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200, which it stops
 * short of once every situation is reached.
 */
export const folderTimestampsGeneratedAreTheUTCSecondAsFourteenDigitsReadBackAsTheSecondTheyNameAndANewFoldersSortsAfterEveryFolderOfItsSchema =
	property.explore(stampingSpace, {
		needs: {},
		situations: [
			"no folder",
			"the clock past the newest folder",
			"the clock at the newest folder's second",
			"the clock behind the newest folder",
			"a newest folder naming no second",
			"a day rolled over",
			"a year rolled over",
			"a timestamp past year 9999",
			"February 29"
		] satisfies ReadonlyArray<Reached<StampFeature>>,
		check: (_, c: Case<StampFeature>) => (s) =>
			Effect.sync(() => {
				const millis = millisOf(s.now)
				const now = DateTime.makeUnsafe(millis)
				if (s.now.month === 2 && s.now.day === 29) {
					c.note("February 29")
				}
				const digits = digitsOf(s.now)
				assert.equal(formatTimestamp(now), digits, "the UTC second's digits")
				for (const text of [digits, ...s.existing]) {
					assert.deepEqual(
						Option.map(parseTimestamp(text), DateTime.toEpochMillis),
						secondOfDigits(text),
						`${text} reads as the second it names, or none`
					)
				}
				assert.equal(nextTimestamp(now, s.existing), nextOf(s, c), Formatter.format(s))
			}),
		oracle: {
			kind: "second-implementation",
			name: "day arithmetic of the Gregorian calendar, and the documented rule: the current second or one past the newest folder's"
		},
		budget: { runs: 400, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/clock.ts",
				original: "\tif (current > latest) {",
				replacement: "\tif (current >= latest) {",
				why: "A new folder's timestamp repeats the newest folder's when the clock reads it."
			},
			{
				file: "packages/grizzle/src/cli/clock.ts",
				original: 'const isDigit = (c: string): boolean => c >= "0" && c <= "9"',
				replacement: 'const isDigit = (c: string): boolean => c < "0" && c <= "9"',
				why: "Operator mutant (comparison) at packages/grizzle/src/cli/clock.ts:50 in isDigit: `>=` becomes `<`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The configuration file, generated, resolves to exactly its schemas, logins and migrations directory, its connection
 * unread, and refuses one planted fault by its own reason, never naming the password.
 *
 * Budget: its suite's count before the conversion (unit/cli/configuration: 200 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theConfigurationFileGeneratedResolvesToExactlyItsSchemasLoginsAndMigrationsDirectoryItsConnectionUnreadAndRefusesOnePlantedFaultByItsOwnReasonNeverNamingThePassword =
	property.explore(sketchGen, {
		needs: {},
		situations: [
			...configFaultKinds,
			"three schemas",
			"a schema with no login listed",
			"a broken connection kept"
		] satisfies ReadonlyArray<Reached<ConfigFeature>>,
		check: (_, c: Case<ConfigFeature>) => (s) =>
			Effect.gen(function* () {
				const { value, connection } = valueOf(s)
				const resolved = yield* resolvedConfig(value, configFile)
				const f = s.fault
				if (f.kind === "none") {
					const config = succeeded(resolved)
					assert.equal(config.migrations, migrationsOf(s.migrations).resolved)
					assert.deepEqual(resolvedSchemas(config), modelSchemas(s))
					assert.ok(config.connection === connection, "the connection kept as given")
					c.noteAll([
						...(s.schemas.length === 3 ? (["three schemas"] as const) : []),
						...(s.logins.length < s.schemas.length
							? (["a schema with no login listed"] as const)
							: []),
						...(s.broken ? (["a broken connection kept"] as const) : [])
					])
					return
				}
				c.note(f.kind)
				const refusal = refusedAt(resolved, "stage", "config")
				assert.deepEqual(namedBy(refusal), expectedOf(s, f))
				lacksText(
					`${refusal.message}\n${inspect(refusal, { depth: 12 })}`,
					offlinePassword,
					"no refusal names the password"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the configuration's documented settings, resolved by hand, and the refusal each planted fault names"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/config.ts",
				original: "\tif (!Predicate.isObject(value)) {",
				replacement: "\tif (false) {",
				why: 'Operator mutant (boolean-return) at packages/grizzle/src/cli/config.ts:141 in isObject: `typeof v === "object" && v !== null && !Arr.isArray(v)` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6). Restated where the configuration reads Predicate.isObject (lane UNIFY7).'
			}
		]
	})

/**
 * The bin's configuration file is named by the command line, loaded and checked before any command runs: every way
 * loading fails is refused, writing nothing. A refusal at stage config states its own fix, and no fix of the stage
 * follows it, where a usage error is followed by its stage's (packages/grizzle/src/cli/refusals.ts cliStageFix).
 *
 * Budget: its suite's count before the conversion (unit/cli/bin-loading: 8 independent cases and 12 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theBinsConfigurationFileIsNamedByTheCommandLineLoadedAndCheckedBeforeAnyCommandRunsEveryWayLoadingFailsIsRefusedWritingNothing =
	property.explore(loadingSpace, {
		needs: { checkout: Checkout.dir },
		situations: [
			"no file named",
			"a file that does not exist",
			"a file whose import fails",
			"a file that loads",
			"a throw",
			"a syntax error",
			"a missing import",
			"a rejected await",
			"no default export",
			"a default built by defineConfig",
			"a default defineConfig did not build"
		] satisfies ReadonlyArray<Reached<LoadingFeature>>,
		check: (_, c: Case<LoadingFeature>) => (loading) =>
			Effect.gen(function* () {
				c.noteAll(loadingNotes(loading))
				const ws = yield* workspace("loading")
				yield* loadingFile(ws, loading)
				const argv = loading.kind === "no file named" ? ["generate"] : ["generate", configName]
				const ran = yield* bin(ws, argv, {})
				assert.equal(ran.status, statusOf(loading), `${loading.kind}: ${ran.stderr}`)
				const lines = Str.split("\n")(ran.stderr)
				const fixes = Arr.filter(lines, Str.startsWith("fix: "))
				if (Arr.some(lines, Str.startsWith("grizzle: refused at stage config"))) {
					assert.deepEqual(
						fixes,
						[],
						`${loading.kind}: a refusal at stage config states its own fix`
					)
				}
				if (Arr.some(lines, Str.startsWith("grizzle: usage error"))) {
					assert.deepEqual(
						fixes,
						[`fix: ${cliStageFix.usage}`],
						`${loading.kind}: a usage error names its stage's fix`
					)
				}
				const fs = yield* FileSystem.FileSystem
				const left = yield* fs.readDirectory(ws)
				assert.deepEqual(
					Arr.filter(left, (entry) => entry !== configName),
					[],
					"a refusal writes nothing"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the exit statuses run.ts documents: 1 for a refusal, 2 for a usage error; and a refusal writes nothing"
		},
		budget: { runs: 8, steered: 12 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/args.ts",
				original: 'const isHelp = (arg: string): boolean => arg === "--help" || arg === "-h"',
				replacement: 'const isHelp = (arg: string): boolean => arg === "--help" || arg !== "-h"',
				why: "Operator mutant (comparison) at packages/grizzle/src/cli/args.ts:117 in isHelp: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/grizzle/src/cli/run.ts",
				original: '\treturn stage === "config"',
				replacement: '\treturn stage === "usage"',
				why: "A refusal at stage config followed by a fix of the stage, the generic one that contradicts its own (a compile error's, an unrepresentable key's bound), and a usage error by none; the refused loadings fail."
			}
		]
	})
