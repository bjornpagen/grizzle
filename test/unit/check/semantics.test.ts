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
 * Plants (~/.cache/grizzle-release/BR04/plants): semantics-take-zero.patch (a take of zero is admitted),
 * semantics-member-extra-column.patch (a member's head may hold a column its relation lacks).
 *
 * Features: each declaration kind, each parameter situation admitted, each member rule and op, each kind of take
 * bound, and an item tagged at the label or at another.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	codePoint,
	constant,
	type Gen,
	int,
	map,
	string,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { double } from "@bjornpagen/testing/values"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { exprsOf } from "#compiler/ir/rel.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/compile.ts"
import {
	assert,
	defined,
	failed,
	placeOf,
	refusalLoc,
	refused,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import { decodedMember, f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationOf, localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { int4, numeric } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import type { Param, ProgramRead, Rule } from "#test/support/oracle/public/program.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { checkAuthored, checking, checkMemberOf, checkOptions } from "#test/support/policy.ts"
import { kindOfType, schemaDescOf } from "#test/unit/check/drawn.ts"
import {
	imported,
	lit,
	match,
	not,
	orderBy,
	param,
	plainVar,
	queryDesc,
	ref,
	relationSource,
	rule,
	take,
	varRef,
	vars
} from "#test/unit/check/dsl.ts"
import {
	type MemberCase,
	type MemberFeature,
	memberCaseGen,
	memberDesc,
	memberFeatures,
	memberVerdict
} from "#test/unit/check/members.ts"
import {
	type ParamFeature,
	paramCaseDesc,
	paramCaseGen,
	paramFeatures,
	paramVerdict
} from "#test/unit/check/params.ts"
import { Lab } from "#test/unit/check/schemas.ts"

/** Items and the labels they are tagged with, by small integers. */
const Tagged: SchemaDesc = {
	name: "Tagged",
	relations: [
		relation("Item", { id: f.integer }, ["id"]),
		relation("Tag", { item: f.integer, label: f.integer }, ["item", "label"])
	],
	statements: [],
	extends: undefined
}

/** Tagged as the reference reads its Base nodes. */
const taggedFacts: GenSchema = {
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
const untagged = queryDesc(
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

const taggedCaseGen: Gen<TaggedCase> = (source) => ({
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

type DeclaredFeature =
	| "a parameter declared by its field"
	| "a parameter declared by its base"
	| "a relation parameter"
	| "an import bound to the read's parameter"

/**
 * A generated read's checked parameters are exactly its own, scalar or relation, each of the type it is declared at
 * (scalar) or of its relation's heading (relation).
 */
const judgeDeclared = (read: QueryRead, q: LogicalQuery): ReadonlyArray<DeclaredFeature> => {
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
const memberLocOf = (
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
const checkedNames = Object.freeze({
	...productionNames("lab", { kind: "declared" }, localVectorSchema, labNames.codes),
	contractDomain: labNames.contractDomain
})

/** The greatest int4, the greatest bound a take admits. */
const int4Max = 2 ** 31 - 1

/** Whether a literal is a take's bound: an integer of int4's positive range. */
const withinInt4 = (value: number | string): boolean =>
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

type TakeBoundFeature = TakeBound["kind"] | "within" | "outside"

const takeBoundFeatures: Arr.NonEmptyReadonlyArray<TakeBoundFeature> = [
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

const takeBoundGen: Gen<TakeBound> = weighted<TakeBound>([
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

describe("the checker's parameter, member and bound rules", () => {
	it.effect(
		"give every generated read's checked query exactly the read's own parameters, each of the type it is declared at",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/semantics-declared",
						draw: drawn(caseSketchGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the generated program's parameters and the descriptors it declares them with"
						},
						coverage: required<DeclaredFeature>(
							[
								"a parameter declared by its field",
								"a parameter declared by its base",
								"a relation parameter",
								"an import bound to the read's parameter"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, k) =>
						Effect.sync(() => {
							const c = k.draw(resolveCase(sketch))
							const built = buildSchema(c.schema)
							for (const read of c.reads) {
								if (read.kind !== "query") {
									continue
								}
								const input = succeeded(
									queryInput(buildRoot(built, built.schema, read.query)),
									"the builder admits a generated read"
								)
								const q = succeeded(
									checkQuery(checking(built.schema), input.desc, checkOptions("declared")),
									"the checker admits a generated read"
								)
								k.noteAll(judgeDeclared(read, q))
							}
						})
				)
			)
	)

	it.effect(
		"type each query's own parameters by the declarations their uses share, never an import's own, join a variable's fields within one family, and refuse what those rules refuse",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/semantics-params",
						draw: drawn(paramCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the parameter rule restated over the drawn query (test/unit/check/params.ts)"
						},
						coverage: required<ParamFeature>(
							[
								"declarations of two families",
								"a bound variable of another family",
								"a computed negation over an outer variable",
								"a variable bound to fields of two families",
								"a variable joined across typmods or refinements",
								"a parameter widened",
								...Arr.map(
									[
										"a parameter a match binds",
										"a parameter a comparison reads",
										"a head parameter",
										"a negated source's parameter",
										"a computed negation over its own parameter",
										"a take's parameter",
										"an import bound to a parameter",
										"an import bound to a literal",
										"an import bound to a variable",
										"a negated import",
										"one name in two scopes"
									] as const,
									(f): readonly [ParamFeature, ParamFeature] => [f, "admitted"]
								)
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const v = paramVerdict(c)
							const features = paramFeatures(c, v)
							k.noteAll(features)
							for (const f of features) {
								if (f !== "admitted" && v.kind === "admitted") {
									k.pair(f, "admitted")
								}
							}
							const result = checkAuthored(
								checking(schemaDescOf(c.schema)),
								paramCaseDesc(c),
								checkOptions("params")
							)
							if (v.kind === "refused") {
								const e = failed(result, `refused under ${Arr.join(v.rules, ", ")}`)
								assert.ok(
									Arr.contains(v.reasons, e.reason._tag),
									`one of the reasons ${Arr.join(v.reasons, ", ")} (${Arr.join(v.rules, ", ")}), not ${e.reason._tag}`
								)
								return
							}
							const q = succeeded(result, "the query the parameter rule admits")
							assert.deepEqual(
								new Map(
									Arr.flatMap(q.params, (p) =>
										p.kind === "scalar" ? [[p.name, kindOfType(p.type)] as const] : []
									)
								),
								new Map(v.params),
								"each own parameter of its declarations' common type"
							)
						})
				)
			)
	)

	it.effect(
		"hold a member's head to its relation's heading for its op, every column entering its field at the field's own type, one heading and no attachment, refused at the member or the attachment",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/semantics-members",
						draw: drawn(memberCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the member rule restated over the drawn member (test/unit/check/members.ts)"
						},
						coverage: required<MemberFeature>(
							[
								"insert",
								"put",
								"delete",
								"admitted",
								"an attachment on an arm",
								"an attach stage",
								"no discriminant",
								"several headings",
								"a missing field",
								"an extra column",
								"a column of another type",
								"incompatible arms",
								"an insert leaving its serial field to its sequence",
								"an insert writing its serial field",
								"a put or delete without its serial field",
								"a parameter written as its field",
								"a sum written into a field",
								"two arms of one heading",
								"a numeric of another typmod",
								"a text of another pattern"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [
							{
								note: "a sum over a bigint, a computed numeric, written into a numeric(10, 2) field: compatible typed the head by its carrier alone and admitted it, where PostgreSQL's length coercion raises 22003 past the field's precision",
								sketch: {
									schema: {
										relations: [
											{
												name: "R0",
												fields: [{ name: "id", kind: "num10" }],
												key: ["id"],
												serial: false
											},
											{
												name: "R1",
												fields: [{ name: "id", kind: "int8" }],
												key: ["id"],
												serial: false
											}
										]
									},
									target: 0,
									op: "insert",
									arms: [
										{
											source: 1,
											writes: [{ field: "id", term: "sum" }],
											extra: false,
											tag: "none",
											attached: false
										}
									],
									attached: false
								},
								draws: "",
								reaches: ["a column of another type", "insert", "a sum written into a field"]
							}
						],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const v = memberVerdict(c)
							k.noteAll(memberFeatures(c, v))
							const result = checkMemberOf(checking(schemaDescOf(c.schema)), memberDesc(c), {})
							if (v.kind === "refused") {
								const e = refused(result, v.reason, v.rule)
								if (v.at !== "the union") {
									assert.deepEqual(
										placeOf(refusalLoc(e)),
										placeOf(memberLocOf(c, v.at)),
										`${v.rule}, located at ${v.at}`
									)
								}
								return
							}
							const q = succeeded(result, "the member the rule admits")
							assert.deepEqual(
								new Map(
									Arr.flatMap(q.params, (p) =>
										p.kind === "scalar" ? [[p.name, kindOfType(p.type)] as const] : []
									)
								),
								new Map(v.params),
								"each parameter of its field's kind"
							)
							const written = new Set(
								Arr.flatMap(exprClosure(Arr.flatMap(topoOrder(q.dag), (n) => exprsOf(n))), (e) =>
									e.kind === "param" && e.role === "write" ? [e.param] : []
								)
							)
							for (const name of v.params.keys()) {
								assert.ok(
									Arr.some(q.params, (p) => p.name === name && written.has(p.id)),
									`${name} is written as its field`
								)
							}
						})
				)
			)
	)

	it.effect(
		"bound take's parameter, which an import binds to a literal, by int4's positive range",
		(ctx) => {
			const top = take(
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
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a take's bound is an integer of int4's positive range, 1 to 2^31 - 1"
						},
						suite: "unit/check/semantics-take-bound",
						draw: drawn(takeBoundGen),
						literal: Formatter.format,
						coverage: required<TakeBoundFeature>(takeBoundFeatures, {
							cases: 60,
							sense: notesOnly
						}),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(bound, c) =>
						Effect.sync(() => {
							c.note(bound.kind)
							const importer = queryDesc(
								rule({
									vars: [plainVar("i")],
									matches: [match(imported(top, { k: lit(bound.value) }), { id: varRef("i") })],
									where: [],
									head: { id: varRef("i") },
									interiors: [],
									attach: []
								})
							)
							const r = checkAuthored(checking(Lab), importer, checkOptions("query"))
							if (withinInt4(bound.value)) {
								const q = succeeded(r, Formatter.format(bound))
								succeeded(
									lowerConservative(conservativeInput(q), {
										names: checkedNames,
										params: q.params,
										subject: { kind: "query" }
									}),
									"the admitted query lowers"
								)
								c.note("within")
							} else {
								refused(r, "MalformedDescription", Formatter.format(bound))
								c.note("outside")
							}
						})
				)
			)
		}
	)

	it.effect(
		"bind a negated match's parameter, which an import binds to a literal, to that literal",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the items no Tag holds at the item and the bound label"
						},
						suite: "unit/check/semantics-negated-literal",
						draw: drawn(taggedCaseGen),
						literal: Formatter.format,
						coverage: required<"an item tagged at the label" | "an item tagged at another label">(
							["an item tagged at the label", "an item tagged at another label"],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const importer = queryDesc(
								rule({
									vars: [plainVar("i")],
									matches: [match(imported(untagged, { l: lit(c.label) }), { id: varRef("i") })],
									where: [],
									head: { id: varRef("i") },
									interiors: [],
									attach: []
								})
							)
							const q = succeeded(
								checkAuthored(checking(Tagged), importer, checkOptions("query")),
								"the import"
							)
							const answer = Reference.of(q.dag, {
								schema: taggedFacts,
								facts: canonicalFacts({
									Item: Arr.map(c.items, (id) => [{ kind: "int", value: BigInt(id) }]),
									Tag: Arr.map(c.tags, ([item, label]) => [
										{ kind: "int", value: BigInt(item) },
										{ kind: "int", value: BigInt(label) }
									])
								}),
								params: {},
								observer: unobserved
							}).eval(q.dag.roots[0], noBindings)
							const tagged = (item: number, at: (label: number) => boolean): boolean =>
								Arr.some(c.tags, ([i, l]) => i === item && at(l))
							unorderedEqual(
								Arr.map(answer.rows, (row) => row[0]),
								Arr.map(
									Arr.filter(c.items, (item) => !tagged(item, (l) => l === c.label)),
									(item) => BigInt(item)
								)
							)
							for (const item of c.items) {
								if (tagged(item, (l) => l === c.label)) {
									k.note("an item tagged at the label")
								}
								if (tagged(item, (l) => l !== c.label) && !tagged(item, (l) => l === c.label)) {
									k.note("an item tagged at another label")
								}
							}
						})
				)
			)
	)
})
