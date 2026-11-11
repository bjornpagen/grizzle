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

/** Values a repository module exports, by the module's repository-relative path and the values' names. */
const DeclaredValues = Schema.Struct({ module: Schema.String, names: Names })

/** Declarations of an installed package, by the package's name and the declarations' names. */
const PackageDeclarations = Schema.Struct({ package: Schema.String, declarations: Names })

/** Files a rule does not read, and the reason it leaves them, which the repository states beside them. */
const Exemption = Schema.Struct({ files: Paths, reason: Schema.NonEmptyString })

/** Values of a repository module a rule does not count, and the reason, which the repository states beside them. */
const Scaffolds = Schema.Struct({
	module: Schema.String,
	names: Names,
	reason: Schema.NonEmptyString
})

/** A search of a repository module, by its module and name, and the property of its spec that holds its space
 * (`exhaust`'s `generator`, `explore`'s `draw`). */
const SearchSpace = Schema.Struct({
	module: Schema.String,
	name: Schema.String,
	space: Schema.String
})

/**
 * What a generator draws, for no-case-list: the members of the list it is handed (`element`), the one value it is
 * handed (`constant`), one value for each value of the generator it is handed (`map`, `span`, `drawn`, `sketched`), or a value of one of the generators it is handed (`oneOf`, `weighted`, `proportional`).
 */
const Draws = Schema.Literals(["list", "value", "each", "union"])

export type Draws = typeof Draws.Type

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
	}),
	/** Where every test case runs a search: the files whose cases are read, the declarations of the installed packages
	 * whose signatures register a test case (`it`, `it.effect`, `test`), the searches a case's body must reach, the
	 * scaffolds that run a search around a scenario a person wrote and so are no way to one, and the files exempt, each
	 * scaffold and each set of files with its reason. */
	testCaseIsSearch: Schema.Struct({
		files: Paths,
		registrars: Schema.Array(PackageDeclarations),
		searches: Schema.Array(DeclaredValues),
		scaffolds: Schema.Array(Scaffolds),
		exempt: Schema.Array(Exemption)
	}),
	/** Where a search's space is never a list of cases: the files whose searches are read; the files among them where
	 * every list written is a list of cases, beside the test files, whose lists always are (elsewhere a list is a roster
	 * the source declares); the dictionaries, whose lists are the values the code branches on, never verdicts, each set
	 * with its reason; the searches, with the property of their spec that holds the space; and the generators, each with
	 * what it draws. */
	noCaseList: Schema.Struct({
		files: Paths,
		cases: Paths,
		dictionaries: Schema.Array(Exemption),
		searches: Schema.Array(SearchSpace),
		generators: Schema.Array(Schema.Struct({ module: Schema.String, names: Names, draws: Draws }))
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
	},
	testCaseIsSearch: {
		files: ["test-case-is-search/"],
		registrars: [
			{ package: "@effect/vitest", declarations: ["Test", "each", "prop"] },
			{
				package: "vitest",
				declarations: ["TestCollectorCallable", "EachFunctionReturn", "TestForFunctionReturn"]
			}
		],
		searches: [
			{ module: "test-case-is-search/testing.ts", names: ["explore", "exhaust", "interleave"] }
		],
		scaffolds: [
			{
				module: "test-case-is-search/support.ts",
				names: ["scripted"],
				reason: "A scaffold's fixture: it searches a box around a scenario its caller writes."
			}
		],
		exempt: [
			{
				files: ["test-case-is-search/exempt/clean.ts"],
				reason:
					"An exempt file's fixture: its cases stay as they are, for the reason its exemption states."
			}
		]
	},
	noCaseList: {
		files: [
			"no-case-list/violating.ts",
			"no-case-list/clean.ts",
			"no-case-list/cases.ts",
			"no-case-list/dictionary.ts",
			"no-case-list/roster.ts"
		],
		cases: [
			"no-case-list/violating.ts",
			"no-case-list/clean.ts",
			"no-case-list/cases.ts",
			"no-case-list/dictionary.ts"
		],
		dictionaries: [
			{
				files: ["no-case-list/dictionary.ts"],
				reason:
					"A dictionary's fixture: the values a generator draws, which no case's verdict rides on."
			}
		],
		searches: [
			{ module: "no-case-list/testing.ts", name: "exhaust", space: "generator" },
			{ module: "no-case-list/testing.ts", name: "explore", space: "draw" }
		],
		generators: [
			{ module: "no-case-list/testing.ts", names: ["element"], draws: "list" },
			{ module: "no-case-list/testing.ts", names: ["constant"], draws: "value" },
			{
				module: "no-case-list/testing.ts",
				names: ["map", "span", "drawn", "sketched"],
				draws: "each"
			},
			{ module: "no-case-list/testing.ts", names: ["oneOf", "weighted"], draws: "union" }
		]
	}
}
