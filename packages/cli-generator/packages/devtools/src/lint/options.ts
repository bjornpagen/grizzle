import { Schema } from "effect"

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

const Names = Schema.Array(Schema.String)

/** Workspace packages by repository-relative directory, without a trailing "/". */
const PackageDirectories = Schema.Array(Schema.String)

/** A top-level declaration of a repository module: the module by its repository-relative path, the declaration by
 * its name. */
const Declaration = Schema.Struct({ owner: Schema.String, declaration: Schema.String })

/** A type a repository module exports (a type alias, an interface or a class): the module by its repository-relative
 * path, the type by its name. */
const DeclaredType = Schema.Struct({ module: Schema.String, type: Schema.String })

/**
 * The repository's names for the superlint rules that need them (owner paths, declared statements), from the
 * `superlint` field of the root package.json. Every field is required: a rule with nothing to admit states it with an
 * empty list.
 */
export const SuperlintOptions = Schema.Struct({
	/** Whether the repository owns an application database: "owned" runs the app-database rules, "none" (a repository
	 * that generates other people's SQL) never executes them. */
	appDatabase: Schema.Literals(["owned", "none"]),
	/** The workspace packages that use no Effect, by repository-relative directory without a trailing "/": each runs
	 * the Effect-free lint rules, its tsconfig extends the dev tools' Effect-free base, and it depends on no `effect`. */
	effectFree: PackageDirectories,
	/** The repository's exceptions: files where a rule does not run, by its id. Exceptions live here, never inline. */
	exceptions: Schema.Array(Schema.Struct({ rule: Schema.String, files: Paths })),
	/** The leaf files that may write Drizzle `sql` templates. */
	sqlLeafOwnersOnly: Schema.Struct({ owners: Paths }),
	/** The leaf files that may render a `::` cast. */
	sqlCastOwner: Schema.Struct({ owners: Paths }),
	/** The leaf files that may render JSON operators and expansions. */
	sqlJsonOwner: Schema.Struct({ owners: Paths }),
	/** The top-level arrow functions that may build a table from a computed column map: session-local relations
	 * derived from static declarations. */
	sqlDynamicSchema: Schema.Struct({ tableFactories: Schema.Array(Declaration) }),
	/** Where database deadlines are refused: the files read, the property names that set a deadline, the string
	 * literals that refuse work by elapsed time, and the deadlines admitted. An admitted deadline is the property set
	 * in its owner, inside `new construction(…)`, to `subject === principals.principal ? constant : false`, where the
	 * constant is declared in its module. */
	sqlQueryDeadline: Schema.Struct({
		files: Paths,
		properties: Names,
		refusals: Names,
		admitted: Schema.Array(
			Schema.Struct({
				owner: Schema.String,
				property: Schema.String,
				construction: Schema.String,
				guard: Schema.Struct({
					subject: Schema.String,
					principals: Schema.String,
					principal: Schema.String
				}),
				value: Schema.Struct({ module: Schema.String, constant: Schema.String })
			})
		)
	}),
	/** Who may execute statements: the statement-custody files that run native builders and prepared queries, the
	 * files that may run a pg-copy-streams COPY, the files that hold a native client and may call pg's `query`, and the
	 * executors whose one reviewed statement may run through Drizzle's `execute`: in the executor declared at the top
	 * level of the owner, `execute(statement(…))` with the statement declared in the same owner. */
	sqlRawExecution: Schema.Struct({
		statementOwners: Paths,
		copyStreamOwners: Paths,
		nativeClientOwners: Paths,
		declaredExecutions: Schema.Array(
			Schema.Struct({ owner: Schema.String, executor: Schema.String, statement: Schema.String })
		)
	}),
	/** The statement grammar admitted in a `sql` template: the files that hold the recursive envelope
	 * (`with recursive ${join} ${builder}`) and the projection envelope (`${builder.getSQL()} offset 0`), and the
	 * declared statements, each a top-level declaration of its owner whose templates' authored grammar, whitespace
	 * collapsed, is exactly its grammar. */
	sqlRawStatement: Schema.Struct({
		recursiveEnvelopeOwners: Paths,
		projectionEnvelopeOwners: Paths,
		declaredStatements: Schema.Array(
			Schema.Struct({ owner: Schema.String, declaration: Schema.String, grammar: Schema.String })
		)
	}),
	/** Where a closed vocabulary's member is spelled as a bare string: the test support read beside the test files,
	 * the types whose members form the vocabularies (a union of strings, or the `_tag` of a tagged error or a union of
	 * them), the registrars whose first argument is a title (`describe`, `it`), and the parameter names whose argument
	 * is prose (`message`). */
	uncheckedVocabularyLiteral: Schema.Struct({
		support: Paths,
		vocabularies: Schema.Array(DeclaredType),
		titled: Names,
		explanations: Names
	})
})

export type SuperlintOptions = typeof SuperlintOptions.Type

/** The options the fixtures run under: names that point into each rule's own fixture directory. */
export const FIXTURE_OPTIONS: SuperlintOptions = {
	appDatabase: "owned",
	effectFree: [],
	exceptions: [],
	sqlLeafOwnersOnly: { owners: ["sql-leaf-owners-only/clean.ts"] },
	sqlCastOwner: { owners: ["sql-cast-owner/clean.ts"] },
	sqlJsonOwner: { owners: ["sql-json-owner/clean.ts"] },
	sqlDynamicSchema: {
		tableFactories: [{ owner: "sql-dynamic-schema/clean.ts", declaration: "stageOf" }]
	},
	sqlQueryDeadline: {
		files: ["sql-query-deadline/"],
		properties: ["statement_timeout", "queryTimeoutMs"],
		refusals: ["budget-exhausted"],
		admitted: [
			{
				owner: "sql-query-deadline/clean.ts",
				property: "statement_timeout",
				construction: "Pool",
				guard: { subject: "username", principals: "PRINCIPALS", principal: "reader" },
				value: { module: "sql-query-deadline/clean.ts", constant: "READER_TIMEOUT_MILLISECONDS" }
			}
		]
	},
	sqlRawExecution: {
		statementOwners: ["sql-raw-execution/clean.ts"],
		copyStreamOwners: ["sql-raw-execution/clean.ts"],
		nativeClientOwners: ["sql-raw-execution/clean.ts"],
		declaredExecutions: [
			{
				owner: "sql-raw-execution/clean.ts",
				executor: "createStaging",
				statement: "stagingDefinition"
			}
		]
	},
	sqlRawStatement: {
		recursiveEnvelopeOwners: ["sql-raw-statement/clean.ts"],
		projectionEnvelopeOwners: ["sql-raw-statement/clean.ts"],
		declaredStatements: [
			{
				owner: "sql-raw-statement/clean.ts",
				declaration: "truncation",
				grammar: "truncate ? cascade"
			}
		]
	},
	uncheckedVocabularyLiteral: {
		support: ["unchecked-vocabulary-literal/"],
		vocabularies: [
			{ module: "unchecked-vocabulary-literal/vocabulary.ts", type: "FaultTag" },
			{ module: "unchecked-vocabulary-literal/vocabulary.ts", type: "TodoFailure" },
			{ module: "unchecked-vocabulary-literal/vocabulary.ts", type: "TodoNotFound" }
		],
		titled: ["describe", "it", "effect"],
		explanations: ["message", "why"]
	}
}
