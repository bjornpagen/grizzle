import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Predicate, Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { CreateFunction } from "#compiler/sql/ast.ts"
import { type Dimension, dimensions } from "#test/unit/laws/scaling.fixtures.ts"

/** A case: one of the scaling dimensions' schemas, at a size of one to three. */
export interface ScopeCase {
	readonly dimension: Dimension
	readonly n: number
}

/** Every dimension, at each small size. */
export const scopeCases: Gen<ScopeCase> = (source) => ({
	dimension: source.draw(element(dimensions)),
	n: source.draw(int(1, 3))
})

/** The FROM items an alias names, by their kind (sql/ast.ts FromSource), each declaring its alias once where it stands. */
const aliased: ReadonlySet<string> = new Set([
	"table",
	"read",
	"probe",
	"met",
	"metRows",
	"cte",
	"transition",
	"enclosing",
	"derived",
	"function",
	"arrays",
	"values"
])

/** Every alias the FROM items of `node` declare, at any depth, in walk order: each a name the routine's scope minted. */
const declaredAliases = (node: unknown): ReadonlyArray<string> => {
	if (Arr.isArray(node)) {
		return Arr.flatMap(node, declaredAliases)
	}
	if (!isRecord(node)) {
		return []
	}
	const kind = node["kind"]
	const alias = node["alias"]
	const own =
		Predicate.isString(kind) && aliased.has(kind) && Predicate.isString(alias) ? [alias] : []
	return [...own, ...Arr.flatMap(Rec.values(node), declaredAliases)]
}

/** Every routine the installation installs, bound and advised, as its manifest holds it. */
export const routinesOf = (installation: Installation): ReadonlyArray<CreateFunction> =>
	Arr.flatMap(installation.manifest.objects, (o) =>
		Arr.flatMap(o.ddl, (s) => (s.kind === "createFunction" ? [s] : []))
	)

/**
 * Law 3 over one routine: each alias its statements declare, declared once across all of them; what it answers is
 * every alias declared more than once, with how often, none where the routine holds one scope.
 */
export const repeatedAliases = (fn: CreateFunction): ReadonlyArray<string> => {
	const counts = new Map<string, number>()
	for (const alias of declaredAliases(fn.body)) {
		counts.set(alias, (counts.get(alias) ?? 0) + 1)
	}
	return Arr.flatMap([...counts], ([alias, n]) =>
		n > 1 ? [`${fn.name.name}: ${alias} ×${n}`] : []
	)
}

/** How many of a routine's statements read a relation: a body of two or more is where a repeated alias would show. */
export const readingStatements = (fn: CreateFunction): number =>
	fn.language === "sql" ? 1 : Arr.filter(fn.body.body, (s) => declaredAliases(s).length > 0).length
