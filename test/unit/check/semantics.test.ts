import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, element, int, oneOf, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { formatLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { exprsOf } from "#compiler/ir/rel.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { assert, defined, failed, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { decodedMember } from "#test/support/fixtures/ir/desc.ts"
import { installationOf, localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { numeric } from "#test/support/oracle/gen/domain.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import type { Param, ProgramRead, Rule } from "#test/support/oracle/public/program.ts"
import { checking, checkMemberOf, checkOptions } from "#test/support/policy.ts"
import { kindOfType, schemaDescOf } from "#test/unit/check/drawn.ts"
import {
	imported,
	lit,
	match,
	orderBy,
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
const checkedNames = {
	...productionNames("lab", { kind: "declared" }, localVectorSchema, labNames.codes),
	contractDomain: labNames.contractDomain
}

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
							const result = checkQuery(
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
		"hold a member's head to its relation's heading for its op, every column of its field's family, one heading and no attachment, refused at the member or the attachment",
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
								"two arms of one heading"
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
							const v = memberVerdict(c)
							k.noteAll(memberFeatures(c, v))
							const result = checkMemberOf(checking(schemaDescOf(c.schema)), memberDesc(c), {})
							if (v.kind === "refused") {
								const e = refused(result, v.reason, v.rule)
								if (v.at !== "the union") {
									assert.equal(
										formatLoc(refusalLoc(e)),
										formatLoc(memberLocOf(c, v.at)),
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
			type Bound = "within" | "outside"
			return searched(
				ctx,
				explore(
					{
						suite: "unit/check/semantics-take-bound",
						draw: drawn(
							oneOf<number | string>([
								element([0, 1, 2 ** 31 - 1, 2 ** 31, -1, 1.5, "3"]),
								int(1, 2 ** 31 - 1),
								int(-(2 ** 40), 0),
								int(2 ** 31, 2 ** 40),
								double(-Number.MAX_VALUE, Number.MAX_VALUE),
								string(codePoint(0x20, 0x7e), { min: 0, max: 3 })
							])
						),
						literal: Formatter.format,
						coverage: required<Bound>(["within", "outside"], { cases: 60, sense: notesOnly }),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(bound, c) =>
						Effect.sync(() => {
							const importer = queryDesc(
								rule({
									vars: [plainVar("i")],
									matches: [match(imported(top, { k: lit(bound) }), { id: varRef("i") })],
									where: [],
									head: { id: varRef("i") },
									interiors: [],
									attach: []
								})
							)
							const r = checkQuery(checking(Lab), importer, checkOptions("query"))
							const within =
								typeof bound === "number" &&
								Number.isInteger(bound) &&
								bound >= 1 &&
								bound <= 2 ** 31 - 1
							if (within) {
								const q = defined(succeeded(r, String(bound)), "a checked query")
								succeeded(
									lowerConservative(conservativeInput(q), {
										names: checkedNames,
										params: q.params,
										subject: { kind: "query" }
									}),
									"the admitted query lowers"
								)
							} else {
								refused(r, "MalformedDescription", String(bound))
							}
							c.note(within ? "within" : "outside")
						})
				)
			)
		}
	)
})
