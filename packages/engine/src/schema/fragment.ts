/**
 * What a schema that lists a fragment may state over the fragment's relations (schema.ts fragment).
 *
 * A program over a fragment reads and writes the fragment's relations alone, typed by the fragment's statements, and is
 * compiled in every schema that lists the fragment, so it must mean there what it means over the fragment. A statement
 * that decides how a relation is written changes what a write of it is: a key, which an insertion's arbiter and a put's
 * same-key checks read (write/insert/unique.ts generatedArbiter); mutable, which puts a row in place rather than
 * deleting and inserting it; race, under which an insertion meets the row at its key rather than being refused by it;
 * retirable, which holds every write of a body at its group; and a family, a tree or a fold, which draw fields and nest
 * members. Only the fragment states those over its relations: a schema that lists it may state one again, one text
 * being one statement, and adds over them only what refuses a write and changes none, a containment, a row check or a
 * rule over a query. Such a law may still refuse a fragment's program when a host compiles it (an unorderable stratum,
 * a read-back crossing statements), which generate reports for that host; it never changes what the program does.
 */
import { CompileError } from "#compiler/core/errors.ts"
import type { StatementDesc } from "#compiler/ir/desc.ts"
import type { SchemaContent } from "#compiler/schema/levels.ts"
import { type CanonicalStatement, statementLabel } from "#compiler/schema/own.ts"

/** The relations whose writes a statement decides: none for a statement that only refuses. */
const decidedRelations = (s: StatementDesc): ReadonlyArray<string> => {
	switch (s.kind) {
		case "key":
			return [s.side.relation]
		case "mutable":
		case "race":
			return [s.relation]
		case "family":
		case "tree":
			return [s.member.relation, s.slots.owner]
		case "fold":
			return [s.family.owner, s.step.relation, s.end.relation]
		case "retirable":
			return [s.header.relation, ...s.bodies.map((b) => b.relation)]
		case "check":
		case "contained":
		case "alternatives":
			return []
	}
}

/** A fragment's name in diagnostics: it declares no name of its own, so it is named by its relations, in list order. */
export const fragmentName = (content: SchemaContent): string =>
	`fragment(${[...content.relations.keys()].join(", ")})`

/**
 * Refuses (FragmentRefused) the first of `statements`, each statement of a schema that lists the fragment of content
 * `fragment`, its levels' and its listed fragments' alike, that is none of the fragment's own statements and decides
 * how one of the fragment's relations is written.
 */
export const fragmentReach = (
	fragment: SchemaContent,
	statements: Iterable<CanonicalStatement>
): void => {
	for (const s of statements) {
		if (fragment.statements.has(s.text)) {
			continue
		}
		const relation = decidedRelations(s.form).find((r) => fragment.relations.has(r))
		if (relation !== undefined) {
			throw CompileError.make({
				_tag: "FragmentRefused",
				at: s.form.loc,
				statement: statementLabel(s.form),
				relation,
				fragment: fragmentName(fragment)
			})
		}
	}
}
