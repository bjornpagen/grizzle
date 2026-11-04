import { Array as Arr } from "effect"
import { indices } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"

/**
 * The growing-schema program, one type test of the query facade at scale. It writes one TypeScript program over the
 * public facade (the query, schema, fields and text barrels) with `relations` relations, and for each relation the
 * shapes the seven statement readers see: candidate keys, containments, a closed roster, mutability, a
 * parameterized query with an attachment, a keyed lookup, a lookup fixed by a filter, a grouped aggregate, a two-arm
 * union ordered by its common fields, a bound import, and reads through Db.
 *
 * The program asserts what is inferred at the first relation and at the last, so it fails at any size where inference
 * widens rather than only where it stops typechecking: exact parameters, heads, evidence and retained
 * keys, and refusals that must keep firing, each with a `@ts-expect-error -- TSnnnn` directive the harness checks.
 * Reads are typed inside a function the program never calls.
 */
export const largestQuerySize = 200

const relationDeclaration = (i: number): string =>
	`export const R${i} = relation("R${i}", { id: uuid, parent: uuid, amount: pg.bigint, label: Label, kind: closedId(Kind), qty: pg.integer }, ["id"])\n`

/** One relation's queries. */
const relationBlock = (i: number, relations: number): string => {
	const child = (i + 1) % relations
	return `
export const byParent${i} = query(S).rule((r) => {
	const { id, parent, amount, kind } = v(R${i}, "r${i}")
	return r.match(R${i}, { id, parent, amount, kind }).where(r.eq(parent, r.param("parent", uuid)), r.ge(amount, 0n)).find({ id, amount, kind })
}).attach("children", (p) => query(S).rule((r) => {
	const { id } = v(R${child}, "r${child}")
	return r.match(R${child}, { id, parent: p.id }).find({ id })
}), "array")
export const byId${i} = query(S).rule((r) => {
	const { amount, label } = v(R${i}, "r${i}")
	return r.match(R${i}, { id: r.param("id", uuid), amount, label }).find({ amount, label })
})
export const byFilter${i} = query(S).rule((r) => {
	const { id, label } = v(R${i}, "r${i}")
	return r.match(R${i}, { id, label }).where(r.eq(id, r.param("id", uuid))).find({ label })
})
export const total${i} = query(S).rule((r) => {
	const { id, kind, qty } = v(R${i}, "r${i}")
	return r.match(R${i}, { id, kind, qty }).find({ kind, total: r.sum(qty), n: r.count() })
})
export const arms${i} = query(S).rule((r) => {
	const { id, amount } = v(R${i}, "r${i}")
	return r.match(R${i}, { id, kind: "A", amount }).find({ id, kind: Kind.handle("A"), amount })
}).rule((r) => {
	const { id, label } = v(R${i}, "r${i}")
	return r.match(R${i}, { id, kind: "B", label }).find({ id, kind: Kind.handle("B"), label })
}).orderBy(["kind", "asc"], ["id", "desc"])
export const imported${i} = query(S).rule((r) => {
	const { id: parent } = v(R${child}, "r${child}")
	const top = byParent${i}.bind({ parent })
	const { id, amount } = v(top, "top")
	return r.match(R${child}, { id: parent }).match(top, { id, amount }).find({ parent, id, amount })
})
export const owned${i} = query(S).rule((r) => {
	const { id, parent, kind } = v(R${i}, "r${i}")
	return r.match(R${i}, { id, parent, kind }).find({ id, parent, kind })
}).attach("owner", (p) => query(S).rule((r) => {
	const { label } = v(R${(i + relations - 1) % relations}, "r${(i + relations - 1) % relations}")
	return r.match(R${(i + relations - 1) % relations}, { id: p.parent, label }).find({ label })
}), ${i > 0 ? '"one"' : '"option"'}).attach("handle", (p) => query(S).rule((r) => r.match(Kind, { id: p.kind }).find({ handle: p.kind })), "one")
export const reads${i} = (db: DbOf<typeof Reader, unknown>) => [
	db.get(byId${i}, { id: "00000000-0000-4000-8000-000000000001" }),
	db.get(byFilter${i}, { id: "00000000-0000-4000-8000-000000000001" }),
	db.get(R${i}, { id: "00000000-0000-4000-8000-000000000001" }),
	db.execute(byParent${i}, { parent: "00000000-0000-4000-8000-000000000002" }),
	db.execute(arms${i}, {}),
	db.execute(total${i}.orderBy(["kind", "asc"]).take(1), {})
] as const
`
}

/**
 * The schema's statements: a candidate key on every fifth relation, a containment chain, each relation's kind
 * contained in the Kind roster, and every seventh relation mutable.
 */
const statements = (relations: number): string => {
	const lines: Array<string> = []
	for (let i = 0; i < relations; i++) {
		if (i % 5 === 0) {
			lines.push(`key(R${i}, ["label"])`)
		}
		if (i > 0) {
			lines.push(`contained(on(R${i}, "parent"), on(R${i - 1}, "id"))`)
		}
		lines.push(`contained(on(R${i}, "kind"), on(Kind, "id"))`)
		if (i % 7 === 0) {
			lines.push(`mutable(R${i})`)
		}
	}
	return Arr.join(
		Arr.map(lines, (line) => `\t${line}`),
		",\n"
	)
}

/**
 * Exact assertions over relation i, and refusals that widened inference would let through. R<i>.parent is contained
 * in R<i-1>.id for every i > 0, so a snapshot read of owned<i> delivers the owner bare there; R0's parent is in the last
 * relation, which no containment states, so R0's owner is an Option by its key.
 */
const assertions = (i: number): string => `
export type Params${i} = Expect<Equals<ParamsOf<typeof byParent${i}>, { readonly parent: ParamType<Uuid, "uuid"> }>>
export type Head${i} = Expect<
	Equals<
		HeadOf<typeof byParent${i}>,
		{
			readonly id: Uuid
			readonly amount: bigint
			readonly kind: "A" | "B" | "C"
			readonly children: ReadonlyArray<{ readonly id: Uuid }>
		}
	>
>
export type Total${i} = Expect<
	Equals<HeadOf<typeof total${i}>, { readonly kind: "A" | "B" | "C"; readonly total: bigint; readonly n: bigint }>
>
export type ById${i} = Expect<Equals<EvidenceOfQuery<typeof byId${i}>["card"], "atMostOne">>
export type ByFilter${i} = Expect<Equals<EvidenceOfQuery<typeof byFilter${i}>["card"], "atMostOne">>
export type ByParentCard${i} = Expect<Equals<EvidenceOfQuery<typeof byParent${i}>["card"], "many">>
export type ByParentKeys${i} = Expect<
	Equals<
		EvidenceOfQuery<typeof byParent${i}>["keys"],
		readonly [ReadonlyArray<"id" | "amount" | "kind">, ...ReadonlyArray<ReadonlyArray<"id">>]
	>
>
export type Arms${i} = Expect<
	Equals<
		HeadOf<typeof arms${i}>,
		| { readonly id: Uuid; readonly kind: "A"; readonly amount: bigint }
		| { readonly id: Uuid; readonly kind: "B"; readonly label: string }
	>
>
export type Imported${i} = Expect<Equals<keyof ParamsOf<typeof imported${i}>, never>>
export type Owned${i} = Expect<
	Equals<
		HeadOf<typeof owned${i}>,
		{
			readonly id: Uuid
			readonly parent: Uuid
			readonly kind: "A" | "B" | "C"
			readonly owner: ${i > 0 ? "{ readonly label: string }" : "Option.Option<{ readonly label: string }>"}
			readonly handle: { readonly handle: "A" | "B" | "C" }
		}
	>
>
export const refusals${i} = (db: DbOf<typeof Reader, unknown>) => [
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(byParent${i}, { parent: "00000000-0000-4000-8000-000000000002" }),
	// @ts-expect-error -- TS2322: the parameters are the ones the query's uses inferred
	db.execute(byParent${i}, { parent: 1 }),
	// @ts-expect-error -- TS2322: label is not common to every arm
	arms${i}.take(1).orderBy(["label", "asc"])
]
`

/**
 * What every generated type program imports, as relative paths: the public barrels, the ChangeSet types module
 * (WritesOf, which no barrel exports) and the declare-only Db type.
 */
export interface BudgetEntries {
	readonly query: string
	readonly schema: string
	readonly fields: string
	readonly text: string
	readonly changeset: string
	readonly changesetTypes: string
	readonly db: string
}

/**
 * The public barrels, the ChangeSet types module and the declare-only Db type, each spelled by `entry` as an import
 * specifier relative to a generated program's directory.
 */
export const entriesFrom = (entry: (path: string) => string): BudgetEntries => ({
	query: entry("packages/engine/src/public/query.ts"),
	schema: entry("packages/engine/src/public/schema.ts"),
	fields: entry("packages/engine/src/public/fields.ts"),
	text: entry("packages/engine/src/public/text.ts"),
	changeset: entry("packages/engine/src/public/changeset.ts"),
	changesetTypes: entry("packages/engine/src/types/changeset/changeset.ts"),
	db: entry("packages/grizzle/src/adapter/types/db.ts")
})

export const generateQuerySource = (relations: number, entries: BudgetEntries): string => {
	const names = Arr.join(
		Arr.map(indices(relations), (i) => `R${i}`),
		", "
	)
	const declarations = Arr.join(
		Arr.map(indices(relations), (i) => relationDeclaration(i)),
		""
	)
	const blocks = Arr.join(
		Arr.map(indices(relations), (i) => relationBlock(i, relations)),
		""
	)
	const checked = Arr.join(
		Arr.map([...new Set([0, relations - 1])], (i) => assertions(i)),
		""
	)
	return `// Generated by test/types/query/budget/generate.ts with ${relations} relations.
import type { Option } from "effect"
import { closedId, pg, type Uuid, uuid } from ${jsonText(entries.fields)}
import { type EvidenceOfQuery, type HeadOf, type ParamsOf, type ParamType, query, v } from ${jsonText(entries.query)}
import { closed, contained, key, mutable, on, relation, role, schema } from ${jsonText(entries.schema)}
import { str } from ${jsonText(entries.text)}
import type { DbOf } from ${jsonText(entries.db)}

type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

export const Label = str.regex("^[a-z]{1,32}$")
export const Kind = closed("Kind", ["A", "B", "C"])
${declarations}
export const S = schema("Gen", { Kind, ${names} }, [
${statements(relations)}
])
/** A full role reading every relation, which every program over S runs on. */
export const Reader = role(S, "reader", S.relations)
${blocks}${checked}`
}

/** The number of refusals the program carries. */
export const refusalCount = (relations: number): number => (relations === 1 ? 1 : 2) * 3
