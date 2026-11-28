import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case as PropertyCase } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Type } from "#compiler/public/compute.ts"
import {
	accumulated,
	closedId,
	drawn as drawnField,
	natural,
	int4,
	int8
} from "#compiler/public/fields.ts"
import {
	check,
	closed,
	counted,
	fin,
	fold,
	Monoid,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { type Generated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { fixtureTemplate, openedIn } from "#test/support/pg/reads/support.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { type SubstrateCase } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

const kinds = ["sum", "tuple"] as const
type KindHandle = (typeof kinds)[number]

/** Each kind's shape: the fewest and most parts a cell of it holds, and the least total of their weights. */
const shapes: Readonly<
	Record<KindHandle, { readonly min: bigint; readonly max: bigint; readonly floor: bigint }>
> = {
	sum: { min: 1n, max: 9n, floor: -1n },
	tuple: { min: 0n, max: 2n, floor: 0n }
}

const Kind = closed.ordered("Kind", kinds)
const Shape = closed.relation(
	"Shape",
	{ kind: closedId(Kind), min: int8, max: int8, floor: int8 },
	["kind"],
	Arr.map(kinds, (kind) => ({ kind, ...shapes[kind] }))
)

/** A cell's caller field `a`, its kind, and its parts, each a weight: `n` counts them, `total` sums them. */
const Cell = relation(
	"Cell",
	{
		id: int4,
		a: int4,
		kind: closedId(Kind),
		n: drawnField(natural),
		total: accumulated(int8, 0n)
	},
	["id"]
)
const Part = relation("Part", { cell: int4, at: int4, w: int8 }, ["cell", "at"])
const cellParts = counted(on(Part, "cell"), fin(Cell, "n"))
const cellTotal = fold(cellParts, Monoid.sum, on(Part, "cell", "w"), on(Cell, "id", "total"))

/** A cell as a case draws it: `a` from -1 to 1, its kind, and none to three parts, each weighing -2 to 2. */
interface Row {
	readonly a: number
	readonly kind: KindHandle
	readonly parts: ReadonlyArray<number>
}

/** The four rules, in the order this suite lists them: one over a caller field, one over the count through closed
 * reads, one over the fold's end through a closed read, and one over the count and the end. */
const rules = ["a", "arity", "floor", "balance"] as const
type Rule = (typeof rules)[number]

/** Whether `row`, as its write fills it, breaks `rule`: the rules restated over the drawn values, the oracle. */
const breaks = (rule: Rule, row: Row): boolean => {
	const n = BigInt(row.parts.length)
	const total = Arr.reduce(row.parts, 0n, (sum, w) => sum + BigInt(w))
	const shape = shapes[row.kind]
	switch (rule) {
		case "a":
			return row.a < 0
		case "arity":
			return n < shape.min || n > shape.max
		case "floor":
			return total < shape.floor
		case "balance":
			return n <= total
	}
}

/** Two namings of the rules whose CHECK names sort in opposite orders, so PostgreSQL tries the CHECKs in each. */
const namings = {
	forward: { a: "AlphaA", arity: "BetaArity", floor: "GammaFloor", balance: "DeltaBalance" },
	backward: { a: "ZetaA", arity: "YotaArity", floor: "XiFloor", balance: "OmegaBalance" }
} as const satisfies Readonly<Record<string, Readonly<Record<Rule, string>>>>

type Naming = keyof typeof namings

const namingNames: Arr.NonEmptyReadonlyArray<Naming> = ["forward", "backward"]

/** Cell's four rules, each a row CHECK declared under the name `naming` gives it, in the order of `rules`, then the
 * family of its parts and their fold. */
const cellsNamed = (label: string, naming: Naming) =>
	schema(
		label,
		[Kind, Shape, Cell, Part],
		[
			check(namings[naming].a, Cell, (x) => x.ge(x.a, 0)),
			check(namings[naming].arity, Cell, (x) =>
				x.and([
					x.ge(Type.base(x.n), Shape.at("min", x.kind)),
					x.le(Type.base(x.n), Shape.at("max", x.kind))
				])
			),
			check(namings[naming].floor, Cell, (x) => x.ge(x.total, Shape.at("floor", x.kind))),
			check(namings[naming].balance, Cell, (x) => x.gt(Type.base(x.n), x.total)),
			cellParts,
			cellTotal
		]
	)

/** The full role's workload over the cells of `cells`: cells inserted with their parts, both from each call's facts. */
const programsOf = (cells: ReturnType<typeof cellsNamed>) => ({
	write: ChangeSet.empty(cells).insert(Cell, []).insert(Part, [])
})

const rowGen: Gen<Row> = (source) => ({
	a: source.draw(int(-1, 1)),
	kind: source.draw(element(kinds)),
	parts: source.draw(array(int(-2, 2), { min: 0, max: 3 }))
})

/** The weights a part draws, and every list of none to three of them: rowGen's parts. */
const weights = [-2, -1, 0, 1, 2] as const
const listsOf = (length: number): ReadonlyArray<ReadonlyArray<number>> =>
	length === 0
		? [[]]
		: Arr.flatMap(listsOf(length - 1), (list) => Arr.map(weights, (w) => [...list, w]))

/**
 * Every cell of rowGen's box no rule refuses, enumerated once from the box (every kind, `a` from -1 to 1, every parts
 * list), so a stored cell is drawn among lawful cells alone, never drawn and discarded.
 */
const lawfulRows = nonEmpty(
	Arr.filter(
		Arr.flatMap(kinds, (kind) =>
			Arr.flatMap([-1, 0, 1], (a) =>
				Arr.flatMap([0, 1, 2, 3], (length) =>
					Arr.map(listsOf(length), (parts): Row => ({ a, kind, parts }))
				)
			)
		),
		(row) => !Arr.some(rules, (rule) => breaks(rule, row))
	),
	"the lawful cells of the box"
)

/** A cell no rule refuses, as one stored before the write is. */
const lawfulGen: Gen<Row> = element(lawfulRows)

/**
 * A cell stored before the write, which the write inserts again, an exact repeat: alone, so no read of the write looks
 * its key up, or with its parts stated again too, so its family's read finds it stored.
 */
interface Stored {
	readonly cell: Row
	readonly parts: "unstated" | "stated again"
}

const storedGen: Gen<Stored> = (source) => ({
	cell: source.draw(lawfulGen),
	parts: source.draw(element(["unstated", "stated again"] as const))
})

/**
 * A case: the cell the write inserts with its parts, `row`; the cells stored before it, each inserted again beside it;
 * and where its key falls among theirs, `at`: a stored cell's id is 2(i + 1), and the new cell's 2·at + 1.
 */
export interface CellCase {
	readonly row: Row
	readonly stored: ReadonlyArray<Stored>
	readonly at: number
}

export const cellCaseGen: Gen<CellCase> = (source) => {
	const stored = source.draw(array(storedGen, { min: 0, max: 2 }))
	return { row: source.draw(rowGen), stored, at: source.draw(int(0, stored.length)) }
}

export type CellFeature =
	| `${1 | 2 | 3} rules broken`
	| "accepted"
	| "the namings try the CHECKs in other orders"
	| "a count rule broken beside another"
	| "an end rule broken beside another"
	| "a rule over the count and the end broken beside another"
	| "a count rule an empty family breaks held beside a broken rule"
	| "an empty family beside a broken rule"
	| "a stored cell inserted again beside the refused one, which the refusal names"
	| "a stored cell inserted again that may be the refused one, unreported"
	| "a stored cell with its parts stated again beside a refused one"

/** The situation of a cell breaking `count` rules, one to three: no cell breaks both the floor and the balance, its
 * total below 0 for one and at least its count for the other. */
const brokenFeature = (count: number): CellFeature =>
	count >= 3 ? "3 rules broken" : count === 2 ? "2 rules broken" : "1 rules broken"

/** The rule a law names under `naming`: the check carrying that rule's name there. */
const ruleOf = (naming: Naming, law: Law): Rule =>
	defined(
		law.kind === "check"
			? Option.getOrUndefined(Arr.findFirst(rules, (r) => namings[naming][r] === law.name))
			: undefined,
		`a check of Cell's rules, not ${Formatter.format(law)}`
	)

/** Cells under the forward naming, and under the backward one, each with its programs. */
const forwardCells = cellsNamed("Forward", "forward")
const backwardCells = cellsNamed("Backward", "backward")
const forwardInstall = { label: "forward", programs: programsOf(forwardCells) } as const
const backwardInstall = { label: "backward", programs: programsOf(backwardCells) } as const

/**
 * Each naming's rules in the order every refusal names its laws (adapter/witness/classify.ts canonicalRefusal): by their
 * identities in code point order, a check's identity holding its declared name, so the two namings order the rules
 * apart, and neither by its CHECKs' installed names.
 */
const canonicalRules = (naming: Naming, cells: typeof forwardCells): ReadonlyArray<Rule> => {
	const ruled = Arr.flatMap(lawsOf(cells), ({ law, id }) =>
		law.kind === "check" ? [{ rule: ruleOf(naming, law), id: String(id) }] : []
	)
	return Arr.map(
		Arr.sort(
			ruled,
			Order.mapInput(Order.make(compareCodePoints), (r: { readonly id: string }) => r.id)
		),
		(r) => r.rule
	)
}

const rulesInOrder: Readonly<Record<Naming, ReadonlyArray<Rule>>> = {
	forward: canonicalRules("forward", forwardCells),
	backward: canonicalRules("backward", backwardCells)
}

/** Each naming's cells installed once per member as a read fixture, where the suite installed both before its cases. */
export const forwardTemplate = fixtureTemplate(import.meta, forwardCells, forwardInstall)
export const backwardTemplate = fixtureTemplate(import.meta, backwardCells, backwardInstall)

/**
 * A refused CHECK names every law its row breaks, as the write fills the row, against PostgreSQL 19.
 *
 * Cell holds four rules, each a row CHECK: a ≥ 0 over a caller field; its count `n` of parts within its kind's
 * [min, max], read through the closed relation Shape; its fold's end `total`, the sum of its parts' weights, at least
 * its kind's floor, through Shape; and n > total, over the count and the end, which an empty family breaks. Both n and total are grizzle's to fill:
 * an empty family's are 0, and each part the ChangeSet inserts beside the cell changes them, so a rule over them holds
 * or breaks at the values the write fills, never at the empty family's. The rules are installed twice, under two
 * namings whose CHECK names sort in opposite orders, so PostgreSQL, which tries a table's CHECKs in the order of their
 * names and reports the first that fails, reports another first under each. Each case stores none to two lawful cells,
 * then inserts one cell with none to three parts in one ChangeSet beside every stored cell inserted again, an exact
 * repeat, alone or with its parts, through both installations. The oracle is the rules restated over the drawn values,
 * the count the parts' number and the end their sum: a write whose new cell breaks none is accepted; any other is
 * refused by the first CHECK of the cell's in its installation's order, the rule PostgreSQL reports, since the INSERT
 * writes no stored cell. The write's family work is its one additions statement, which reads no row, so no read looks
 * up a cell it inserts: the host cannot tell a stored cell inserted again alone from a new one, and where such a stored
 * cell breaks the reported rule at an empty family's count and end, either may be the refused row, and the refusal names
 * that rule alone, `first`, its witness `unreported`. Every other refusal names `every` law the new cell breaks, exactly those,
 * each once, its witness the new cell's key, never a stored cell's, whichever CHECK PostgreSQL tried first. Each naming
 * lists the laws it names by their identities in code point order, the one order every refusal leaves the database in
 * (adapter/witness/classify.ts canonicalRefusal), a check's identity holding its declared name, never by its CHECKs'
 * installed names (4030e1cac), so the two namings list them apart: a case writes under both, each over its clone of its
 * naming's installation, where the suite held each naming's order alike across its cases.
 *
 * Its kept cases are a downstream tier's shape, an operator of two operands whose count its arity holds beside a
 * broken rule (qti-pie's p21-sum-as-condition, refused naming the arity too when the count was judged at the empty
 * family's), and a count too low and too high beside a broken rule, each with the arity CHECK tried first under one
 * naming and after under the other; and the re-insert shape the fallback audit found, a stored owner inserted again
 * beside a refused new one, once witnessed by the stored owner judged at an empty family. outcomes/witness.test.ts
 * names the bugs this search must catch.
 */
export const everyCase = (
	takenForward: SubstrateCase<Generated>,
	takenBackward: SubstrateCase<Generated>,
	k: CellCase,
	c: PropertyCase<CellFeature>
) =>
	Effect.gen(function* () {
		const forward = yield* openedIn(forwardCells, {}, forwardInstall, takenForward)
		const backward = yield* openedIn(backwardCells, {}, backwardInstall, takenBackward)
		const installations = { forward, backward } as const
		/** An installation's rules in the order PostgreSQL tries their CHECKs: their installed names' order. */
		const triedOf = (naming: Naming): ReadonlyArray<Rule> => {
			const o = installations[naming]
			const names = namesOf(o.installed)
			const named = Arr.map(Arr.zip(rules, o.schema.statements), ([rule, statement]) => ({
				rule,
				constraint: names.constraintOf(names.lawOf(statement), "TableCheck")
			}))
			return Arr.map(
				Arr.sort(
					named,
					Order.mapInput(Order.String, (n: { readonly constraint: string }) => n.constraint)
				),
				(n) => n.rule
			)
		}
		const tried: Record<Naming, ReadonlyArray<Rule>> = {
			forward: triedOf("forward"),
			backward: triedOf("backward")
		}
		const differ = Arr.join(tried.forward, ",") !== Arr.join(tried.backward, ",")

		const row = k.row
		const broken = Arr.filter(rules, (rule) => breaks(rule, row))
		const id = 2 * k.at + 1
		/** The stored cells, each with its id. */
		const stored = Arr.map(k.stored, (st, i) => ({ id: 2 * (i + 1), ...st }))
		const partsOf = (cell: number, parts: ReadonlyArray<number>) =>
			Arr.map(parts, (w, at) => ({ cell, at, w: BigInt(w) }))
		const storedCells = Arr.map(stored, (st) => ({
			id: st.id,
			a: st.cell.a,
			kind: st.cell.kind
		}))
		/** The cells the write inserts, the new one among the stored ones by key. */
		const cells = Arr.sort(
			[{ id, a: row.a, kind: row.kind }, ...storedCells],
			Order.mapInput(Order.Number, (cell: { readonly id: number }) => cell.id)
		)
		/** The stored cells no read of the write looks up: inserted again alone. */
		const unread = Arr.filter(k.stored, (st) => st.parts === "unstated")
		if (differ) {
			c.note("the namings try the CHECKs in other orders")
		}
		if (broken.length > 1) {
			c.noteAll([
				...(broken.includes("arity") ? ["a count rule broken beside another" as const] : []),
				...(broken.includes("floor") ? ["an end rule broken beside another" as const] : []),
				...(broken.includes("balance")
					? ["a rule over the count and the end broken beside another" as const]
					: [])
			])
		}
		if (Arr.isReadonlyArrayNonEmpty(broken)) {
			if (Arr.isReadonlyArrayEmpty(row.parts)) {
				c.note("an empty family beside a broken rule")
			}
			if (!broken.includes("arity") && breaks("arity", { ...row, parts: [] })) {
				c.note("a count rule an empty family breaks held beside a broken rule")
			}
		}
		for (const naming of namingNames) {
			const o = installations[naming]
			const outcome = yield* Effect.gen(function* () {
				const db = yield* Db.open(o.served.login.roles.app, {})
				if (Arr.isReadonlyArrayNonEmpty(k.stored)) {
					const storedParts = Arr.flatMap(stored, (st) => partsOf(st.id, st.cell.parts))
					const storing = yield* Effect.result(
						writeAnswerOf(
							db.workload.write.once({
								params: {},
								facts: { insert: { Cell: storedCells, Part: storedParts } }
							})
						)
					)
					assert.ok(
						Result.isSuccess(storing) && storing.success._tag === "accepted",
						"lawful cells are stored"
					)
				}
				const parts = [
					...partsOf(id, row.parts),
					...Arr.flatMap(stored, (st) =>
						st.parts === "stated again" ? partsOf(st.id, st.cell.parts) : []
					)
				]
				const applied = yield* Effect.result(
					writeAnswerOf(
						db.workload.write.once({
							params: {},
							facts: { insert: { Cell: cells, Part: parts } }
						})
					)
				)
				assert.ok(Result.isSuccess(applied), "the write is an outcome")
				return applied.success
			}).pipe(Effect.scoped, withLayer(o.served.layer))
			if (!Arr.isReadonlyArrayNonEmpty(broken)) {
				assert.equal(outcome._tag, "accepted")
				c.note("accepted")
				continue
			}
			if (outcome._tag !== "refused") {
				return assert.fail(
					`a cell breaking ${Arr.join(broken, ", ")} is refused, not ${outcome._tag}`
				)
			}
			const reported = defined(
				Option.getOrUndefined(Arr.findFirst(tried[naming], (rule) => broken.includes(rule))),
				"the rule PostgreSQL reports, the first of the new cell's in its CHECKs' order"
			)
			if (Arr.some(unread, (st) => breaks(reported, { ...st.cell, parts: [] }))) {
				assert.deepEqual(
					outcome.witness,
					{ kind: "unreported" },
					`${naming}: a stored cell no read looked up may be the refused row`
				)
				assert.equal(outcome.refused.kind, "first", `${naming}: the reported rule alone`)
				assert.deepEqual(
					Arr.map(refusedLaws(outcome.refused), (law) => ruleOf(naming, law)),
					[reported],
					`${naming}: the rule PostgreSQL reports`
				)
				c.note("a stored cell inserted again that may be the refused one, unreported")
				continue
			}
			if (outcome.refused.kind !== "every") {
				return assert.fail("a stated cell's refusal names every law it breaks")
			}
			const named: ReadonlyArray<Rule> = Arr.map(refusedLaws(outcome.refused), (law) =>
				ruleOf(naming, law)
			)
			assert.deepEqual(
				named,
				Arr.filter(rulesInOrder[naming], (rule) => broken.includes(rule)),
				`${naming}: every rule the cell breaks, each once, by identity in code point order`
			)
			assert.deepEqual(outcome.witness, {
				kind: "key",
				relation: "Cell",
				values: { id }
			})
			if (Arr.isReadonlyArrayNonEmpty(k.stored)) {
				c.note("a stored cell inserted again beside the refused one, which the refusal names")
			}
			if (Arr.some(k.stored, (st) => st.parts === "stated again")) {
				c.note("a stored cell with its parts stated again beside a refused one")
			}
			c.note(brokenFeature(broken.length))
		}
	})
