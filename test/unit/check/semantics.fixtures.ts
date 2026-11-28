/**
 * The checker's parameter, member and bound rules (check/), each against its rule restated over drawn inputs:
 *
 * - **Declared parameters:** every generated read's checked query holds exactly the read's own parameters, scalar or
 *   relation, each of the type it is declared at or of its relation's heading.
 * - **Parameter typing:** each query's own parameters take the type the declarations their uses share, never an
 *   import's own, a variable's fields join within one family, and what those rules refuse is refused for one of their
 *   reasons (test/unit/check/params.ts).
 * - **Members:** a member's head is held to its relation's heading for its op, every column entering its field at the
 *   field's own type, one heading and no attachment, refused for its rule at the member or the attachment's place
 *   (test/unit/check/members.ts).
 * - **A take's bound:** an import that binds a take's parameter to a literal is admitted, and lowers, exactly when the
 *   literal is an integer in int4's positive range, and refused as a MalformedDescription otherwise.
 * - **A negated match's parameter:** an import binding it to a literal answers the items no Tag holds at that label.
 *
 * Oracles: the generated program's own parameters and declarations; the parameter and member rules restated as
 * checkers; int4's positive range; and the reference evaluator against the items no Tag holds at the label.
 *
 * Features: each declaration kind, each parameter situation admitted, each member rule and op, each kind of take
 * bound, and an item tagged at the label or at another.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	aimed,
	type Aimed,
	codePoint,
	constant,
	type Gen,
	int,
	map,
	string,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { double } from "@bjornpagen/testing/values"
import { Array as Arr, Option } from "effect"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { decodedMember, f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationOf, localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { int4, numeric } from "#test/support/oracle/gen/domain.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import type { Param, ProgramRead, Rule } from "#test/support/oracle/public/program.ts"
import {
	match,
	not,
	orderBy,
	param,
	queryDesc,
	ref,
	relationSource,
	rule,
	take,
	vars
} from "#test/support/unit/check/dsl.ts"
import {
	type MemberCase,
	memberCaseGen,
	memberDesc,
	type MemberFeature,
	otherKindCaseGen
} from "#test/unit/check/members.ts"
import { Lab } from "#test/unit/check/schemas.ts"

/** Items and the labels they are tagged with, by small integers. */
export const Tagged: SchemaDesc = {
	name: "Tagged",
	relations: [
		relation("Item", { id: f.integer }, ["id"]),
		relation("Tag", { item: f.integer, label: f.integer }, ["item", "label"])
	],
	statements: [],
	bases: []
}

/** Tagged as the reference reads its Base nodes. */
export const taggedFacts: GenSchema = {
	name: "Tagged",
	relations: [
		{
			name: "Item",
			columns: [{ name: "id", type: int4 }],
			primaryKey: ["id"],
			keys: [],
			mutable: false
		},
		{
			name: "Tag",
			columns: [
				{ name: "item", type: int4 },
				{ name: "label", type: int4 }
			],
			primaryKey: ["item", "label"],
			keys: [],
			mutable: false
		}
	],
	closed: [],
	containments: []
}

/** The items no Tag holds at the label `l`, a parameter the query declares. */
export const untagged = queryDesc(
	rule({
		vars: vars("Item", "id"),
		matches: [match(relationSource("Item"), { id: ref("Item", "id") })],
		where: [not(relationSource("Tag"), { item: ref("Item", "id"), label: param("l", f.integer) })],
		head: { id: ref("Item", "id") },
		interiors: [],
		attach: []
	})
)

/** A database of Tagged, over items 0 to 3 and labels 0 to 2, and the label an import binds `l` to. */
interface TaggedCase {
	readonly items: ReadonlyArray<number>
	readonly tags: ReadonlyArray<readonly [number, number]>
	readonly label: number
}

export const taggedCaseGen: Gen<TaggedCase> = (source) => ({
	items: source.draw(subarray([0, 1, 2, 3])),
	tags: source.draw(
		subarray(
			Arr.flatMap([0, 1, 2, 3], (item) => Arr.map([0, 1, 2], (label) => [item, label] as const))
		)
	),
	label: source.draw(int(0, 2))
})

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

/**
 * The type a generated parameter is declared at: its field's own for a field declaration; for a base declaration, the
 * descriptor of its type's carrier the program builds it with, the wide numeric for a numeric (build.ts
 * paramDescriptor), and its type for every other.
 */
const declaredType = (p: Param): ScalarType =>
	p.declaration.kind === "field"
		? p.declaration.field.type
		: p.type.carrier === "numeric"
			? numeric
			: p.type

/** Whether a rule of a read imports a query whose parameter its bind map binds to one of the read's own. */
const bindsParam = <P>(rules: ReadonlyArray<Rule<P>>): boolean =>
	Arr.some(rules, (r) =>
		Arr.some(
			r.matches,
			(m) => m.source.kind === "import" && Arr.some(m.source.binds, (b) => b.to.kind === "param")
		)
	)

export type DeclaredFeature =
	| "a parameter declared by its field"
	| "a parameter declared by its base"
	| "a relation parameter"
	| "an import bound to the read's parameter"

/**
 * A generated read's checked parameters are exactly its own, scalar or relation, each of the type it is declared at
 * (scalar) or of its relation's heading (relation).
 */
export const judgeDeclared = (read: QueryRead, q: LogicalQuery): ReadonlyArray<DeclaredFeature> => {
	const scalars = Arr.flatMap(q.params, (p) =>
		p.kind === "scalar" ? [{ name: p.name, type: p.type }] : []
	)
	assert.deepEqual(
		Arr.sort(
			Arr.map(scalars, (p) => p.name),
			(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
		),
		Arr.sort(
			Arr.map(read.params, (p) => p.name),
			(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
		),
		"the read's own scalar parameters"
	)
	for (const p of read.params) {
		const checked = defined(
			Arr.findFirst(scalars, (s) => s.name === p.name).pipe(Option.getOrUndefined)
		)
		assert.ok(sameScalarType(checked.type, declaredType(p)), `${p.name} of its declared type`)
	}
	for (const r of read.relations) {
		const checked = Arr.findFirst(q.params, (p) => p.name === r.name).pipe(Option.getOrUndefined)
		assert.ok(checked?.kind === "relation", `${r.name} a relation parameter`)
		const heading = checked.heading
		assert.equal(heading.length, r.relation.fields.length, `${r.name}'s heading`)
		for (const f of r.relation.fields) {
			const column = Arr.findFirst(heading, (h) => h.name === f.name).pipe(Option.getOrUndefined)
			assert.ok(
				column !== undefined && sameScalarType(column.type, f.type),
				`${r.name}.${f.name} of its field's type`
			)
		}
	}
	return [
		...(Arr.some(read.params, (p) => p.declaration.kind === "field")
			? ["a parameter declared by its field" as const]
			: []),
		...(Arr.some(read.params, (p) => p.declaration.kind === "base")
			? ["a parameter declared by its base" as const]
			: []),
		...(read.relations.length > 0 ? ["a relation parameter" as const] : []),
		...(bindsParam(read.query.arms) ? ["an import bound to the read's parameter" as const] : [])
	]
}

/** Where a member refusal must be located, in the member as the write frontend decodes it. */
export const memberLocOf = (
	c: MemberCase,
	at: "member" | "arm attachment" | "stage attachment"
): SourceLoc => {
	const decoded = decodedMember(memberDesc(c))
	if (at === "member") {
		return decoded.loc
	}
	const source = decoded.member
	if (source.kind !== "query") {
		return assert.fail("a member described by a query")
	}
	const stage = source.query.stage
	if (at === "stage attachment") {
		return stage.kind === "attach" ? stage.attach.loc : assert.fail("an attach stage")
	}
	const rules = stage.kind === "attach" ? stage.input : stage
	if (rules.kind !== "rules") {
		return assert.fail("a member of rules")
	}
	const attached = Arr.findFirst(rules.arms, (a) => a.attach.length > 0)
	return Option.match(attached, {
		onNone: () => assert.fail("an attached arm"),
		onSome: (arm) => defined(arm.attach[0], "the arm's attachment").loc
	})
}

/** The names a checked query of Lab lowers under: production's stand-ins for its relations and its codes. */
const labNames = installationOf(Lab, { kind: "declared" }).names
export const checkedNames = Object.freeze({
	...productionNames("lab", { kind: "declared" }, localVectorSchema, labNames.codes),
	contractDomain: labNames.contractDomain
})

/** The greatest int4, the greatest bound a take admits. */
const int4Max = 2 ** 31 - 1

/** Whether a literal is a take's bound: an integer of int4's positive range. */
export const withinInt4 = (value: number | string): boolean =>
	typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= int4Max

/**
 * A literal a take's bound is bound to, by what it is: the range's ends and the integers between, and each way a
 * literal leaves the range or is no integer, every one a case of its own.
 */
type TakeBound = Readonly<{
	kind:
		| "the least bound"
		| "the greatest bound"
		| "a bound between"
		| "zero"
		| "a negative integer"
		| "one past the greatest"
		| "an integer past int4"
		| "a fraction"
		| "a double"
		| "a bound's digits as text"
		| "other text"
	value: number | string
}>

export type TakeBoundFeature = TakeBound["kind"] | "within" | "outside"

export const takeBoundFeatures: Arr.NonEmptyReadonlyArray<TakeBoundFeature> = [
	"the least bound",
	"the greatest bound",
	"a bound between",
	"zero",
	"a negative integer",
	"one past the greatest",
	"an integer past int4",
	"a fraction",
	"a double",
	"a bound's digits as text",
	"other text",
	"within",
	"outside"
]

const boundOf =
	(kind: TakeBound["kind"]) =>
	(value: number | string): TakeBound => ({ kind, value })

export const takeBoundGen: Gen<TakeBound> = weighted<TakeBound>([
	[2, constant(boundOf("the least bound")(1))],
	[2, constant(boundOf("the greatest bound")(int4Max))],
	[4, map(int(2, int4Max - 1), boundOf("a bound between"))],
	[2, constant(boundOf("zero")(0))],
	[2, map(int(-(2 ** 40), -1), boundOf("a negative integer"))],
	[2, constant(boundOf("one past the greatest")(int4Max + 1))],
	[2, map(int(int4Max + 2, 2 ** 40), boundOf("an integer past int4"))],
	[2, map(int(-(2 ** 20), 2 ** 20), (n) => boundOf("a fraction")(n + 0.5))],
	[2, map(double(-Number.MAX_VALUE, Number.MAX_VALUE), boundOf("a double"))],
	[2, map(int(1, int4Max), (n) => boundOf("a bound's digits as text")(String(n)))],
	[2, map(string(codePoint(0x20, 0x7e), { min: 0, max: 3 }), boundOf("other text"))]
])

/** The items of Lab by their quantity, greatest first, bounded by a take of the parameter `k`. */
export const top = take(
	orderBy(
		queryDesc(
			rule({
				vars: vars("Item", "id", "qty"),
				matches: [
					match(relationSource("Item"), { id: ref("Item", "id"), qty: ref("Item", "qty") })
				],
				where: [],
				head: { id: ref("Item", "id"), qty: ref("Item", "qty") },
				interiors: [],
				attach: []
			})
		),
		["qty", "desc"]
	),
	"k"
)

/**
 * The member cases, aimed at a member writing its field from another kind of the field's family, which a drawn schema
 * seldom pairs: a numeric of another typmod, or a text of another pattern.
 */
export const memberCaseSpace: Aimed<MemberCase, MemberFeature> = aimed(memberCaseGen, [
	["a numeric of another typmod", otherKindCaseGen(["num10", "num12"])],
	["a text of another pattern", otherKindCaseGen(["lower", "code", "prose"])]
])
