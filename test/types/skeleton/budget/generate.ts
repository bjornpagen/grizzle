import { Array as Arr } from "effect"
import { indices } from "#compiler/core/array.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"

/**
 * The growing-schema ChangeSet program, one type test of write inference at scale. It writes one TypeScript program
 * over the public barrels with `relations` relations, each with a contract column, and for each relation a ChangeSet
 * with a read-back applied through the handle of a workload over the full role Writer that serves it alone, each call
 * giving its insert's facts, beside the queries it writes from. The query shapes at scale are the
 * growing-schema query program's (test/types/query/budget/generate.ts); this one holds what it lacks.
 *
 * The program asserts what is inferred at the first relation and at the last, so it fails at any size where inference
 * widens rather than only where it stops typechecking: a contract host through a query head, candidate keys, the
 * relations a ChangeSet writes, and refusals that must keep firing. Each refusal carries a
 * `@ts-expect-error -- TSnnnn` directive, which the harness checks the way it checks the fixtures.
 *
 * The relation count whose refusals the type-test batch checks.
 */
export const largestSkeletonSize = 200

const relationDeclaration = (i: number): string =>
	`export const R${i} = relation("R${i}", { id: uuid, parent: uuid, amount: Cents, label: Label, kind: closedId(Kind), qty: pg.integer }, ["id"])\n`

/** One relation's queries, ChangeSet and apply. */
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
export const owned${i} = query(S).rule((r) => {
	const { id, parent, kind } = v(R${i}, "r${i}")
	return r.match(R${i}, { id, parent, kind }).find({ id, parent, kind })
})
export const change${i} = ChangeSet.empty(S)
	.insert(R${i}, [{ id: "00000000-0000-4000-8000-000000000001", parent: "00000000-0000-4000-8000-000000000002", amount: Cents(1n), label: "abc", kind: "A", qty: 1 }])
	.read("added", (d) => query(S).rule((r) => {
		const { id } = v(d.added(R${i}), "addedR${i}")
		return r.match(d.added(R${i}), { id }).find({ id })
	}))
export const w${i} = workload(Writer, { change: change${i} })
export const run${i} = (db: DbOf<typeof Writer, typeof w${i}.programs>) =>
	db.workload.change.apply({ R${i}: [{ id: "00000000-0000-4000-8000-000000000003", parent: "00000000-0000-4000-8000-000000000002", amount: Cents(2n), label: "abd", kind: "B", qty: 2 }] }, {})
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
			lines.push(`key(on(R${i}, "label"))`)
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
 * Exact assertions over relation i: the contract host in a query head, keys and the relations a ChangeSet writes; and
 * refusals that widened inference would let through.
 */
const assertions = (i: number, relations: number): string => {
	const owner = (i + relations - 1) % relations
	return `
export type Head${i} = Expect<
	Equals<
		HeadOf<typeof byParent${i}>,
		{
			readonly id: Uuid
			readonly amount: Cents
			readonly kind: "A" | "B" | "C"
			readonly children: ReadonlyArray<{ readonly id: Uuid }>
		}
	>
>
export type Keys${i} = Expect<Equals<KeysOf<typeof S, typeof R${i}>, ${i % 5 === 0 ? 'readonly ["id"] | readonly ["label"]' : 'readonly ["id"]'}>>
export type Amount${i} = Expect<Equals<Fact<typeof R${i}>["amount"], bigint & Brand.Brand<"Cents">>>
export type ChangeWrites${i} = Expect<Equals<WritesOf<typeof change${i}>, "R${i}">>
// @ts-expect-error -- TS2322: a ChangeSet of a workload over a role writes only relations its role's write list names
export const readerWork${i} = workload(Reader, { change: change${i} })
// @ts-expect-error -- TS2345 refusal: the query's head is not a fact of the relation
export const wrongMember${i} = ChangeSet.empty(S).insert(R${owner}, owned${i})
`
}

/**
 * A complete program over `relations` relations, its imports read through the gates' prelude as `entries` reaches it.
 */
export const generateSchemaSource = (relations: number, entries: PreludeAt): string => {
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
	return preludeProgram(
		`// Generated by test/types/skeleton/budget/generate.ts with ${relations} relations.`,
		entries,
		`type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
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
export const Reader = role(S, "reader", wholeEntriesOf(S))
export const Writer = role(S, "writer", wholeEntriesOf(S), { write: writableNamesOf(S) })
${blocks}${checked}`
	)
}
