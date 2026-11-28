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
 *   read back as the second it names and as nothing when its digits name none; a new folder's is the second after its
 *   committed chain's last folder's, the epoch's for a chain of none, read off no clock.
 * - The configuration, generated: defineConfig({ schemas, logins, migrations, rolePrefixBytes, connection }) over one
 *   to three schemas and any of their logins, and maybe a login whose PostgreSQL role fills 63 bytes under the declared
 *   role prefix, resolves to exactly its schemas, each with its PostgreSQL schema, its directory and its logins, the
 *   migrations directory against the configuration file's, and the connection kept unread; one fault planted into it,
 *   a login whose role passes 63 bytes under the declared prefix by one among them, is refused at stage config by its
 *   own reason, a too-long role named with its bytes and the limit, and no refusal names the password. The connection
 *   a command calls is refused where its role prefix is longer than the declared one.
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
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert, defined, lacksText } from "@bjornpagen/testing/assert"
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
	Result,
	String as Str
} from "effect"
import { parseArgs } from "#cli/args.ts"
import { migrationConnection } from "#cli/connection.ts"
import { cliStageFix } from "#cli/refusals.ts"
import { formatTimestamp, nextTimestamp, parseTimestamp } from "#cli/timestamp.ts"
import {
	maxIdentifierBytes,
	maxRolePrefixBytes,
	roleInSpace,
	type RoleSpace,
	roleSpaceOf
} from "#compiler/core/identity.ts"
import { timestampParts } from "#compiler/plan/migration.ts"
import { refusedAt, succeeded } from "#test/support/assert.ts"
import { digitsOf, millisOf, secondOfDigits } from "#test/support/calendar.ts"
import {
	bin,
	configName,
	offlinePassword,
	resolvedConfig,
	workspace
} from "#test/support/pg/cli/support.ts"
import {
	argvOf,
	type ConfigFeature,
	configFaultKinds,
	configFile,
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
	modelSchemas,
	namedBy,
	nextOf,
	prefixOf,
	resolvedSchemas,
	sketchSpace,
	spelledSpace,
	type StampFeature,
	stampingSpace,
	statusOf,
	stemUnderPrefix,
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
	property.explore(spelledSpace, {
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
				file: "packages/grizzle/src/cli/usage.ts",
				original: "\tfor (const arg of argv) {\n\t\tif (isHelp(arg)) {",
				replacement: "\tfor (const arg of argv.slice(0, 1)) {\n\t\tif (isHelp(arg)) {",
				why: "--help counts only as the command."
			},
			{
				file: "packages/grizzle/src/cli/usage.ts",
				original: "\t\tif (isHelp(arg)) {\n\t\t\treturn true\n\t\t}\n\t}\n\treturn false",
				replacement: "\t\tif (!isHelp(arg)) {\n\t\t\treturn false\n\t\t}\n\t}\n\treturn true",
				why: "Operator mutant (quantifier) in usage.ts helpAsked, once args.ts parseArgs's: `some` becomes `every`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Folder timestamps, generated, are the UTC second as fourteen digits, read back as the second they name, and a new
 * folder's is the second after its committed chain's last folder's, the epoch's for a chain of none: a function of the
 * chain alone, which reads no clock.
 *
 * Budget: its suite's count before the conversion (unit/cli/timestamps: 400 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (a timestamp past year
 * 9999; toolchain-test run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200, which it stops
 * short of once every situation is reached.
 */
export const folderTimestampsGeneratedAreTheUTCSecondAsFourteenDigitsReadBackAsTheSecondTheyNameAndANewFoldersIsTheSecondAfterItsChainsLastFolders =
	property.explore(stampingSpace, {
		needs: {},
		situations: [
			"no folder",
			"a chain drafted from nothing",
			"a text naming no second",
			"a day rolled over",
			"a year rolled over",
			"a timestamp past year 9999",
			"February 29"
		] satisfies ReadonlyArray<Reached<StampFeature>>,
		check: (_, c: Case<StampFeature>) => (s) =>
			Effect.sync(() => {
				if (s.at.month === 2 && s.at.day === 29) {
					c.note("February 29")
				}
				const digits = digitsOf(s.at)
				assert.equal(
					formatTimestamp(DateTime.makeUnsafe(millisOf(s.at))),
					digits,
					"the UTC second's digits"
				)
				for (const text of s.nonsense) {
					c.note("a text naming no second")
					assert.ok(Option.isNone(parseTimestamp(text)), `${text} names no second`)
				}
				for (const text of [digits, ...Arr.map(s.chain, digitsOf), ...s.nonsense]) {
					assert.deepEqual(
						Option.map(parseTimestamp(text), DateTime.toEpochMillis),
						secondOfDigits(text),
						`${text} reads as the second it names, or none`
					)
				}
				const chain = Arr.map(s.chain, (f) =>
					defined(timestampParts(digitsOf(f)), "a committed folder's second")
				)
				assert.equal(nextTimestamp(chain), nextOf(s, c), Formatter.format(s))
			}),
		oracle: {
			kind: "second-implementation",
			name: "day arithmetic of the Gregorian calendar, and the documented rule: one second past the chain's last folder's, the epoch for none"
		},
		budget: { runs: 400, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/timestamp.ts",
				original: "\t\t\tonNone: () => chainStart,",
				replacement: "\t\t\tonNone: () => DateTime.nowUnsafe(),",
				why: "A schema's first folder is stamped with the clock's second, as before DRAFTDET, where the chain of none gives the epoch."
			},
			{
				file: "packages/grizzle/src/cli/timestamp.ts",
				original: "\t\t\tonSome: (last) => DateTime.add(instantOf(last), timestampResolution)",
				replacement: "\t\t\tonSome: (last) => instantOf(last)",
				why: "A new folder's timestamp repeats its chain's last folder's."
			},
			{
				file: "packages/text/src/text.ts",
				original:
					"export const isAsciiDigit = (unit: number): boolean => unit >= 0x30 && unit <= 0x39",
				replacement:
					"export const isAsciiDigit = (unit: number): boolean => unit < 0x30 && unit <= 0x39",
				why: "Operator mutant (comparison) at packages/grizzle/src/cli/clock.ts:50 in isDigit: `>=` becomes `<`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** The role space of a prefix of `bytes` bytes, as migrate fills a role variable under it (core/identity.ts roleInSpace). */
const declaredSpace = (bytes: number): RoleSpace => {
	const space = roleSpaceOf(Str.repeat(bytes)("p"))
	assert.ok(space.ok, `a prefix of ${bytes} bytes`)
	return space.value
}

/**
 * The configuration file, generated, resolves to exactly its schemas, logins and migrations directory, its connection
 * unread, and refuses one planted fault by its own reason, never naming the password.
 *
 * Budget: its suite's count before the conversion (unit/cli/configuration: 200 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theConfigurationFileGeneratedResolvesToExactlyItsSchemasLoginsAndMigrationsDirectoryItsConnectionUnreadAndRefusesOnePlantedFaultByItsOwnReasonNeverNamingThePassword =
	property.explore(sketchSpace, {
		needs: {},
		situations: [
			...configFaultKinds,
			"three schemas",
			"a schema with no login listed",
			"a broken connection kept",
			"a role at the limit under the prefix",
			"a connection prefix at the bound",
			"a connection prefix past the bound"
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
					assert.equal(
						Number(config.rolePrefixBytes),
						s.rolePrefixBytes,
						"the declared prefix's bytes"
					)
					c.noteAll([
						...(s.schemas.length === 3 ? (["three schemas"] as const) : []),
						...(s.logins.length < s.schemas.length
							? (["a schema with no login listed"] as const)
							: []),
						...(s.broken ? (["a broken connection kept"] as const) : [])
					])
					for (const at of Option.toArray(s.atLimit)) {
						c.note("a role at the limit under the prefix")
						const stem = stemUnderPrefix(s, at, 0)
						const role = roleInSpace(declaredSpace(s.rolePrefixBytes), stem)
						assert.ok(
							role.ok && utf8Length(role.value) === maxIdentifierBytes,
							"migrate names the planted login's role in 63 bytes under the declared prefix"
						)
					}
					if (s.broken) {
						return
					}
					const called = yield* Effect.result(migrationConnection(config))
					const prefix = prefixOf(s)
					const bytes = Option.match(prefix, { onNone: () => 0, onSome: utf8Length })
					if (bytes <= s.rolePrefixBytes) {
						c.noteAll(Option.isSome(prefix) ? (["a connection prefix at the bound"] as const) : [])
						assert.ok(Result.isSuccess(called), "a connection within the declared prefix")
						return
					}
					c.note("a connection prefix past the bound")
					assert.ok(Result.isFailure(called), "a connection past the declared prefix is refused")
					const reason = called.failure.reason
					assert.ok(
						reason._tag === "ConnectionRefused",
						`refused for its connection: ${reason._tag}`
					)
					assert.deepEqual(reason.setting, ["connection", "rolePrefix"])
					assert.deepEqual(
						reason.rule,
						bytes > maxRolePrefixBytes
							? { kind: "rolePrefix", fault: { kind: "length", bytes, limit: maxRolePrefixBytes } }
							: { kind: "declaredPrefix", bytes, bound: s.rolePrefixBytes }
					)
					return
				}
				c.note(f.kind)
				const refusal = refusedAt(resolved, "stage", "config")
				assert.deepEqual(namedBy(refusal), expectedOf(s, f))
				if (f.kind === "a role past the limit under the prefix") {
					const reason = refusal.reason
					const stem = stemUnderPrefix(s, f.of, 1)
					assert.ok(
						reason._tag === "LoginEntryRefused" && reason.fault.kind === "roleTooLong",
						"a login entry refused for its role's length"
					)
					assert.deepEqual(
						{
							role: reason.fault.role,
							bytes: reason.fault.bytes,
							limit: reason.fault.limit,
							prefixBytes: reason.fault.prefixBytes
						},
						{
							role: stem,
							bytes: maxIdentifierBytes + 1,
							limit: maxIdentifierBytes,
							prefixBytes: s.rolePrefixBytes
						},
						"the refusal names the role, its bytes and the limit"
					)
					assert.ok(
						!roleInSpace(declaredSpace(s.rolePrefixBytes), stem).ok,
						"migrate would refuse the role under a prefix of the declared length"
					)
				}
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
			},
			{
				file: "packages/engine/src/core/identity.ts",
				original: "\tbound === 0 ? utf8Length(name) : prefixedBytes(bound, name)",
				replacement: "\tutf8Length(name)",
				why: "A role's bytes are read at its stem whatever the declared prefix, so a login whose role passes 63 bytes under the prefix resolves, and generate drafts a role migrate cuts short: the planted role past the limit is not refused."
			},
			{
				file: "packages/grizzle/src/cli/config.ts",
				original: "\t\t\treturn bytes > maxIdentifierBytes",
				replacement: "\t\t\treturn bytes >= maxIdentifierBytes",
				why: "A role of exactly 63 bytes under the declared prefix, which PostgreSQL keeps whole, is refused: the login planted at the limit does not resolve."
			},
			{
				file: "packages/engine/src/core/identity.ts",
				original: "\treturn bytes > bound ? bytes : undefined",
				replacement: "\treturn bytes > bound + 1 ? bytes : undefined",
				why: "A connection whose role prefix is a byte longer than the declared one is taken, under which a role the configuration admitted can pass 63 bytes: the connection past the bound is not refused."
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
				file: "packages/grizzle/src/cli/usage.ts",
				original: 'const isHelp = (arg: string): boolean => arg === "--help" || arg === "-h"',
				replacement: 'const isHelp = (arg: string): boolean => arg === "--help" || arg !== "-h"',
				why: "Operator mutant (comparison) in usage.ts isHelp, once args.ts's: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/grizzle/src/cli/run.ts",
				original: '\treturn stage === "config"',
				replacement: '\treturn stage === "usage"',
				why: "A refusal at stage config followed by a fix of the stage, the generic one that contradicts its own (a compile error's, an unrepresentable key's bound), and a usage error by none; the refused loadings fail."
			}
		]
	})
