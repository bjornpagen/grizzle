import { type Restriction, standard } from "@bjornpagen/devtools/preset"
import {
	CASE_LISTS,
	CLOCK_RULES,
	EVERY_FILE_RULES,
	MODULE_RULES,
	TEST_RULES
} from "@bjornpagen/testing/oxlint"
import { Array as Arr } from "effect"
import { defineConfig } from "oxlint"
import toolchain from "#toolchain.config.ts"

const { active, lintConfig } = standard(toolchain)

/**
 * The dictionary doors that mint (@bjornpagen/testing/dictionary's dictionary, which import-doors lets no other module
 * import): each holds the vocabularies of the test module beside it that are the domain itself, never cases a person
 * chose. The bench catalog's gate ids; the texts the grizzle skill documents; the repository's src modules and its
 * packages' entry points; the SQLSTATEs and failure sources a live call's error reads, and the live model's key forms;
 * the scalar namespace's plain descriptors and the ScalarTypes the test fixtures export; the world model's invalid kinds;
 * the registry's native operations and its operations over two sets; the integer carriers; the declared names the naming
 * door refuses and its alias pairs; and each type-tier box (test/types): the source's own roster of cells a box agreement
 * or a cost gate exhausts (every setting a config reader admits, every kind of a builder, every kind of base a contract
 * is over, every directive the README states, every probe of a scale program, every dimension a cost gate measures).
 */
const DICTIONARY_MINTS = [
	"test/types/schema/closed-subset.dictionary.ts",
	"test/pg/lower-conservative/vocabulary.dictionary.ts",
	"test/pg/scalar/registry.dictionary.ts",
	"test/pg/oracle/mutants/invalid.dictionary.ts",
	"test/types/api/anchor.dictionary.ts",
	"test/types/api/config.dictionary.ts",
	"test/types/api/contract-brand.dictionary.ts",
	"test/types/api/decoder.dictionary.ts",
	"test/types/api/fields.dictionary.ts",
	"test/types/api/handle.dictionary.ts",
	"test/types/api/names.dictionary.ts",
	"test/types/api/results.dictionary.ts",
	"test/types/api/surface.dictionary.ts",
	"test/types/api/untyped.dictionary.ts",
	"test/types/changeset/budget/members.dictionary.ts",
	"test/types/changeset/delete-where.dictionary.ts",
	"test/types/changeset/entry-owner.dictionary.ts",
	"test/types/changeset/insert-all-computed.dictionary.ts",
	"test/types/changeset/instants.dictionary.ts",
	"test/types/schema/stored-kinds.dictionary.ts",
	"test/types/schema/scoped-entries.dictionary.ts",
	"test/types/changeset/nesting.dictionary.ts",
	"test/types/changeset/generic-role.dictionary.ts",
	"test/types/compute/compute.dictionary.ts",
	"test/types/compute/time.dictionary.ts",
	"test/types/compute/calls.dictionary.ts",
	"test/types/compute/bound-arguments.dictionary.ts",
	"test/types/compute/hosted.dictionary.ts",
	"test/types/compute/finite.dictionary.ts",
	"test/types/compute/casts.dictionary.ts",
	"test/types/evidence/agreement.dictionary.ts",
	"test/types/evidence/closed-keys.dictionary.ts",
	"test/types/evidence/explicit.dictionary.ts",
	"test/types/evidence/generated-keys.dictionary.ts",
	"test/types/evidence/parameter.dictionary.ts",
	"test/types/examples/blocks.dictionary.ts",
	"test/types/examples/examples.dictionary.ts",
	"test/types/executor/boundary.dictionary.ts",
	"test/types/ir/semi-join.dictionary.ts",
	"test/types/query/budget/combinators.dictionary.ts",
	"test/types/query/budget/guards.dictionary.ts",
	"test/types/query/budget/invariance.dictionary.ts",
	"test/types/query/budget/keys.dictionary.ts",
	"test/types/query/budget/plain.dictionary.ts",
	"test/types/query/budget/scaling.dictionary.ts",
	"test/types/query/budget/sources.dictionary.ts",
	"test/types/query/budget/unions.dictionary.ts",
	"test/types/query/budget/workloads.dictionary.ts",
	"test/types/query/roster-generic.dictionary.ts",
	"test/types/query/take.dictionary.ts",
	"test/types/query/union-join.dictionary.ts",
	"test/types/schema/agreement.dictionary.ts",
	"test/types/schema/budget/extension.dictionary.ts",
	"test/types/schema/budget/families.dictionary.ts",
	"test/types/schema/budget/invariance.dictionary.ts",
	"test/types/schema/budget/levels.dictionary.ts",
	"test/types/schema/budget/login-lists.dictionary.ts",
	"test/types/schema/budget/logins.dictionary.ts",
	"test/types/schema/budget/records-fragment.dictionary.ts",
	"test/types/schema/budget/roles.dictionary.ts",
	"test/types/schema/budget/scaling.dictionary.ts",
	"test/types/schema/budget/served-records.dictionary.ts",
	"test/types/schema/generic.dictionary.ts",
	"test/types/schema/generic-base.dictionary.ts",
	"test/types/schema/drawn-types.dictionary.ts",
	"test/types/schema/refining-containment.dictionary.ts",
	"test/types/schema/exact-fields.dictionary.ts",
	"test/types/schema/fold-digests.dictionary.ts",
	"test/types/skeleton/budget/invariance.dictionary.ts",
	"test/types/text/regex.dictionary.ts",
	"test/unit/bench/harness.dictionary.ts",
	"test/unit/cli/skill.dictionary.ts",
	"test/unit/client/document.dictionary.ts",
	"test/unit/compute/bits.dictionary.ts",
	"test/unit/compute/evaluation.dictionary.ts",
	"test/unit/core/identity.dictionary.ts",
	"test/unit/core/limits.dictionary.ts",
	"test/unit/deps/deps.dictionary.ts",
	"test/unit/live/call-error.dictionary.ts",
	"test/unit/live/values.dictionary.ts",
	"test/pg/migrate/custom-guard.dictionary.ts",
	"test/unit/physical/membership.dictionary.ts",
	"test/unit/scalar/descriptors.dictionary.ts",
	"test/unit/scalar/registry.dictionary.ts",
	"test/unit/schema/dynamic.dictionary.ts",
	"test/unit/world-model/generate.dictionary.ts"
] as const

/**
 * The CLI generator's dictionary doors (packages/cli-generator), by their path in its package, whose import map names
 * them `#test/...`: each beside its test module, as DICTIONARY_MINTS are beside grizzle's.
 */
const GENERATOR_DICTIONARY_MINTS = [
	"test/check/document-set.dictionary.ts",
	"test/check/path-items.dictionary.ts",
	"test/generated/content-parameters.dictionary.ts",
	"test/generated/event-stream.dictionary.ts",
	"test/generated/lazy-root.dictionary.ts",
	"test/generated/object-parameters.dictionary.ts",
	"test/generated/printed-requests.dictionary.ts",
	"test/model/spec-section.dictionary.ts",
	"test/names/alias-cycles.dictionary.ts",
	"test/names/reserved-namespaces.dictionary.ts",
	"test/resolve/document-set.dictionary.ts",
	"test/runtime/sequential-media-parity.dictionary.ts",
	"test/validate/diagnostics.dictionary.ts",
	"test/validate/validate.dictionary.ts",
	"test/write/lock.dictionary.ts",
	"test/write/manifest.dictionary.ts"
] as const

/** Every dictionary door, by its path from the repository root: grizzle's and the CLI generator's. */
const DICTIONARY_MINT_FILES = [
	...DICTIONARY_MINTS,
	...Arr.map(GENERATOR_DICTIONARY_MINTS, (path) => `packages/cli-generator/${path}` as const)
] as const

/** DICTIONARY_MINTS as the package's import map names them. */
const DICTIONARY_MINTS_SPECIFIERS = Arr.map(DICTIONARY_MINTS, (path) => `#${path}` as const)

/**
 * The dictionary doors of test scope (no-case-list): modules whose exported lists are vocabularies the code branches
 * on, never cases a person chose, so a search may draw from a list imported from one. test/support/kernel/dict.ts holds
 * the identifier, literal and parameter-name dictionaries the generators draw beside their own; the oracle generator's
 * value domain (test/support/oracle/gen/domain.ts) its carriers, type specs, paddings and float specials; and
 * test/support/worlds/invalid/kinds.ts the world model's roster of invalid kinds, each by the boundary it crosses. A
 * test module's own vocabularies, minted with the testing library's dictionary(), are in a door beside it,
 * <name>.dictionary.ts (DICTIONARY_MINTS).
 */
const DICTIONARY_DOORS = [
	"#test/support/kernel/dict.ts",
	"#test/support/oracle/gen/domain.ts",
	"#test/support/worlds/invalid/kinds.ts",
	...DICTIONARY_MINTS_SPECIFIERS,
	...Arr.map(GENERATOR_DICTIONARY_MINTS, (path) => `#${path}` as const)
] as const

/** The engine's clock and scheduling ban, one message for every global it names. */
const NO_CLOCK = "The engine reads no clock and schedules nothing: a time it needs is an argument."

/** The engine's synchrony ban. */
const SYNCHRONOUS = "The engine is synchronous: it returns a value or a Result, never a Promise."

/** The engine's randomness ban. */
const NO_RANDOMNESS = "The engine draws no randomness: one input compiles to one output."

/** The engine's I/O ban. */
const NO_IO = "The engine does no I/O: the shell does."

/** The engine's environment ban, on the globals beside the preset's environment bans. */
const NO_ENVIRONMENT = "The engine reads no environment: what it needs is an argument."

/**
 * Bytes become text through one decoder (owner, 2026-11-15): a TextDecoder's defaults strip a leading U+FEFF and patch
 * malformed bytes with U+FFFD, so a decoder of a module's own reads another value than the bytes hold.
 */
const TEXT_DECODER = {
	name: "TextDecoder",
	message:
		"Bytes become text through @bjornpagen/grizzle-text/utf8 alone (utf8Text, utf8Chunks): it refuses bytes that are no UTF-8 and keeps a byte order mark, where a TextDecoder of its own strips a leading U+FEFF and may patch bytes with U+FFFD."
} as const

/** The globals the engine never reads, but the one decoder of bytes into text, which grizzle-text's utf8.ts alone builds. */
const ENGINE_GLOBALS = [
	{ name: "Date", message: NO_CLOCK },
	{ name: "performance", message: NO_CLOCK },
	{ name: "setTimeout", message: NO_CLOCK },
	{ name: "clearTimeout", message: NO_CLOCK },
	{ name: "setInterval", message: NO_CLOCK },
	{ name: "clearInterval", message: NO_CLOCK },
	{ name: "setImmediate", message: NO_CLOCK },
	{ name: "clearImmediate", message: NO_CLOCK },
	{ name: "queueMicrotask", message: SYNCHRONOUS },
	{ name: "Promise", message: SYNCHRONOUS },
	{ name: "process", message: NO_ENVIRONMENT },
	{ name: "fetch", message: NO_IO },
	{ name: "WebSocket", message: NO_IO },
	{ name: "crypto", message: NO_RANDOMNESS },
	{ name: "navigator", message: NO_ENVIRONMENT }
] as const

/** The engine's globals and the decoder's, which every module of the engine's packages is refused but utf8.ts. */
const ENGINE_AND_DECODER = [...ENGINE_GLOBALS, TEXT_DECODER] as const

/** Effect Schema's modules, as the effect barrel exports them. */
const SCHEMA_MODULES = [
	"Schema",
	"SchemaAST",
	"SchemaGetter",
	"SchemaIssue",
	"SchemaParser",
	"SchemaRepresentation",
	"SchemaTransformation"
] as const

/** grizzle parses JSON once and trusts it (owner, 2026-11-04): Effect Schema types values, and never runs in src. */
const NO_RUNTIME_SCHEMA =
	"Effect Schema is for types, never runtime validation (owner, 2026-11-04): JSON grizzle trusts goes through #compiler/core/trusted.ts, a foreign value through a narrowing reader of its own, an error is a Data.TaggedError; a Schema used only as a type is `import type`."

/** Effect Schema at run time, from the barrel or a subpath; a type-only import passes. */
const SCHEMA_IMPORTS = {
	path: {
		name: "effect",
		importNames: SCHEMA_MODULES,
		allowTypeImports: true,
		message: NO_RUNTIME_SCHEMA
	},
	pattern: {
		group: [
			"effect/Schema",
			"effect/SchemaAST",
			"effect/SchemaGetter",
			"effect/SchemaIssue",
			"effect/SchemaParser",
			"effect/SchemaRepresentation",
			"effect/SchemaTransformation"
		],
		allowTypeImports: true,
		message: NO_RUNTIME_SCHEMA
	}
} as const

const PLATFORM_SDKS = {
	group: ["@vercel/*", "@aws-sdk/*"],
	message:
		"src loads no platform's SDK: the caller wires Vercel's pool and AWS's token signer through DbConfig.attachPool and DbConfig.password."
} as const

/**
 * The library's imports, which every file is held to but the tiers' (test, bench, scripts, the cluster's package), the
 * README's application and the engine's, whose restrictions state their own: no Effect Schema at run time and no
 * platform's SDK (zod is the preset's, banned everywhere). The preset holds the shell's src to these and its
 * environment imports together.
 */
const LIBRARY_IMPORTS = {
	paths: [SCHEMA_IMPORTS.path],
	patterns: [PLATFORM_SDKS, SCHEMA_IMPORTS.pattern]
} as const

/**
 * The registry's and the builders' readings of a descriptor, which no public reading of a field imports: a relation's
 * drawn, accumulated, retirement, generated or slot field is no descriptor a builder registered, so each reading of a
 * field describes it through schema/relation.ts describeDeclared, as its declared type, the one its column is.
 */
const FIELD_READINGS = [
	{
		name: "#compiler/scalar/registry.ts",
		importNames: ["describeField", "describeFieldOrThrow", "registeredField"],
		message:
			"A public reading of a field describes it through describeDeclared (#compiler/schema/relation.ts), which reads a drawn, accumulated, retirement, generated or slot field as its declared type, as its column is."
	},
	{
		name: "#compiler/schema/protocol.ts",
		importNames: ["describedField", "fieldDescOf"],
		message:
			"A public reading of a field describes it through describeDeclared (#compiler/schema/relation.ts), which reads a drawn, accumulated, retirement, generated or slot field as its declared type, as its column is."
	}
] as const

/**
 * The engine's imports: no Effect at run time, no Node module but `crypto`, the one a module of `hashing` may import,
 * no driver and no platform SDK; and `readings`, the readings of a descriptor its module may not import.
 */
const engineImports = (
	hashing: "hashing" | "no Node module",
	readings: ReadonlyArray<(typeof FIELD_READINGS)[number]>
): Restriction["restrictedImports"] => ({
	paths: [
		...readings,
		{
			name: "effect",
			allowTypeImports: true,
			message:
				"The engine loads no Effect at run time: use its native forms (T | undefined for absence, #compiler/core/result.ts) and import Effect's types with `import type`."
		},
		SCHEMA_IMPORTS.path
	],
	patterns: [
		SCHEMA_IMPORTS.pattern,
		{
			group: ["effect/*", "@effect/*"],
			allowTypeImports: true,
			message: "The engine loads no Effect at run time: import Effect's types with `import type`."
		},
		{
			group: hashing === "hashing" ? ["node:*", "!node:crypto"] : ["node:*"],
			message:
				"The engine loads no Node module but node:crypto, which core/sha256.ts and core/seal.ts alone import, so every module a browser loads, which never reaches them (.fallowrc.json's browser zones), loads none."
		},
		{ group: ["pg", "pg/*"], message: NO_IO },
		PLATFORM_SDKS
	]
})

/**
 * grizzle's lists, each on the files it holds, in order: a file several name takes the last one's whole, beside the
 * preset's shared bans and the environment and Effect-free bans of its place. Every file is held to the library's
 * imports and the one decoder of bytes into text; the tiers drop the platform's SDKs, which a test or a bench wires as
 * a caller does, and the README's application drops Effect Schema too; the engine and the packages it shares its bans
 * with (grizzle-openapi, which reads it, and grizzle-text, dependency-free and browser-safe) take the engine's imports
 * and globals, no Effect at run time, no Node module, no clock, randomness or I/O; utf8.ts builds the decoder every
 * other module is refused; the hashing modules import node:crypto; and the public readings of a field import none of a
 * descriptor's other readings.
 */
const RESTRICTIONS: ReadonlyArray<Restriction> = [
	{
		paths: ["./"],
		restrictedImports: LIBRARY_IMPORTS,
		restrictedGlobals: [TEXT_DECODER],
		restrictedProperties: []
	},
	{
		paths: ["test/", "bench/", "scripts/", "packages/pg/"],
		restrictedImports: { paths: [SCHEMA_IMPORTS.path], patterns: [SCHEMA_IMPORTS.pattern] },
		restrictedGlobals: [TEXT_DECODER],
		restrictedProperties: []
	},
	{
		/** The README's application decodes a foreign HTTP body with Effect Schema: the app's choice, which the README shows. */
		paths: ["test/types/examples/fixtures/readme.ts"],
		restrictedImports: { paths: [], patterns: [] },
		restrictedGlobals: [TEXT_DECODER],
		restrictedProperties: []
	},
	{
		paths: ["packages/engine/", "packages/openapi/", "packages/text/"],
		restrictedImports: engineImports("no Node module", []),
		restrictedGlobals: ENGINE_AND_DECODER,
		restrictedProperties: []
	},
	{
		/** The one decoder of bytes into text: it builds the TextDecoder every other module is refused. */
		paths: ["packages/text/src/utf8.ts"],
		restrictedImports: engineImports("no Node module", []),
		restrictedGlobals: ENGINE_GLOBALS,
		restrictedProperties: []
	},
	{
		/** The engine's hashing modules: SHA-256 and AES-256-GCM over node:crypto, which no browser zone reaches. */
		paths: ["packages/engine/src/core/sha256.ts", "packages/engine/src/core/seal.ts"],
		restrictedImports: engineImports("hashing", []),
		restrictedGlobals: ENGINE_AND_DECODER,
		restrictedProperties: []
	},
	{
		/** The engine's public readings of a field and the programs they read: each describes a field as its declared type. */
		paths: ["packages/engine/src/public/", "packages/engine/src/program/"],
		restrictedImports: engineImports("no Node module", FIELD_READINGS),
		restrictedGlobals: ENGINE_AND_DECODER,
		restrictedProperties: []
	}
]

/** The markers of the naming rule's production identifiers, which a test or a bench names through the naming door. */
const NAME_MARKERS = [
	"__pk",
	"__fk__",
	"__key__",
	"__check",
	"__ix__",
	"__law_",
	"__text_",
	"__norm__",
	"__stats__",
	"__migrations"
] as const

/**
 * A name React's isHookName does not read as a hook's, /^use[A-Z0-9]/: a consumer's React Compiler compiles grizzle's
 * source and refuses a conditional call of anything named like a hook, and grizzle has no hooks. id-match takes no
 * look-ahead, so the pattern spells every other start.
 */
const HOOK_FREE_NAME = "^(?:[^u]|u$|u[^s]|us$|us[^e]|use$|use[^A-Z0-9])"

const ASSERTIONS_MESSAGE =
	"Import assertions from @bjornpagen/testing/assert (grizzle's own from #test/support/assert.ts): its equalities type the expected value by the actual one."

/** grizzle's lists for the shared standard; everything else comes from the dev tools' preset. */
export default defineConfig(
	lintConfig({
		ignorePatterns: [
			"packages/*/types/**",
			"test/types/**/.*-??????/**",
			"vendor/**",
			"packages/cli-generator/test/fixtures/**"
		],
		restrictedImports: { paths: [], patterns: [] },
		restrictedGlobals: [],
		restrictedProperties: [],
		restrictions: RESTRICTIONS,
		unassignedImports: [],
		environment: {
			library: ["packages/engine/src", "packages/grizzle/src", "packages/openapi/src"],
			/**
			 * The connection's one reader of the environment, which refuses the variables node-postgres would send at a
			 * session's startup; the command line's bin, which reads its own arguments to answer the usage before it loads
			 * the command line; and the command line's module, which its bin loads, and which reads its own arguments and
			 * working directory and passes them on as its program's input.
			 */
			readers: [
				"packages/grizzle/src/adapter/connection/environment.ts",
				"packages/grizzle/src/cli/bin.ts",
				"packages/grizzle/src/cli/main.ts"
			]
		},
		ceremony: [
			"test/**",
			"bench/**",
			"scripts/**",
			"packages/pg/**",
			"packages/cli-generator/test/**",
			"packages/cli-generator/scripts/**",
			"packages/cli-generator/corpus/tools/**"
		],
		plugin: {
			"bearer-owners": {
				owners: [
					"packages/grizzle/src/client/call.ts",
					"test/pg/live/errors.test.ts",
					"packages/cli-generator/src/runtime-src/runtime/auth.ts"
				]
			},
			"side-effect-free": {
				modules: [
					{
						file: "packages/engine/src/core/brand.ts",
						specifiers: ["#compiler/core/brand.ts"],
						functions: [{ name: "nominal", returns: "functions", invokes: [] }],
						constants: []
					},
					{
						file: "vendor/toolchain/packages/limit/src/limit.ts",
						specifiers: [],
						functions: [
							{ name: "published", returns: "values", invokes: [] },
							{ name: "measured", returns: "values", invokes: [] },
							{
								name: "derived",
								returns: "values",
								invokes: [{ parameter: 0, property: "compute" }]
							},
							{ name: "provisional", returns: "values", invokes: [] }
						],
						constants: []
					},
					{
						file: "packages/engine/src/core/seal.ts",
						specifiers: ["#compiler/core/seal.ts"],
						functions: [],
						constants: ["sealNonceBytes", "sealTagBytes"]
					}
				]
			},
			"import-doors": {
				doors: [
					{
						module: "node:assert",
						guards: { kind: "module" },
						doors: [],
						message: ASSERTIONS_MESSAGE
					},
					{
						module: "node:assert/strict",
						guards: { kind: "module" },
						doors: [],
						message: ASSERTIONS_MESSAGE
					},
					{
						module: "node:util",
						guards: { kind: "exports", names: ["isDeepStrictEqual"] },
						doors: [],
						message: "Use the typed deepEquals of @bjornpagen/testing/assert."
					},
					{
						module: "@bjornpagen/testing/dictionary",
						guards: { kind: "exports", names: ["dictionary"] },
						doors: DICTIONARY_MINT_FILES,
						message:
							"A dictionary is minted in a dictionary door beside its test module, <name>.dictionary.ts, listed in oxlint.config.ts DICTIONARY_MINTS (GENERATOR_DICTIONARY_MINTS for the CLI generator): a vocabulary that is the domain itself, never cases a person chose."
					}
				]
			},
			"brands-sole-mint": {
				mints: [
					{
						doors: ["packages/engine/src/core/identity.ts"],
						brands: [
							"LawId",
							"RelationIdent",
							"ColumnIdent",
							"ConstraintName",
							"IndexName",
							"DomainName",
							"TriggerName",
							"LawFunctionName"
						]
					},
					{
						doors: ["packages/engine/src/sql/emit.ts", "test/support/sql.ts"],
						brands: ["EmittedText"]
					},
					{ doors: ["packages/grizzle/src/adapter/migrate/input.ts"], brands: ["MigrationText"] },
					{ doors: ["packages/engine/src/runtime/explain.ts"], brands: ["ExplainText"] },
					{ doors: ["packages/engine/src/core/fingerprint.ts"], brands: ["ConstantDigest"] },
					{ doors: ["packages/engine/src/codec/recordset.ts"], brands: ["NormalFacts"] },
					{ doors: ["packages/engine/src/ir/desc.ts"], brands: ["AdmittedClosedRelation"] },
					{
						doors: ["packages/engine/src/runtime/write/normalize.ts"],
						brands: ["KeyNormalized"]
					},
					{ doors: ["packages/engine/src/codec/bits.ts"], brands: ["Accumulator"] },
					{
						doors: [
							"packages/engine/src/codec/scalar.ts",
							"packages/engine/src/codec/recordset.ts",
							"test/support/wire.ts"
						],
						brands: ["ParamText"]
					},
					{
						doors: [
							"packages/engine/src/runtime/lower/fused.ts",
							"packages/engine/src/runtime/write/refusal.ts",
							"packages/engine/src/scalar/values/convert.ts",
							"test/support/wire.ts"
						],
						brands: ["OutputText"]
					},
					{ doors: ["packages/grizzle/src/adapter/wire/session.ts"], brands: ["OutputRows"] },
					{
						doors: [
							"packages/engine/src/sql/type-schemas.ts",
							"packages/grizzle/src/adapter/admission/drift.ts",
							"test/support/sql.ts"
						],
						brands: ["TypeSchema"]
					}
				]
			},
			"no-raw-sql": { sources: [], writers: [] },
			"no-spread-argument": {
				tuples: [
					{ module: "#test/support/list.ts", names: ["argumentsOf", "nonEmptyArgumentsOf"] },
					{ module: "#compiler/allen/atoms.ts", names: ["atomOperands"] }
				]
			},
			"no-case-list": {
				searches: [
					...CASE_LISTS.searches,
					{ module: "#test/support/oracle/runner.ts", name: "oracleCheck", space: { argument: 0 } },
					{ module: "#test/support/oracle/runner.ts", name: "oracleKill", space: { argument: 0 } },
					{ module: "#test/types/batch/agreement.ts", name: "agreement", space: { argument: 0 } },
					{ module: "#test/types/batch/agreement.ts", name: "boxAgreement", space: { argument: 0 } }
				],
				generators: CASE_LISTS.generators,
				mints: CASE_LISTS.mints,
				cases: [],
				dictionaries: DICTIONARY_DOORS
			},
			"single-permit-owners": {
				owners: [
					{
						file: "test/support/pg.ts",
						reason:
							"A session's turn (connectOnce's `turn`): one connection's wire carries one statement and its answer at a time, so a session's statements take turns on it."
					},
					{
						file: "test/pg/fin/installed.ts",
						reason:
							"seatPool makes its seats one at a time: two installations migrating at once into one database fail, one of them with XX000 (tuple concurrently updated) in its publish step."
					},
					{
						file: "packages/cli-generator/test/support/connection.ts",
						reason:
							"A listener's observations take turns (makeSessions' observe): its one port serves the current observation's state, so a connection it accepts is served under the observation that made it; two observations at once would serve one's connections under the other's state."
					}
				]
			},
			"no-dynamic-imports": {
				allowed: [
					{ file: "packages/grizzle/src/cli/bin.ts", specifier: "#cli/main.ts" },
					{ file: "packages/grizzle/src/cli/main.ts", specifier: "grizzle:config" },
					{ file: "test.config.ts", specifier: "#test/support/mutation/mutation.ts" }
				]
			},
			"test-no-prose-search": {
				fields: ["capability", "what"],
				textHelpers: ["containsText", "lacksText", "contains", "lacks"],
				searchHelpers: ["contains", "containsText"]
			},
			"test-no-spelled-names": { markers: NAME_MARKERS }
		},
		ownPlugins: [],
		tests: {
			library: "installed",
			jsPlugin: "@bjornpagen/testing/oxlint",
			rules: TEST_RULES,
			modules: MODULE_RULES,
			everyFile: EVERY_FILE_RULES,
			clock: { files: ["test/**", "packages/cli-generator/test/**"], rules: CLOCK_RULES }
		},
		overrides: [
			{
				files: ["packages/cli-generator/test/support/capture-server.ts"],
				rules: active({
					/** The capture server plays its script: a scripted response's delay and each chunk's delay are what the property drew for the server to do (an idle stream, a late answer), the behaviour the generated CLI is checked against, never a wait for a fact. */
					"testing/no-sleep-wait": "off"
				})
			},
			{
				/** The engine, grizzle-openapi and grizzle-text, which load no Effect at run time: `import type { T } from "effect"` passes allowTypeImports, but type stripping leaves `import {} from "effect"`, which loads Effect at run time. */
				files: ["packages/engine/**", "packages/openapi/**", "packages/text/**"],
				rules: active({ "typescript/no-import-type-side-effects": "error" })
			},
			{
				/** The one decoder of bytes into text reads a fatal decoder's refusal of malformed bytes, a thrown TypeError, the platform's one signal of it. */
				files: ["packages/text/src/utf8.ts"],
				rules: active({ "devtools/no-try": "off" })
			},
			{
				files: ["packages/engine/src/query/build/scope.ts"],
				rules: active({
					/** The query builder's hygiene: the build running now, which a variable minted in a rule's callback records and every later use checks, through callbacks that take no argument for it. */
					"devtools/no-module-state": "off"
				})
			},
			{
				files: ["test/support/kernel/long-keys.ts"],
				rules: active({
					/** A count of native keyings: it replaces Map's and Set's keying methods while one effect runs, each calling the native it saved, and restores them after (lengthHashedKeyings), the one way to see which keys a native Map or Set hashes. */
					"eslint/no-extend-native": "off",
					"typescript/unbound-method": "off"
				})
			},
			{
				files: ["test/pg/serverless/support.ts"],
				rules: active({
					/** A test plays Vercel's runtime: it installs Vercel's request context on the global object, where @vercel/functions reads it, and restores it after. */
					"devtools/no-module-state": "off"
				})
			},
			{
				/** No declaration of the source a consumer compiles is named like a React hook (HOOK_FREE_NAME). */
				files: ["packages/engine/src/**", "packages/grizzle/src/**", "packages/openapi/src/**"],
				rules: active({
					"eslint/id-match": [
						"error",
						HOOK_FREE_NAME,
						{ properties: true, classFields: true, onlyDeclarations: true }
					]
				})
			},
			{
				/** A package's entry points are its public surface, each the modules it re-exports: its index, and grizzle's runtime entry, @bjornpagen/grizzle/runtime. */
				files: ["packages/*/src/index.ts", "packages/grizzle/src/runtime.ts"],
				rules: active({ "oxc/no-barrel-file": "off" })
			},
			{
				/** The engine's internal exports are its compiled outputs, each one module that re-exports what the shell reads of it. */
				files: ["packages/engine/src/plan/*.ts"],
				rules: active({ "oxc/no-barrel-file": "off" })
			},
			{
				files: ["packages/engine/src/types/**"],
				rules: active({
					/** The type layer declares the public API's signatures, whose optional and defaulted parameters are the API. */
					"devtools/no-default-parameter": "off",
					"devtools/no-optional-parameter": "off",
					"devtools/no-switch-default-bailout": "off",
					"devtools/no-try": "off",
					"devtools/no-new-error": "off"
				})
			},
			{
				files: ["packages/text/src/base/invariant.ts", "packages/engine/src/core/loc.ts"],
				rules: active({ "devtools/no-new-error": "off" })
			},
			{
				files: [
					"packages/engine/src/core/canonical.ts",
					"packages/engine/src/core/host.ts",
					"packages/engine/src/ir/shape.ts",
					"packages/text/src/base/result.ts"
				],
				rules: active({ "devtools/no-try": "off" })
			},
			{
				files: ["packages/engine/src/ir/shape.ts"],
				rules: active({
					/** Every shape's decode is a generator, so its driver runs them all alike on a stack on the heap: a leaf's waits on no part and answers at once, without a yield. */
					"eslint/require-yield": "off"
				})
			},
			{
				files: ["packages/engine/src/core/trusted.ts"],
				rules: active({
					/** trustedJson's T is the type its caller names for trusted JSON text: the door's whole purpose. */
					"typescript/no-unnecessary-type-parameters": "off",
					/** The one door from JSON text to a typed value (owner, 2026-11-04): parsed once, trusted, never validated. */
					"typescript/consistent-type-assertions": "off"
				})
			},
			{
				files: ["packages/engine/src/types/core/identical.ts"],
				rules: active({
					/** Identical's T is the probe of the checker's identity relation, the one way TypeScript compares two types for identity rather than assignability. */
					"typescript/no-unnecessary-type-parameters": "off"
				})
			},
			{
				files: ["packages/engine/src/schema/record.ts"],
				rules: active({
					/** assembled's R and describedHeading's C are the types the module's one assertion gives a record built key by key: TypeScript cannot derive them, so their callers name them. */
					"typescript/no-unnecessary-type-parameters": "off",
					/** The one sanctioned assertion: TypeScript cannot type a record built key by key as a homomorphic mapped type over its parts: an index write into a generic mapped type is refused, Object.fromEntries forgets the keys, and a computed generic key widens to an index signature; each value comes from the field under its key through a closure TypeScript checks, and the keys are distinct. */
					"typescript/consistent-type-assertions": "off"
				})
			},
			{
				files: ["packages/engine/src/types/fields/regex.ts"],
				rules: active({
					/** Record<never, never> stands in a conditional type's check position as a type-level probe of whether a key is a literal, a type no value holds. */
					"typescript/no-generated-empty-object-type": "off"
				})
			},
			{
				files: ["test/pg/oracle/mutants/invalid.test.ts"],
				rules: active({
					/** Its space is the oracle's seven invalid mutants (test/support/oracle/mutants/mutants.ts), each a hand-made flaw the harness must kill: the list is a kill set, which the conversion states as kills on the oracle's property. */
					"devtools/no-case-list": "off"
				})
			},
			{
				files: ["bench/query/support/kit.ts"],
				rules: active({
					/** The query bench's kit times a compile and its warm runs: the clock is what a bench measures, and bench is its own tool beside the tests, which the test scope reaches only through its support/ directory's name. */
					"testing/no-wall-clock-verdict": "off"
				})
			},
			{
				files: ["bench/write/support/writes.ts"],
				rules: active({
					/** The write bench's harness times a run (timed): the clock is what a bench measures, and bench is its own tool beside the tests, which the test scope reaches only through its support/ directory's name. */
					"testing/no-wall-clock-verdict": "off",
					/** It samples a role's sessions in pg_stat_activity on an interval while a run goes, and the samples, each an interval apart, are the measurement (lockWaitSessionMs). */
					"testing/no-sleep-wait": "off"
				})
			},
			{
				files: ["test/pg/physical/serving.ts"],
				rules: active({
					/** loadAtVolume's settle wait observes the horizon's holders (holdersBefore) at PostgreSQL's own step for a wait on another backend (backendWaitStep, published), so it checks the server's state no more often than the server checks its own, where awaitFact would query it back to back. */
					"testing/no-sleep-wait": "off"
				})
			},
			{
				files: ["test/support/with-layer.ts"],
				rules: active({
					/** withLayer is the one Function.dual kept: 57 pipe uses call it data-last, and a dual's type is two call signatures. */
					"devtools/no-overload": "off"
				})
			},
			{
				files: ["test/support/assert.ts"],
				rules: active({
					/** A defect is an Error raised by grizzle's invariants (throwsDefect), which no typeof check sees. */
					"unicorn/no-instanceof-builtins": "off"
				})
			},
			{
				files: ["test/**", "bench/**"],
				rules: active({
					/** A test's support modules and a bench name production identifiers through the naming door too. */
					"devtools/test-no-spelled-names": ["error", { markers: NAME_MARKERS }]
				})
			},
			{
				files: ["test/support/kernel/naming.ts"],
				rules: active({ "devtools/test-no-spelled-names": "off" })
			},
			{
				files: [
					"test/pg/values/money.test.ts",
					"test/pg/values/numeric.fixtures.ts",
					"test/pg/values/numeric.test.ts",
					"test/unit/schema/constructors.fixtures.ts",
					"test/unit/values/decimal.test.ts"
				],
				rules: active({
					/** These suites hold grizzle's text to the text PostgreSQL prints, and a decimal to its canonical text, whose scale is part of the value: the text is the contract under test. */
					"testing/no-serialized-comparison": "off"
				})
			},
			{
				files: ["test/pg/sql/print.test.ts", "test/unit/substrate/substrate.test.ts"],
				rules: active({
					/** The message is the data under test: the text a printed RAISE carries, and PostgreSQL's verbose report as parsed. */
					"testing/no-error-prose": "off"
				})
			},
			{
				files: ["test/unit/schema/constructors.test.ts"],
				rules: active({
					/** A relation's fields are its heading in declaration order, which these suites assert. */
					"testing/no-ordered-unordered": "off"
				})
			},
			{
				files: [
					"bench/cold/probe.ts",
					"bench/harness/runner.ts",
					"test/unit/deps/runtime-probe.ts"
				],
				rules: active({
					/** The cold probe times a first load, the bench runner loads the bench files it runs, and the runtime probe loads each module under its trap. */
					"devtools/no-dynamic-imports": "off"
				})
			},
			{
				files: [
					"bench/dfa/main.ts",
					"bench/query/fusion.bench.ts",
					"bench/query/page.bench.ts",
					"bench/query/spans.bench.ts",
					"bench/query/workload.bench.ts",
					"bench/queue/claim.bench.ts",
					"bench/write/changeset.bench.ts",
					"bench/write/containment.bench.ts",
					"bench/write/insert.bench.ts",
					"bench/write/normalize.bench.ts",
					"bench/write/refresh.bench.ts"
				],
				rules: active({})
			},
			{
				files: ["test/types/**"],
				rules: active({
					/** Type tests assert exact-equality types, whose type parameters are the point. */
					"typescript/no-unnecessary-type-parameters": "off",
					/** Type tests use `{}` fixtures. */
					"typescript/no-empty-object-type": "off",
					"devtools/no-default-parameter": "off",
					"devtools/no-optional-parameter": "off"
				})
			},
			{
				files: ["test/types/**/fixtures/**"],
				rules: active({
					/** A type test's refusal is a `@ts-expect-error` that names what it refuses. */
					"typescript/ban-ts-comment": [
						"error",
						{
							"ts-check": true,
							"ts-expect-error": "allow-with-description",
							"ts-ignore": true,
							"ts-nocheck": true
						}
					]
				})
			},
			{
				files: ["test/unit/deps/fixtures/planted-regex.ts"],
				rules: active({
					/** The negative control constructs through the global RegExp and calls the native String.prototype.match, each on its own line. */
					"devtools/no-raw-regexp": "off",
					"typescript/prefer-regexp-exec": "off"
				})
			},
			{
				files: ["test/types/examples/fixtures/readme.ts", "test/types/examples/fixtures/skill.ts"],
				rules: active({
					/** The fixture mirrors README.md's code blocks line for line, and the README's app code is a reader's, written with the platform's regex literal. */
					"devtools/no-raw-regexp": "off"
				})
			},
			{
				files: ["test/unit/deps/runtime-probe.ts"],
				rules: active({
					/** The trap forwards to the native exec with the receiver it is called on. */
					"typescript/unbound-method": "off",
					/** The positive control constructs through the trapped global RegExp. */
					"devtools/no-raw-regexp": "off",
					/** The trap forwards a call to the native function with the arguments it was called with, a list no syntax sizes. */
					"devtools/no-spread-argument": "off"
				})
			},
			{
				files: ["test/types/examples/fixtures/readme.ts"],
				rules: active({
					/** A refusal fixture's return is refused by construction: the value is the checker's error type. */
					"typescript/no-unsafe-return": "off"
				})
			}
		]
	})
)
