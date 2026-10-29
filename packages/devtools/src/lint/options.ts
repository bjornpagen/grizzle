import { Schema } from "effect"

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

const Names = Schema.Array(Schema.String)

/** A type alias a repository module exports: the module by its repository-relative path, the alias by its name. */
const DeclaredAlias = Schema.Struct({ module: Schema.String, alias: Schema.String })

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
	})
})

export type SuperlintOptions = typeof SuperlintOptions.Type

/** The options the fixtures run under: names that point into each rule's own fixture directory. */
export const FIXTURE_OPTIONS: SuperlintOptions = {
	exceptions: [],
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
	}
}
