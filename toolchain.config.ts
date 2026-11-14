import { grizzle, toolchain } from "@bjornpagen/devtools/config"

/** grizzle's toolchain: the rules and diagnostics it rejects, its Effect-free packages and its packs. */
export default toolchain({
	rejected: {
		rules: {
			"eslint/constructor-super": "the compiler owns it (TS2335, TS2377)",
			"eslint/getter-return": "the compiler owns it (TS2378)",
			"eslint/init-declarations":
				"it forces an initializer on every let, which is a sentinel, and definite-assignment analysis already proves an uninitialized let is set on every path",
			"eslint/max-depth": "it breeds single-use helpers to cut nesting",
			"eslint/no-class-assign": "the compiler owns it (TS2629)",
			"eslint/no-const-assign": "the compiler owns it (TS2588)",
			"eslint/no-dupe-class-members": "the compiler owns it (TS2393, TS2300)",
			"eslint/no-dupe-keys": "the compiler owns it (TS1117)",
			"eslint/no-fallthrough": "the compiler owns it (noFallthroughCasesInSwitch)",
			"eslint/no-func-assign": "the compiler owns it (TS2630)",
			"eslint/no-implied-eval": "its type-aware twin typescript/no-implied-eval owns it",
			"eslint/no-import-assign": "the compiler owns it (TS2632, TS2540)",
			"eslint/no-inner-declarations":
				"it is an ES5-era rule: a block-level function is legal in a strict module",
			"eslint/no-new-native-nonconstructor": "the compiler owns it (TS7009)",
			"eslint/no-obj-calls": "the compiler owns it (TS2349)",
			"eslint/no-redeclare":
				"it flags a type and a value of the same name, such as a brand and its mint or a Schema and its type, which TypeScript allows, and TypeScript already refuses a real redeclaration",
			"eslint/no-setter-return": "the compiler owns it (TS2408)",
			"eslint/no-this-before-super": "the compiler owns it (TS2376, TS17009)",
			"eslint/no-throw-literal": "it is deprecated, and typescript/only-throw-error owns it",
			"eslint/no-underscore-dangle": "it is naming taste that already needs an allow-list",
			"eslint/no-unreachable": "the compiler owns it (allowUnreachableCode: false)",
			"eslint/no-unsafe-negation": "the compiler owns it (TS2365, TS2322, TS2358)",
			"eslint/no-unsafe-optional-chaining":
				"the compiler owns it (strictNullChecks: TS2722, TS18048)",
			"eslint/no-unused-labels": "the compiler owns it (allowUnusedLabels: false)",
			"eslint/no-unused-private-class-members":
				"the compiler owns it (noUnusedLocals, noUnusedParameters)",
			"eslint/no-unused-vars": "the compiler owns it (noUnusedLocals, noUnusedParameters)",
			"eslint/no-use-before-define":
				"with functions, classes and variables allowed only the temporal dead zone remains, which the compiler owns (TS2448, TS2449)",
			"eslint/no-with": "the compiler owns it (TS1101, TS2410)",
			"eslint/prefer-regex-literals":
				"it pushes toward regex literals, and arkregex's regex() is the only regex form",
			"eslint/prefer-spread":
				"it turns f.apply(this, list) into f(...list), a variable-length list on the call stack, which superlint's no-spread-argument refuses",
			"eslint/preserve-caught-error": "try/catch is Effect's tryCatchInEffectGen's",
			"eslint/require-await": "async is banned, and Effect's asyncFunction owns it",
			"import/no-absolute-path": "it came only with the suspicious category, which is off",
			"import/no-empty-named-blocks": "it came only with the suspicious category, which is off",
			"import/no-named-as-default": "it came only with the suspicious category, which is off",
			"import/no-named-as-default-member":
				"it came only with the suspicious category, which is off",
			"import/no-self-import": "it came only with the suspicious category, which is off",
			"node/no-sync": "Effect's nodeBuiltinImport owns it",
			"oxc/no-async-endpoint-handlers": "async is banned, and Effect's asyncFunction owns it",
			"oxc/no-const-enum": "erasableSyntaxOnly already refuses every enum",
			"typescript/ban-types":
				"it is deprecated, and no-empty-object-type, no-unsafe-function-type and no-wrapper-object-types own it",
			"typescript/consistent-return":
				"it contradicts Effect's missingReturnYieldStar (return yield*) and exhaustive switches without a default, and noImplicitReturns already refuses a real missing return",
			"typescript/consistent-type-exports":
				"verbatimModuleSyntax already makes it a compiler error",
			"typescript/consistent-type-imports":
				"verbatimModuleSyntax already makes it a compiler error",
			"typescript/no-confusing-void-expression":
				"it forces block bodies on void callbacks, and typescript/no-misused-promises and Effect's floatingEffect own the real bugs",
			"typescript/no-empty-interface":
				"it is deprecated, and typescript/no-empty-object-type owns it",
			"typescript/no-invalid-void-type":
				"oxlint's port refuses void as a type argument (Promise.withResolvers<void>()), which the rule exists to allow",
			"typescript/no-mixed-enums": "erasableSyntaxOnly already refuses every enum",
			"typescript/no-unnecessary-qualifier":
				"erasableSyntaxOnly already refuses every enum and runtime namespace",
			"typescript/no-unnecessary-type-assertion":
				"typescript/consistent-type-assertions already bans every cast",
			"typescript/no-unsafe-enum-comparison": "erasableSyntaxOnly already refuses every enum",
			"typescript/no-unsafe-type-assertion":
				"typescript/consistent-type-assertions already bans every cast",
			"typescript/non-nullable-type-assertion-style":
				"it recommends the non-null assertion, which typescript/no-non-null-assertion bans",
			"typescript/prefer-enum-initializers": "erasableSyntaxOnly already refuses every enum",
			"typescript/prefer-literal-enum-member": "erasableSyntaxOnly already refuses every enum",
			"typescript/prefer-readonly-parameter-types":
				"it needs an allow-list of every library, error and resource type, sees through no alias, and refuses state that is mutable by design",
			"typescript/promise-function-async": "async is banned",
			"typescript/require-await": "async is banned, and Effect's asyncFunction owns it",
			"typescript/return-await": "async is banned, and Effect's asyncFunction owns it",
			"typescript/strict-void-return":
				"it forces block bodies on void callbacks, and typescript/no-misused-promises and Effect's floatingEffect own the real bugs",
			"unicorn/consistent-function-scoping": "it moves a helper away from its one use",
			"unicorn/explicit-length-check": "it is opinion",
			"unicorn/no-array-for-each": "it misreads Effect's Arr.forEach and only enforces taste",
			"unicorn/no-instanceof-array": "unicorn/no-instanceof-builtins covers it",
			"unicorn/no-static-only-class": "its type-aware twin typescript/no-extraneous-class owns it",
			"unicorn/no-unnecessary-await": "its type-aware twin typescript/await-thenable owns it",
			"unicorn/prefer-array-index-of": "it pushes toward indexOf, whose -1 is a sentinel",
			"unicorn/prefer-date-now": "Effect's globalDate owns it",
			"unicorn/prefer-string-starts-ends-with":
				"its type-aware twin typescript/prefer-string-starts-ends-with owns it"
		},
		diagnostics: {
			apiStabilityLeak: "unstable Effect APIs stay usable, so exposing one is no defect",
			experimentalApiUsage:
				"unstable Effect APIs stay usable, so using an experimental one is no defect",
			missingPipeableSignature:
				"Function.dual is an overload in disguise that dispatches on arguments.length on every call, for a data-last form almost nothing calls (owner, 2026-10-26)",
			preferSchemaTaggedError:
				"Effect Schema is for types, never runtime validation: errors are Data.TaggedError (owner, 2026-11-04)",
			unstableApiUsage: "Effect's whole Node platform layer is marked unstable"
		}
	},
	exceptions: [
		{
			rule: "no-module-state",
			files: [
				"packages/engine/src/query/build/scope.ts",
				"test/pg/serverless/support.ts",
				"test/support/substrate/shared.ts"
			]
		},
		{ rule: "no-spread-argument", files: ["test/unit/deps/runtime-probe.ts"] },
		{
			rule: "limit-evidence",
			files: ["test/types/examples/fixtures/readme.ts", "test/types/examples/fixtures/skill.ts"]
		},
		{ rule: "ts-only-extensions", files: ["upstream/v8-unicode-end-anchor-astral-class/repro.js"] },
		{
			rule: "effect-free-packages",
			/**
			 * The engine is Effect-free at run time and names Effect's types (`import type`), so its manifest states effect
			 * as the peer its declarations need. A consumer takes the engine's source from grizzle's submodule without the
			 * toolchain, whose files its Vite would fail to load, so its tsconfig extends grizzle's own base, which sets no
			 * plugin, never the dev tools' Effect-free base.
			 */
			files: ["packages/engine/package.json", "packages/engine/tsconfig.json"]
		}
	],
	effectFree: ["packages/engine"],
	core: {
		uncheckedVocabularyLiteral: {
			support: ["test/"],
			vocabularies: [
				{ module: "packages/engine/src/core/errors.ts", type: "CompileReasonTag" },
				{ module: "packages/engine/src/core/errors.ts", type: "TransientTag" },
				{ module: "packages/engine/src/core/errors.ts", type: "CodecFault" },
				{ module: "test/support/error-tags.ts", type: "GrizzleErrorTag" },
				{ module: "packages/engine/src/ir/certificate.ts", type: "CertificateRule" }
			],
			titled: ["describe", "layer", "it", "test", "effect", "live", "each"],
			explanations: ["message", "why"]
		}
	},
	packs: [
		grizzle({
			sqlTextAssertion: {
				files: ["test/"],
				exempt: ["test/pg/migrate/", "test/pg/migrate-gen/", "test/unit/deploy/"],
				texts: [{ module: "packages/engine/src/sql/ast.ts", alias: "EmittedText" }],
				matchers: ["assert.match", "assert.doesNotMatch", "containsText", "lacksText"],
				equalities: ["assert.equal", "assert.notEqual"]
			},
			limitEvidence: {
				limits: {
					module: "packages/engine/src/core/limits.ts",
					mints: ["published", "measured", "derived"]
				},
				formatTag: "formatConstant",
				modules: [
					{ package: "effect", module: "Duration", category: "time" },
					{ package: "effect", module: "Schedule", category: "retry" }
				],
				wrappers: [{ package: "effect", module: "Effect", names: ["fn", "fnUntraced"] }],
				vocabulary: {
					length: {
						parameters: [
							"start",
							"end",
							"count",
							"length",
							"maxLength",
							"targetLength",
							"arrayLength",
							"deleteCount",
							"n"
						],
						words: []
					},
					time: {
						parameters: [
							"ms",
							"millis",
							"milliseconds",
							"delay",
							"timeout",
							"duration",
							"seconds",
							"minutes",
							"hours",
							"days",
							"weeks",
							"nanos",
							"micros",
							"interval",
							"timeToLive"
						],
						words: [
							"timeout",
							"deadline",
							"idle",
							"ms",
							"millis",
							"milliseconds",
							"seconds",
							"minutes",
							"hours",
							"interval",
							"delay",
							"grace",
							"backoff",
							"duration",
							"lifetime",
							"ttl"
						]
					},
					concurrency: {
						parameters: ["permits", "concurrency"],
						words: ["concurrency", "permits", "parallelism", "workers"]
					},
					retry: {
						parameters: ["times", "retries", "attempts"],
						words: ["retries", "retry", "attempts", "attempt", "times", "tries"]
					},
					size: {
						parameters: ["capacity", "size", "max", "min", "limit"],
						words: [
							"max",
							"min",
							"size",
							"limit",
							"budget",
							"depth",
							"capacity",
							"cap",
							"threshold"
						]
					}
				},
				scopes: [
					{
						files: ["packages/engine/src/", "packages/grizzle/src/"],
						generated: [".generated.ts"],
						positions: [
							"comparison",
							"loop",
							"extremum",
							"length",
							"time",
							"concurrency",
							"retry",
							"size"
						],
						words: "every property",
						constants: [
							"max",
							"min",
							"limit",
							"bound",
							"budget",
							"timeout",
							"deadline",
							"retries",
							"size",
							"depth",
							"cap",
							"threshold",
							"grace",
							"ms",
							"millis",
							"seconds"
						],
						inputs: []
					},
					{
						files: ["test/"],
						generated: [],
						positions: ["time", "concurrency", "retry"],
						words: "library properties",
						constants: [
							"timeout",
							"deadline",
							"retries",
							"attempts",
							"concurrency",
							"grace",
							"ms",
							"millis",
							"seconds",
							"minutes",
							"backoff",
							"interval",
							"delay",
							"idle"
						],
						inputs: [{ module: "vendor/toolchain/packages/testing/src/gen.ts", alias: "Gen" }]
					},
					{
						files: ["bench/", "scripts/"],
						generated: [],
						positions: ["time", "concurrency", "retry"],
						words: "library properties",
						constants: [
							"timeout",
							"deadline",
							"retries",
							"attempts",
							"concurrency",
							"grace",
							"ms",
							"millis",
							"seconds",
							"minutes",
							"backoff",
							"interval",
							"delay",
							"idle"
						],
						inputs: [
							{ module: "vendor/toolchain/packages/testing/src/gen.ts", alias: "Gen" },
							{ module: "bench/harness/gate.ts", alias: "Gate" }
						]
					}
				]
			},
			noEnvironment: {
				files: ["packages/engine/src/", "packages/grizzle/src/"],
				readers: ["packages/grizzle/src/adapter/connection/environment.ts"],
				sources: [
					{
						package: "@types/node",
						module: "process",
						reads: {
							kind: "exports",
							names: [
								"env",
								"cwd",
								"chdir",
								"argv",
								"argv0",
								"execArgv",
								"execPath",
								"loadEnvFile",
								"platform",
								"arch",
								"version",
								"versions",
								"release",
								"config",
								"features",
								"title",
								"ppid",
								"getuid",
								"geteuid",
								"getgid",
								"getegid",
								"getgroups",
								"umask",
								"memoryUsage",
								"resourceUsage",
								"availableMemory",
								"constrainedMemory",
								"allowedNodeEnvironmentFlags",
								"permission"
							]
						}
					},
					{ package: "@types/node", module: "os", reads: { kind: "module" } },
					{ package: "@types/node", module: "navigator", reads: { kind: "module" } },
					{
						package: "@types/node",
						module: "v8",
						reads: {
							kind: "exports",
							names: ["getHeapStatistics", "getHeapSpaceStatistics", "getHeapCodeStatistics"]
						}
					},
					{ package: "effect", module: "Config", reads: { kind: "module" } },
					{ package: "effect", module: "ConfigProvider", reads: { kind: "module" } }
				],
				entryReads: ["argv", "cwd"]
			},
			testCaseIsSearch: {
				files: ["test/"],
				registrars: [
					{ package: "@effect/vitest", declarations: ["Test", "each", "prop"] },
					{
						package: "vitest",
						declarations: ["TestCollectorCallable", "EachFunctionReturn", "TestForFunctionReturn"]
					}
				],
				searches: [
					{
						module: "vendor/toolchain/packages/testing/src/explore.ts",
						names: ["explore", "exhaust"]
					},
					{ module: "vendor/toolchain/packages/testing/src/interleave.ts", names: ["interleave"] }
				],
				scaffolds: [
					{
						module: "test/support/schedules/runner.ts",
						names: ["runSchedule"],
						reason:
							"It compiles a hand-written schedule into the concurrency driver's script strategy, so every hand schedule reaches the library's interleave without searching an order; a case that runs one is a search only when it calls explore, exhaust or interleave over the schedules itself."
					}
				],
				exempt: [
					{
						files: ["test/types/examples/blocks.test.ts", "test/types/examples/examples.test.ts"],
						reason:
							"The README's and SKILL.md's mirror: blocks.test.ts holds every documented block to its mirrored fixture, and examples.test.ts typechecks those fixtures and fails each refusal the README states with exactly the diagnostic it names, so the documentation is checked code; its blocks are the documentation, never inputs a person chose to test."
					},
					{
						files: ["test/unit/dev/package.test.ts"],
						reason:
							"The submodule-consumer gate: the README's and SKILL.md's mirrored programs, the one sanctioned example code, typecheck as a consumer's against the package's source reached through its exports, so the source checks under a consumer's tsconfig and no type the README states is any."
					},
					{
						files: ["test/pg/bench/"],
						reason:
							"The performance gates: each measures a workload against its gate, a performance property, never a verdict a person wrote."
					},
					{
						files: [
							"test/types/api/access.test.ts",
							"test/types/api/config.test.ts",
							"test/types/api/decoder.test.ts",
							"test/types/api/handle.test.ts",
							"test/types/api/recursion.test.ts",
							"test/types/api/surface.test.ts",
							"test/types/api/untyped.test.ts",
							"test/types/api/workload.test.ts",
							"test/types/changeset/changeset.test.ts",
							"test/types/changeset/entry-owner.test.ts",
							"test/types/changeset/nesting.test.ts",
							"test/types/compute/compute.test.ts",
							"test/types/evidence/agreement.test.ts",
							"test/types/evidence/attachments.test.ts",
							"test/types/evidence/parameter.test.ts",
							"test/types/harness/harness.test.ts",
							"test/types/regex/agreement.test.ts",
							"test/types/schema/agreement.test.ts",
							"test/types/schema/generic.test.ts",
							"test/types/text/bytes.test.ts",
							"test/types/text/regex.test.ts"
						],
						reason:
							"The type batch's population runners: the population is drawn by the testing library's generators, or exhausts a box the source's own rosters define, and is printed as one program the batch typechecks at once, so no case can run a search per program; each case checks the drawn population against the engine as oracle, or that its floor's witnesses reach every requirement."
					},
					{
						files: [
							"test/types/query/budget/invariance.test.ts",
							"test/types/query/budget/scaling.test.ts",
							"test/types/regex/scaling.test.ts",
							"test/types/schema/budget/families.test.ts",
							"test/types/schema/budget/invariance.test.ts",
							"test/types/schema/budget/logins.test.ts",
							"test/types/schema/budget/scaling.test.ts",
							"test/types/skeleton/budget/invariance.test.ts"
						],
						reason:
							"The type layer's cost gates: each typechecks programs generated at three sizes an equal step apart and holds their types and instantiations to grow no faster than linearly, the second step adding no more than the first (test/support/growth.ts), a performance property; or holds the largest program's inference and refusals to its twin's, the same declarations at the smallest scale its probes read. No verdict is one a person wrote."
					}
				]
			},
			noCaseList: {
				files: ["test/"],
				cases: ["test/"],
				dictionaries: [
					{
						files: ["test/support/kernel/dict.ts"],
						reason:
							"The identifier, literal and parameter-name dictionaries: the tricky values the code branches on, each admitted or refused by the production validator itself, never by a verdict the test writes."
					}
				],
				searches: [
					{
						module: "vendor/toolchain/packages/testing/src/explore.ts",
						name: "exhaust",
						space: "generator"
					},
					{
						module: "vendor/toolchain/packages/testing/src/explore.ts",
						name: "explore",
						space: "draw"
					}
				],
				generators: [
					{
						module: "vendor/toolchain/packages/testing/src/gen.ts",
						names: ["element"],
						draws: "list"
					},
					{
						module: "vendor/toolchain/packages/testing/src/gen.ts",
						names: ["constant"],
						draws: "value"
					},
					{
						module: "vendor/toolchain/packages/testing/src/gen.ts",
						names: ["map", "span"],
						draws: "each"
					},
					{
						module: "vendor/toolchain/packages/testing/src/explore.ts",
						names: ["drawn", "sketched"],
						draws: "each"
					},
					{
						module: "vendor/toolchain/packages/testing/src/gen.ts",
						names: ["oneOf", "weighted", "proportional"],
						draws: "union"
					}
				]
			}
		})
	],
	own: []
})
