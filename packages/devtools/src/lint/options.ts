import { Schema } from "effect"

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

const Names = Schema.Array(Schema.String)

/** A type alias a repository module exports: the module by its repository-relative path, the alias by its name. */
const DeclaredAlias = Schema.Struct({ module: Schema.String, alias: Schema.String })

/** The categories of the values that set a resource: a length or a count, a time, a concurrency, a retry policy and
 * a resource's size. */
const CATEGORY_NAMES = ["length", "time", "concurrency", "retry", "size"] as const

const Category = Schema.Literals(CATEGORY_NAMES)

export type Category = typeof Category.Type

/**
 * Where a bound sits. A comparison's operands (<, <=, >, >=), outside a loop's condition and inside it; the arguments
 * of Math.min and Math.max; and the values that set a category's resource, by the vocabulary of their parameter,
 * property or assignment target, or by the category module they are passed to.
 */
const BoundPosition = Schema.Literals(["comparison", "loop", "extremum", ...CATEGORY_NAMES])

export type BoundPosition = typeof BoundPosition.Type

/** A module of an installed package whose values are a category's: a function of it sets one with every argument,
 * and a parameter that accepts one of its types is one (`{ package: "effect", module: "Schedule", category: "retry" }`). */
const CategoryModule = Schema.Struct({
	package: Schema.String,
	module: Schema.String,
	category: Category
})

/** The functions of an installed package that wrap a function into a callable taking the same arguments
 * (`{ package: "effect", module: "Effect", names: ["fn", "fnUntraced"] }`), whose body a call of the callable runs. */
const Wrappers = Schema.Struct({ package: Schema.String, module: Schema.String, names: Names })

/** One category's names: the parameter names a library's signature gives a value of it, matched exactly, and the
 * words of a property's or a parameter's name that put a value in it (`idleTimeoutMs` is idle, timeout and ms). */
const Vocabulary = Schema.Struct({ parameters: Names, words: Names })

/**
 * Whose names put a value in a category by their words: every property's and every assignment target's (the library,
 * where a property named for a bound holds one wherever its value goes), or only a library's properties (the tests,
 * whose own records and their subject's types are data, and whose bounds are what the libraries they call consume).
 */
const Words = Schema.Literals(["every property", "library properties"])

/** A set of files limit-evidence checks, which owns its numbers: a call from one of its files to a function of
 * another passes the caller's own numbers, so a parameter that reaches a bound there is that bound, while a call out of
 * the scope passes the code under test or a dependency its inputs. The scope names its files, the file-name suffixes
 * that mark a generated file, the positions it checks, whose names' words put a value in a category, the words of a
 * module-level number constant's name that say it bounds something, and the types (an alias or an interface) of the
 * inputs a test draws (a generator, a bench gate), whose builders' arguments are the test's inputs and never a bound. A
 * file is in the first scope that names it. */
const LimitScope = Schema.Struct({
	files: Paths,
	generated: Names,
	positions: Schema.Array(BoundPosition),
	words: Words,
	constants: Names,
	inputs: Schema.Array(DeclaredAlias)
})

/** What of a module's values a no-environment source reads: every one, or the named ones. */
const EnvironmentReads = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("module") }),
	Schema.Struct({ kind: Schema.Literal("exports"), names: Names })
])

/**
 * Each repository's own names for the superlint rules that need them (exempt paths, helper names, vocabularies),
 * from the `superlint` field of the repository root's package.json. Every field is required: a repository where a
 * rule has nothing to guard states that with an empty list, so the rule is inert there.
 */
export const SuperlintOptions = Schema.Struct({
	/** The repository's exceptions: files where a rule does not run, by its id. Exceptions live here, never inline. */
	exceptions: Schema.Array(Schema.Struct({ rule: Schema.String, files: Paths })),
	/** Where emitted SQL is asserted by its text: the test files read, the files exempt among them (text a person
	 * reviews), the type aliases of emitted text, the matchers that assert a pattern (`assert.match`), and the
	 * equalities that assert text when their expected value is a written string (`assert.equal`). */
	sqlTextAssertion: Schema.Struct({
		files: Paths,
		exempt: Paths,
		texts: Schema.Array(DeclaredAlias),
		matchers: Names,
		equalities: Names
	}),
	/** Where a closed vocabulary's member is spelled as a bare string: the test files read, the type aliases whose
	 * string-literal members form the vocabularies, the registrars whose first argument is a title (`describe`, `it`),
	 * and the parameter names whose argument is prose (`message`). */
	uncheckedVocabularyLiteral: Schema.Struct({
		files: Paths,
		vocabularies: Schema.Array(DeclaredAlias),
		titled: Names,
		explanations: Names
	}),
	/** Where a bound must be a Limit or a caller's input: the module that mints limits, by its repository-relative path,
	 * with its mints (`published`, `measured`, `derived`), whose arguments are a limit's evidence and its derivation;
	 * the JSDoc tag that names a format's defining width; the packages' modules whose values are a category's; the
	 * packages' function wrappers, whose wrapped body a call runs; each category's vocabulary; and the scopes. */
	limitEvidence: Schema.Struct({
		limits: Schema.Struct({ module: Schema.String, mints: Names }),
		formatTag: Schema.String,
		modules: Schema.Array(CategoryModule),
		wrappers: Schema.Array(Wrappers),
		vocabulary: Schema.Struct({
			length: Vocabulary,
			time: Vocabulary,
			concurrency: Vocabulary,
			retry: Vocabulary,
			size: Vocabulary
		}),
		scopes: Schema.Array(LimitScope)
	}),
	/** Where the library reads no environment: the files read, the sanctioned readers among them, the packages' modules
	 * whose values are the environment, and the values of those a program's entry module (one that tests
	 * `import.meta.main`) reads as its own arguments and working directory. */
	noEnvironment: Schema.Struct({
		files: Paths,
		readers: Paths,
		sources: Schema.Array(
			Schema.Struct({
				package: Schema.String,
				module: Schema.String,
				reads: EnvironmentReads
			})
		),
		entryReads: Names
	})
})

export type SuperlintOptions = typeof SuperlintOptions.Type

/** The options the fixtures run under: names that point into each rule's own fixture directory. */
export const FIXTURE_OPTIONS: SuperlintOptions = {
	exceptions: [{ rule: "limit-evidence", files: ["limit-evidence/mirror/clean.ts"] }],
	sqlTextAssertion: {
		files: ["sql-text-assertion/"],
		exempt: ["sql-text-assertion/clean.ts"],
		texts: [{ module: "sql-text-assertion/emitted.ts", alias: "EmittedText" }],
		matchers: ["assert.match", "assert.doesNotMatch", "containsText"],
		equalities: ["assert.equal", "assert.notEqual"]
	},
	uncheckedVocabularyLiteral: {
		files: ["unchecked-vocabulary-literal/"],
		vocabularies: [
			{ module: "unchecked-vocabulary-literal/vocabulary.ts", alias: "FaultTag" },
			{ module: "unchecked-vocabulary-literal/vocabulary.ts", alias: "RefusalTag" }
		],
		titled: ["describe", "it"],
		explanations: ["message", "why"]
	},
	limitEvidence: {
		limits: { module: "limit-evidence/limits.ts", mints: ["published", "measured", "derived"] },
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
				words: ["max", "min", "size", "limit", "budget", "depth", "capacity", "cap", "threshold"]
			}
		},
		scopes: [
			{
				files: ["limit-evidence/tests/"],
				generated: [],
				positions: ["time", "concurrency", "retry"],
				words: "library properties",
				constants: ["timeout", "deadline", "retries", "attempts", "concurrency", "ms", "seconds"],
				inputs: [
					{ module: "limit-evidence/tests/gen.ts", alias: "Gen" },
					{ module: "limit-evidence/tests/gen.ts", alias: "Plan" }
				]
			},
			{
				files: ["limit-evidence/"],
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
			}
		]
	},
	noEnvironment: {
		files: ["no-environment/"],
		readers: ["no-environment/reader/clean.ts"],
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
	}
}
