/**
 * Which installed objects read each pattern language an installation spells: what `grizzle upgrade` proves a language's
 * spelling history by, an object holding the ARE of the spelling the database holds as the target's (the shell's
 * cli/upgrade.ts, deploy/upgrade/history.ts).
 */
import type { Spellings } from "#compiler/ir/pattern.ts"
import type { PhysicalObject } from "#compiler/ir/products.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"

/**
 * The identities of the objects of `objects` that read each language of `spellings`, by the language's key: each whose
 * statements hold the ARE of the language's spelling (scalar/regex/admit.ts matchAre), the one text a pattern of the
 * language lowers to wherever a statement reads it (lower/conservative/expr/index.ts patternAre). A language no object
 * reads is read by none, so no installed object holds its spelling.
 */
export const spellingReaders = (
	objects: ReadonlyArray<PhysicalObject<SqlStatement>>,
	spellings: Spellings
): ReadonlyMap<string, ReadonlySet<string>> => {
	const languageOf = new Map(
		[...spellings].map(([language, spelling]) => [matchAre(spelling), language])
	)
	const readers = new Map<string, Set<string>>(
		[...spellings.keys()].map((l) => [l, new Set<string>()])
	)
	for (const o of objects) {
		for (const language of languagesIn(o.ddl, languageOf)) {
			readers.get(language)?.add(o.ident)
		}
	}
	return readers
}

/** The languages whose AREs, by `languageOf`, `value` holds as a text, through its arrays and data properties alone. */
const languagesIn = (
	value: unknown,
	languageOf: ReadonlyMap<string, string>
): ReadonlySet<string> => {
	const out = new Set<string>()
	const seen = new Set<object>()
	const visit = (x: unknown): void => {
		if (typeof x === "string") {
			const language = languageOf.get(x)
			if (language !== undefined) {
				out.add(language)
			}
			return
		}
		if (typeof x !== "object" || x === null || seen.has(x)) {
			return
		}
		seen.add(x)
		for (const property of Object.values(Object.getOwnPropertyDescriptors(x))) {
			if ("value" in property) {
				visit(property.value)
			}
		}
	}
	visit(value)
	return out
}
