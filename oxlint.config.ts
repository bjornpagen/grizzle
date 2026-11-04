import { active, lintConfig, restrictedImports } from "@grizzle/devtools/preset"
import { CLOCK_RULES, TEST_RULES } from "@grizzle/testing/oxlint"
import { defineConfig } from "oxlint"

/** The engine's clock and scheduling ban, one message for every global it names. */
const NO_CLOCK = "The engine reads no clock and schedules nothing: a time it needs is an argument."

/** The engine's synchrony ban. */
const SYNCHRONOUS = "The engine is synchronous: it returns a value or a Result, never a Promise."

/** The engine's randomness ban. */
const NO_RANDOMNESS = "The engine draws no randomness: one input compiles to one output."

/** The engine's I/O ban. */
const NO_IO = "The engine does no I/O: the shell does."

const ZOD = {
	name: "zod",
	message:
		'Zod is banned. Admit outside values with Effect Schema (`import { Schema } from "effect"`).'
} as const

const PLATFORM_SDKS = {
	group: ["@vercel/*", "@aws-sdk/*"],
	message:
		"src loads no platform's SDK: the caller wires Vercel's pool and AWS's token signer through DbConfig.attachPool and DbConfig.password."
} as const

/** The engine's imports: no Effect at run time, no Node module but node:crypto, no driver and no platform SDK. */
const engineImports = () =>
	restrictedImports({
		paths: [
			{
				name: "zod",
				message:
					"Zod is banned. The engine admits a description through its own decoder (ir/shape.ts), which refuses a malformed one with MalformedDescription."
			},
			{
				name: "effect",
				allowTypeImports: true,
				message:
					"The engine loads no Effect at run time: use its native forms (T | undefined for absence, #compiler/core/result.ts) and import Effect's types with `import type`."
			}
		],
		patterns: [
			{
				group: ["effect/*", "@effect/*"],
				allowTypeImports: true,
				message: "The engine loads no Effect at run time: import Effect's types with `import type`."
			},
			{
				group: ["node:*", "!node:crypto"],
				message: "The engine loads no Node module but node:crypto, which core hashes with."
			},
			{ group: ["pg", "pg/*"], message: NO_IO },
			PLATFORM_SDKS
		]
	})

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

const ASSERTIONS_MESSAGE =
	"Import assertions from #test/support/assert.ts: its equalities type the expected value by the actual one."

/** grizzle's lists for the shared standard; everything else comes from the dev tools' preset. */
export default defineConfig(
	lintConfig({
		ignorePatterns: [
			"packages/*/dist/**",
			"packages/*/types/**",
			"packages/devtools/src/*/fixtures/**",
			"test/types/**/.*-??????/**"
		],
		restrictedImports: { paths: [ZOD], patterns: [] },
		restrictedGlobals: [],
		restrictedProperties: [],
		unassignedImports: [],
		effectFree: ["packages/engine/**"],
		ceremony: ["test/**", "bench/**", "scripts/**", "packages/devtools/**"],
		plugin: {
			"import-doors": {
				doors: [
					{
						module: "node:assert",
						guards: { kind: "module" },
						doors: ["test/support/assert.ts"],
						message: ASSERTIONS_MESSAGE
					},
					{
						module: "node:assert/strict",
						guards: { kind: "module" },
						doors: ["test/support/assert.ts"],
						message: ASSERTIONS_MESSAGE
					},
					{
						module: "node:util",
						guards: { kind: "exports", names: ["isDeepStrictEqual"] },
						doors: ["test/support/assert.ts"],
						message: "Use the typed deepEqual of #test/support/assert.ts."
					},
					{
						module: "#adapter/boundary/names.ts",
						guards: { kind: "exports", names: ["nameSchemas"] },
						doors: [
							"packages/grizzle/src/adapter/boundary/snapshot.ts",
							"packages/grizzle/src/adapter/errors/execution.ts",
							"packages/grizzle/src/adapter/errors/failures.ts",
							"test/support/kernel/naming.ts",
							"test/support/catalog/read.ts",
							"test/support/substrate/errors.ts",
							"test/support/pg.ts"
						],
						message:
							"Names are admitted only at a decode boundary: the shell's snapshot decoder and error schemas (packages/grizzle/src/adapter/boundary, adapter/errors), and in tests the naming door, the catalog reader and the pg error readers (test/support)."
					},
					{
						module: "#test/support/kernel/naming.ts",
						guards: { kind: "exports", names: ["spelled"] },
						doors: ["test/unit/adapter/witness.test.ts"],
						message: "Spelled names are for the naming rule's specification tests."
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
					{
						doors: [
							"packages/engine/src/physical/ddl/names.ts",
							"packages/grizzle/src/adapter/boundary/sql.ts",
							"packages/grizzle/src/adapter/admission/drift.ts",
							"test/support/sql.ts"
						],
						brands: ["TypeSchema"]
					}
				]
			},
			"no-raw-sql": {
				sources: [
					"packages/engine/src",
					"packages/grizzle/src",
					"packages/testing/src",
					"packages/devtools/src"
				],
				writers: ["packages/engine/src/sql/print.ts", "packages/engine/src/sql/lexer.ts"]
			},
			"no-dynamic-imports": {
				allowed: [{ file: "packages/grizzle/src/cli/main.ts", specifier: "grizzle:config" }]
			},
			"test-no-prose-search": {
				fields: ["capability", "what"],
				textHelpers: ["containsText", "lacksText", "contains", "lacks"],
				searchHelpers: ["contains", "containsText"]
			},
			"test-no-spelled-names": { markers: NAME_MARKERS }
		},
		tests: {
			jsPlugin: "@grizzle/testing/oxlint",
			rules: TEST_RULES,
			clock: { files: ["packages/testing/src/**", "test/**"], rules: CLOCK_RULES }
		},
		overrides: [
			{
				files: ["packages/engine/**"],
				rules: active({
					"eslint/no-restricted-globals": [
						"error",
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
						{
							name: "process",
							message: "The engine reads no environment: what it needs is an argument."
						},
						{ name: "fetch", message: NO_IO },
						{ name: "WebSocket", message: NO_IO },
						{ name: "crypto", message: NO_RANDOMNESS }
					],
					"eslint/no-restricted-imports": engineImports(),
					/** `import { type T } from "effect"` passes allowTypeImports, but type stripping leaves `import {} from "effect"`, which loads Effect at run time. */
					"typescript/no-import-type-side-effects": "error"
				})
			},
			{
				files: ["packages/grizzle/**"],
				rules: active({
					"eslint/no-restricted-imports": restrictedImports({
						paths: [ZOD],
						patterns: [PLATFORM_SDKS]
					})
				})
			},
			{
				files: ["packages/*/src/index.ts"],
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
				files: ["packages/engine/src/core/invariant.ts", "packages/engine/src/core/loc.ts"],
				rules: active({ "devtools/no-new-error": "off" })
			},
			{
				files: [
					"packages/engine/src/core/canonical.ts",
					"packages/engine/src/core/host.ts",
					"packages/engine/src/ir/shape.ts"
				],
				rules: active({ "devtools/no-try": "off" })
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
				files: ["packages/engine/src/schema/record.ts"],
				rules: active({
					/** assembled's R and describedHeading's C are the types the module's one assertion gives a record built key by key: TypeScript cannot derive them, so their callers name them. */
					"typescript/no-unnecessary-type-parameters": "off",
					/** The one sanctioned assertion: TypeScript cannot type a record built key by key as a homomorphic mapped type over its parts: an index write into a generic mapped type is refused, Object.fromEntries forgets the keys, and a computed generic key widens to an index signature; each value comes from the field under its key through a closure TypeScript checks, and the keys are distinct. */
					"typescript/consistent-type-assertions": "off"
				})
			},
			{
				files: ["packages/engine/src/text/field.ts"],
				rules: active({
					/** Record<never, never> stands in a conditional type's check position as a type-level probe of whether a key is a literal, a type no value holds. */
					"typescript/no-generated-empty-object-type": "off"
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
					/** A boxed primitive is an object of its wrapper class, which no typeof check sees. */
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
				files: ["test/support/kernel/naming.ts", "test/unit/adapter/witness.test.ts"],
				rules: active({ "devtools/test-no-spelled-names": "off" })
			},
			{
				files: [
					"test/pg/allen/table.test.ts",
					"test/pg/page/values.test.ts",
					"test/pg/values/money.test.ts",
					"test/pg/values/numeric.test.ts",
					"test/pg/vector/exact/distance.test.ts",
					"test/unit/cursor/codec.test.ts",
					"test/unit/schema/constructors.test.ts",
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
				files: ["test/unit/derived/fields.test.ts", "test/unit/schema/constructors.test.ts"],
				rules: active({
					/** A relation's fields are its heading in declaration order, which these suites assert. */
					"testing/no-ordered-unordered": "off"
				})
			},
			{
				files: ["packages/testing/src/live.ts"],
				rules: active({
					/** The live clock a case's hang guard and a fuzz run's time budget read: its job is the clock. */
					"testing/no-wall-clock-verdict": "off"
				})
			},
			{
				files: [
					"test/types/batch/global-setup.ts",
					"scripts/dev/golden/capture.ts",
					"bench/cold/probe.ts",
					"bench/harness/runner.ts",
					"test/unit/deps/runtime-probe.ts"
				],
				rules: active({
					/** The type tier's global setup loads the type-test batch only for a run with type tests, the golden capture loads the modules it is pointed at, the cold probe times a first load, the bench runner loads the bench files it runs, and the runtime probe loads each module under its trap. */
					"devtools/no-dynamic-imports": "off"
				})
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
				files: ["test/types/**/fixtures/**", "packages/testing/src/witness.fixtures.ts"],
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
				files: ["test/types/regex/matrix.test.ts"],
				rules: active({
					/** The development oracle asks ECMAScript itself whether a source and its flags are a syntax error, so it builds the native RegExp from any text. */
					"devtools/no-raw-regexp": "off"
				})
			},
			{
				files: ["test/unit/deps/runtime-probe.ts"],
				rules: active({
					/** The trap forwards to the native exec with the receiver it is called on. */
					"typescript/unbound-method": "off",
					/** The positive control constructs through the trapped global RegExp. */
					"devtools/no-raw-regexp": "off"
				})
			},
			{
				files: ["test/types/skeleton/fixtures/db.ts"],
				rules: active({
					/** The note is a string the host holds, not the literal type r.literal's const parameter would take from its text. */
					"typescript/no-inferrable-types": "off"
				})
			},
			{
				files: ["test/types/harness/fixtures/kernel.ts"],
				rules: active({
					/** A refusal fixture's call is refused by construction: the value is the checker's error type. */
					"typescript/no-unsafe-call": "off"
				})
			},
			{
				files: ["test/types/api/fixtures/channels.ts"],
				rules: active({
					/** A refusal fixture's read and return are refused by construction: the value is the checker's error type. */
					"typescript/no-unsafe-member-access": "off",
					"typescript/no-unsafe-return": "off"
				})
			},
			{
				files: ["test/types/examples/fixtures/readme.ts", "test/types/query/fixtures/language.ts"],
				rules: active({
					/** A refusal fixture's return is refused by construction: the value is the checker's error type. */
					"typescript/no-unsafe-return": "off"
				})
			},
			{
				files: ["test/types/skeleton/fixtures/compute.ts"],
				rules: active({
					/** A refusal fixture's member read and call are refused by construction: the value is the checker's error type. */
					"typescript/no-unsafe-assignment": "off",
					"typescript/no-unsafe-call": "off"
				})
			},
			{
				files: ["test/unit/values/laws.test.ts"],
				rules: active({
					/** The canonical text is the subject: equal texts exactly for equal values, which no value comparison states. */
					"testing/no-serialized-comparison": "off"
				})
			}
		]
	})
)
