/**
 * The growing-schema generator, one type test of inference at scale. It writes one
 * TypeScript program over the declare-only skeleton with `relations` relations, and for each relation the shapes the
 * seven statement readers see: candidate keys, containments, mutability, a parameterized query with an
 * attachment, a keyed lookup, a grouped aggregate, a ChangeSet with a read-back, and reads and applies through Db.
 *
 * The program also asserts what is inferred, at the first relation and at the last, so it fails at any size where
 * inference widens rather than only where it stops typechecking: exact parameters, heads, evidence,
 * keys and contract hosts, and refusals that must keep firing. Each refusal carries a `@ts-expect-error -- TSnnnn`
 * directive, which the harness checks the way it checks the fixtures.
 *
 * The relation count whose refusals the type-test batch checks.
 */
import { Array as Arr } from "effect"
import { indices } from "#test/support/oracle/pick.ts"
import type { BudgetEntries } from "#test/types/query/budget/generate.ts"
export const largestSkeletonSize = 200

const relationDeclaration = (i: number): string =>
	`export const R${i} = relation("R${i}", { id: uuid, parent: uuid, amount: Cents, label: Label, kind: closedId(Kind), qty: pg.integer }, ["id"])\n`

/** One relation's queries, ChangeSet and database calls. */
const relationBlock = (i: number, relations: number): string => {
	const child = (i + 1) % relations
	return `
export const byParent${i} = query(S).rule((r) => {
	const { id, parent, amount, kind } = v(R${i})
	return r.match(R${i}, { id, parent, amount, kind }).where(r.eq(parent, r.param("parent", uuid)), r.ge(amount, 0n)).find({ id, amount, kind })
}).attach("children", (p) => query(S).rule((r) => {
	const { id } = v(R${child})
	return r.match(R${child}, { id, parent: p.id }).find({ id })
}), "array")
export const byId${i} = query(S).rule((r) => {
	const { amount, label } = v(R${i})
	return r.match(R${i}, { id: r.param("id", uuid), amount, label }).find({ amount, label })
})
export const total${i} = query(S).rule((r) => {
	const { id, kind, qty } = v(R${i})
	return r.match(R${i}, { id, kind, qty }).find({ kind, total: r.sum(qty), n: r.count() })
})
export const owned${i} = query(S).rule((r) => {
	const { id, parent, kind } = v(R${i})
	return r.match(R${i}, { id, parent, kind }).find({ id, parent, kind })
}).attach("owner", (p) => query(S).rule((r) => {
	const { label } = v(R${(i + relations - 1) % relations})
	return r.match(R${(i + relations - 1) % relations}, { id: p.parent, label }).find({ label })
}), ${i > 0 ? '"one"' : '"option"'}).attach("handle", (p) => query(S).rule((r) => r.match(Kind, { id: p.kind }).find({ handle: p.kind })), "one")
export const change${i} = ChangeSet.empty(S)
	.insert(R${i}, [{ id: "x", parent: "y", amount: Cents(1n), label: "abc", kind: "A", qty: 1 }])
	.read("added", (d) => query(S).rule((r) => {
		const { id } = v(d.added(R${i}))
		return r.match(d.added(R${i}), { id }).find({ id })
	}))
export const run${i} = [
	db.get(byId${i}, { id: "x" }),
	db.get(R${i}, { id: "x" }),
	db.execute(byParent${i}, { parent: "p" }),
	db.execute(total${i}.orderBy(["kind", "asc"]).take(1), {}),
	db.apply(change${i}, {})
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
 * Exact assertions over relation i: parameters, heads (an attachment's array, Option and bare shapes included),
 * evidence, keys and the contract host; and refusals that widened inference would let through.
 */
const assertions = (i: number, relations: number): string => {
	const owner = (i + relations - 1) % relations
	return `
export type Params${i} = Expect<Equals<ParamsOf<typeof byParent${i}>, { readonly parent: string }>>
export type Head${i} = Expect<
	Equals<
		HeadOf<typeof byParent${i}>,
		{
			readonly id: string
			readonly amount: Cents
			readonly kind: "A" | "B" | "C"
			readonly children: ReadonlyArray<{ readonly id: string }>
		}
	>
>
export type Total${i} = Expect<
	Equals<HeadOf<typeof total${i}>, { readonly kind: "A" | "B" | "C"; readonly total: bigint; readonly n: bigint }>
>
export type ById${i} = Expect<Equals<EvidenceOfQuery<typeof byId${i}>["card"], "atMostOne">>
export type ByParentCard${i} = Expect<Equals<EvidenceOfQuery<typeof byParent${i}>["card"], "many">>
export type Owned${i} = Expect<
	Equals<
		HeadOf<typeof owned${i}>,
		{
			readonly id: string
			readonly parent: string
			readonly kind: "A" | "B" | "C"
			readonly owner: ${i > 0 ? "{ readonly label: string }" : "Option.Option<{ readonly label: string }>"}
			readonly handle: { readonly handle: "A" | "B" | "C" }
		}
	>
>
export type Keys${i} = Expect<Equals<KeysOf<typeof S, typeof R${i}>, ${i % 5 === 0 ? 'readonly ["id"] | readonly ["label"]' : 'readonly ["id"]'}>>
export type Amount${i} = Expect<Equals<Fact<typeof R${i}>["amount"], bigint & Brand.Brand<"Cents">>>
export type ChangeWrites${i} = Expect<Equals<WritesOf<typeof change${i}>, "R${i}">>
// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only relations its role's write list names
export const readerApply${i} = reader.apply(change${i}, {})
// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
export const manyGet${i} = db.get(byParent${i}, { parent: "p" })
// @ts-expect-error -- TS2322: the parameters are the ones the query's uses inferred
export const wrongParams${i} = db.execute(byParent${i}, { parent: 1 })
// @ts-expect-error -- TS2345 refusal: the query's head is not a fact of the relation
export const wrongMember${i} = ChangeSet.empty(S).insert(R${owner}, owned${i})
`
}

/**
 * A complete program over `relations` relations that imports the public barrels, WritesOf and the declare-only Db type
 * from `entries`: the schema facade and its statements from the schema barrel, ChangeSet from the changeset barrel,
 * the descriptors from the fields barrel, str from the text barrel, query and v from the query barrel.
 */
export const generateSchemaSource = (relations: number, entries: BudgetEntries): string => {
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
		Arr.map([...new Set([0, relations - 1])], (i) => assertions(i, relations)),
		""
	)
	return `// Generated by test/types/skeleton/budget/generate.ts with ${relations} relations.
import type { Brand, Option } from "effect"
import type { WritesOf } from ${JSON.stringify(entries.changesetTypes)}
import type { DbOf } from ${JSON.stringify(entries.db)}
import { closed, contained, type Fact, key, type KeysOf, mutable, on, relation, role, schema } from ${JSON.stringify(entries.schema)}
import { ChangeSet } from ${JSON.stringify(entries.changeset)}
import { closedId, contract, pg, uuid } from ${JSON.stringify(entries.fields)}
import { str } from ${JSON.stringify(entries.text)}
import { type EvidenceOfQuery, type HeadOf, type ParamsOf, query, v } from ${JSON.stringify(entries.query)}

type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Cents = bigint & Brand.Brand<"Cents">

export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
export const Label = str.regex("^[a-z]{1,32}$")
export const Kind = closed("Kind", ["A", "B", "C"])
${declarations}
export const S = schema("Gen", { Kind, ${names} }, [
${statements(relations)}
])
/** A full reader and a full writer of every relation, which every program over S runs on. */
export const Reader = role(S, "reader", S.relations)
export const Writer = role(S, "writer", S.relations, { write: [${Arr.join(
		Arr.map(indices(relations), (i) => `"R${i}"`),
		", "
	)}] })
declare const db: DbOf<typeof Writer, unknown>
declare const reader: DbOf<typeof Reader, unknown>
${blocks}${checked}`
}
