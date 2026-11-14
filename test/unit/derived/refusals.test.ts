/**
 * Runtime refusals for derived relations in descriptions TypeScript did not check (the type tests refuse each at the
 * type level): a JavaScript caller, or a SchemaDesc decoded from data, meets the same rules at construction or at
 * ownership, before any definition is read, and so at every entry that installs or analyzes a schema.
 *
 * - Statements over derived relations: each case draws a law of a drawn shape (a key over drawn fields, mutable, a
 *   check, a containment in either or both directions, a family whose member or owner or both are derived, an
 *   alternatives arm) over the worked example's Reports level with a second derived relation beside AccountBudget, each
 *   slot drawn among the derived relations or the base's sides of its type, at least one derived. Mutable, a family
 *   and an alternatives arm name rows grizzle writes, which a derived relation's definition states, so ownership
 *   refuses each (MalformedDescription) at every entry. A key, a check and a containment are rules over the
 *   definition, which ownership owns and the analysis of derived relations reads, and AccountBudget's definition
 *   aggregates, which no rule reads, so the entry that compiles the laws refuses each, by the named refusal the types
 *   name too. Oracle: that rule, restated per law shape. Plant: derived-law-relation-admitted (ownership admits a
 *   statement writing a derived relation's rows). Features: each law shape, a law naming both derived relations, a
 *   containment out of and into a derived relation.
 * - Unwritable definitions: levels, parameters and contexts an unchecked description can still write down are refused
 *   as MalformedDescription, a materialized view reading no parameter and holding no session. Each case draws a schema
 *   of the derived oracle (drawn levels and definitions over drawn base relations), which ownership admits, and one
 *   mutation of a drawn derived relation of it: moved into the root schema, joined by a twin of its level that reads
 *   it, given a drawn parameter in its first arm's condition, or given a drawn context's match there; where the
 *   mutation has a control without the defect (the twin a level up, the condition over a literal), ownership admits
 *   the control. The builder refuses a parameterized definition at construction. Oracle: a derived relation stands
 *   above the root, reads only lower levels, reads no parameter and matches no context. Plant:
 *   derived-definition-parameter-admitted (ownership admits a definition that reads one parameter). Features: each
 *   mutation.
 */
import { drawn, explore, sketched } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, type Gen, int, oneOf, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { checkedSchema, derivedAnalysis } from "#compiler/analysis/schema.ts"
import { type CompileError, isCompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type {
	ExprDesc,
	FieldDesc,
	QueryStageDesc,
	RuleDesc,
	SchemaDesc as LocatedSchemaDesc,
	SideDesc
} from "#compiler/ir/desc.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { uuid } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { admitDerived } from "#compiler/schema/relation.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import {
	type CaseSketch,
	buildSchema,
	caseSketchGen,
	type GenSchema
} from "#test/pg/derived/oracle/gen.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import {
	alternatives,
	check as checkDesc,
	contained,
	counted,
	f,
	field,
	fin,
	ge,
	key,
	literal,
	mutable,
	on,
	ordered,
	relation,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import { ReportsDesc, WorkDesc } from "#test/support/fixtures/ir/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { ownedInput, ownInput } from "#test/support/policy.ts"

/** The ownership of a generated value at the schema door: parsed there once, then owned. */
const ownedAtDoor = (value: unknown) => Result.flatMap(parseSchemaInput(value), ownInput)

const refusal = (r: Result.Result<unknown, CompileError>): CompileError => {
	if (r.ok) {
		throw new Error("expected a refusal")
	}
	return r.error
}

const budget = defined(ReportsDesc.relations[0], "AccountBudget")

/** The Reports level with a twin of AccountBudget beside it, so a law may name either derived relation. */
const twinned: SchemaDesc = {
	...ReportsDesc,
	relations: [...ReportsDesc.relations, { ...budget, name: "BudgetTwin" }]
}

/** The derived relations of the twinned level, and the fields each delivers. */
const derivedRelations: Arr.NonEmptyReadonlyArray<{
	readonly name: string
	readonly fields: Arr.NonEmptyReadonlyArray<string>
}> = nonEmpty(
	Arr.flatMap(twinned.relations, (r) =>
		r.kind === "derived" && r.query.stage.kind === "rules"
			? [
					{
						name: r.name,
						fields: nonEmpty(Rec.keys(Arr.headNonEmpty(r.query.stage.arms).head), "a heading")
					}
				]
			: []
	),
	"the derived relations"
)

/** Every uuid field of an ordinary relation of the base, as a one-field side. */
const baseUuidSides: Arr.NonEmptyReadonlyArray<{
	readonly relation: string
	readonly field: string
}> = nonEmpty(
	Arr.flatMap(WorkDesc.relations, (r) =>
		r.kind === "relation"
			? Arr.flatMap(Rec.toEntries(r.fields), ([name, decl]) =>
					decl.type.kind === "uuid" ? [{ relation: r.name, field: name }] : []
				)
			: []
	),
	"the base's uuid fields"
)

/** A slot of a law: one of the derived relations, by a pick, or a side of the base, by a pick. */
type Slot =
	| { readonly kind: "derived"; readonly pick: number }
	| { readonly kind: "base"; readonly pick: number }

/** A law's shape and its slots; at least one slot is derived. */
type LawSketch =
	| { readonly kind: "key"; readonly derived: number; readonly fields: ReadonlyArray<number> }
	| { readonly kind: "mutable"; readonly derived: number }
	| { readonly kind: "check"; readonly derived: number; readonly name: number }
	| { readonly kind: "contained"; readonly left: Slot; readonly right: Slot }
	| {
			readonly kind: "family"
			readonly ordered: boolean
			readonly member: Slot
			readonly owner: Slot
	  }
	| { readonly kind: "alternatives"; readonly derived: number; readonly handle: boolean }

/** Two slots, at least one derived. */
const slotPairGen: Gen<readonly [Slot, Slot]> = (source) => {
	const derivedSlot = (): Slot => ({ kind: "derived", pick: source.draw(pickGen) })
	const baseSlot = (): Slot => ({ kind: "base", pick: source.draw(pickGen) })
	switch (source.draw(int(0, 2))) {
		case 0:
			return [derivedSlot(), baseSlot()]
		case 1:
			return [baseSlot(), derivedSlot()]
		default:
			return [derivedSlot(), derivedSlot()]
	}
}

const lawSketchGen: Gen<LawSketch> = oneOf<LawSketch>([
	(source) => ({
		kind: "key",
		derived: source.draw(pickGen),
		fields: source.draw(array(pickGen, { min: 1, max: 3 }))
	}),
	(source) => ({ kind: "mutable", derived: source.draw(pickGen) }),
	(source) => ({ kind: "check", derived: source.draw(pickGen), name: source.draw(int(0, 9)) }),
	(source) => {
		const [left, right] = source.draw(slotPairGen)
		return { kind: "contained", left, right }
	},
	(source) => {
		const [member, owner] = source.draw(slotPairGen)
		return { kind: "family", ordered: source.draw(boolean), member, owner }
	},
	(source) => ({
		kind: "alternatives",
		derived: source.draw(pickGen),
		handle: source.draw(boolean)
	})
])

const derivedAt = (pick: number) =>
	defined(derivedRelations[pickIndex(pick, derivedRelations.length)], "a derived relation")

const sideOf = (slot: Slot): SideDesc => {
	if (slot.kind === "derived") {
		return on(derivedAt(slot.pick).name, ["account"])
	}
	const side = defined(baseUuidSides[pickIndex(slot.pick, baseUuidSides.length)], "a base side")
	return on(side.relation, [side.field])
}

/** A law's Description and the derived relations it names. */
const lawOf = (
	law: LawSketch
): { readonly statement: StatementDesc; readonly named: ReadonlyArray<string> } => {
	const slotNames = (slots: ReadonlyArray<Slot>) =>
		Arr.flatMap(slots, (s) => (s.kind === "derived" ? [derivedAt(s.pick).name] : []))
	switch (law.kind) {
		case "key": {
			const d = derivedAt(law.derived)
			const fields = Arr.map(law.fields, (pick) =>
				defined(d.fields[pickIndex(pick, d.fields.length)], "a field")
			)
			return { statement: key(on(d.name, Arr.dedupe(fields))), named: [d.name] }
		}
		case "mutable":
			return {
				statement: mutable(derivedAt(law.derived).name),
				named: [derivedAt(law.derived).name]
			}
		case "check": {
			const d = derivedAt(law.derived)
			return {
				statement: checkDesc(`Positive${law.name}`, d.name, ge(field("tasks"), literal(0n))),
				named: [d.name]
			}
		}
		case "contained":
			return {
				statement: contained(sideOf(law.left), sideOf(law.right)),
				named: slotNames([law.left, law.right])
			}
		case "family": {
			const member = sideOf(law.member)
			const slots =
				law.owner.kind === "derived"
					? fin(derivedAt(law.owner.pick).name, "tasks")
					: fin("Account", "n")
			return {
				statement: law.ordered ? ordered(member, slots) : counted(member, slots),
				named: slotNames([law.member, law.owner])
			}
		}
		case "alternatives": {
			const d = derivedAt(law.derived)
			const Kind = { name: "Kind", handles: ["Automatic", "Manual"] }
			const Task = relation("Task", { id: f.uuid, account: f.uuid, kind: f.closedId("Kind") }, [
				"id"
			])
			return {
				statement: alternatives(Task, "kind", Kind, {
					[law.handle ? "Automatic" : "Manual"]: { name: d.name, primaryKey: ["account"] }
				}),
				named: [d.name]
			}
		}
	}
}

/** What each entry that reads a schema makes of it, in order: ownership, the analysis of derived relations, and the
 * installation, which compiles the laws. */
const entries = (desc: SchemaDesc): ReadonlyArray<Result.Result<unknown, CompileError>> => [
	ownedInput(desc),
	Result.map(
		Result.flatMap(ownedInput(desc), (owned) => checkedSchema(owned, everySlice(owned))),
		derivedAnalysis
	),
	Result.flatMap(ownedInput(desc), (o) =>
		compileInstallation(o, withDerivedRelations(installOptions(o, "owner")))
	)
]

/** Every entry that reads a schema refuses it alike: the refusal, at each. */
const refusalsEverywhere = (desc: SchemaDesc): ReadonlyArray<CompileError> =>
	Arr.map(entries(desc), refusal)

/** Whether a drawn statement names the rows grizzle writes, which ownership refuses over a derived relation. */
const writesRows = (law: LawSketch): boolean =>
	law.kind === "mutable" || law.kind === "family" || law.kind === "alternatives"

type LawFeature =
	| `law ${LawSketch["kind"]}`
	| "a law naming both derived relations"
	| "a containment out of a derived relation"
	| "a containment into a derived relation"

/** A mutation of a drawn derived relation, by a pick, of a generated schema. */
type Mutation =
	| { readonly kind: "a derived relation in a root schema"; readonly target: number }
	| { readonly kind: "a definition that reads its own level"; readonly target: number }
	| {
			readonly kind: "a parameterized definition"
			readonly target: number
			readonly parameter: number
	  }
	| {
			readonly kind: "a definition that matches a context"
			readonly target: number
			readonly claim: number
	  }

interface UnwritableSketch {
	readonly schema: CaseSketch
	readonly mutation: Mutation
}

const mutationGen: Gen<Mutation> = weighted<Mutation>([
	[1, (s) => ({ kind: "a derived relation in a root schema", target: s.draw(pickGen) })],
	[1, (s) => ({ kind: "a definition that reads its own level", target: s.draw(pickGen) })],
	[
		1,
		(s) => ({
			kind: "a parameterized definition",
			target: s.draw(pickGen),
			parameter: s.draw(int(0, 9))
		})
	],
	[
		1,
		(s) => ({
			kind: "a definition that matches a context",
			target: s.draw(pickGen),
			claim: s.draw(int(0, 9))
		})
	]
])

const unwritableGen: Gen<UnwritableSketch> = (source) => ({
	schema: source.draw(caseSketchGen),
	mutation: source.draw(mutationGen)
})

/** The levels of a schema Description, the root first. */
const levelsOf = (desc: LocatedSchemaDesc): Arr.NonEmptyReadonlyArray<LocatedSchemaDesc> =>
	desc.extends === undefined ? [desc] : Arr.append(levelsOf(desc.extends), desc)

/** A level of a Description as a mutation rewrites it: its relations, any a description may write down. */
type Level = Omit<LocatedSchemaDesc, "relations" | "extends"> & {
	readonly relations: ReadonlyArray<unknown>
}

/** The levels rebuilt into one Description, each extending the one before it. */
const chained = (levels: Arr.NonEmptyReadonlyArray<Level>): unknown =>
	Arr.reduce(
		Arr.tailNonEmpty(levels),
		{ ...Arr.headNonEmpty(levels), extends: undefined },
		(below: unknown, level) => ({ ...level, extends: below })
	)

/** A stage with its first arm, the first rules arm its input chain reaches, rewritten by `f`. */
const withFirstArm = (stage: QueryStageDesc, f: (arm: RuleDesc) => RuleDesc): QueryStageDesc => {
	switch (stage.kind) {
		case "rules":
			return { ...stage, arms: [f(Arr.headNonEmpty(stage.arms)), ...Arr.tailNonEmpty(stage.arms)] }
		case "union":
			return { ...stage, arms: [f(Arr.headNonEmpty(stage.arms)), ...Arr.tailNonEmpty(stage.arms)] }
		case "recursive":
			return {
				...stage,
				recursive: {
					...stage.recursive,
					base: [
						f(Arr.headNonEmpty(stage.recursive.base)),
						...Arr.tailNonEmpty(stage.recursive.base)
					]
				}
			}
		case "attach":
		case "named":
		case "order":
		case "take":
		case "approx":
			return { ...stage, input: withFirstArm(stage.input, f) }
	}
}

/**
 * A generated schema's Description mutated as `m` says, and where one exists its control: the same change without the
 * defect (the reading twin a level up, the condition over a literal in place of the parameter), which ownership admits,
 * so the refusal is the defect's.
 */
const mutated = (
	gen: GenSchema,
	m: Mutation
): { readonly defective: unknown; readonly control: Option.Option<unknown> } => {
	const desc = defined(schemaDescOf(gen.value), "a generated schema's Description")
	const levels = levelsOf(desc)
	const root = Arr.headNonEmpty(levels)
	const candidates = nonEmpty(
		m.kind === "a derived relation in a root schema"
			? Arr.filter(gen.derived, (d) => d.level === 1)
			: gen.derived,
		"a derived relation to mutate"
	)
	const target = defined(candidates[pickIndex(m.target, candidates.length)], "the target")
	const level = defined(levels[target.level], `level ${target.level}`)
	const targetDesc = defined(
		Option.getOrUndefined(Arr.findFirst(level.relations, (r) => r.name === target.name)),
		`${target.name}'s Description`
	)
	if (targetDesc.kind !== "derived") {
		return assert.fail(`${target.name} is derived`)
	}
	const replaced = (relations: ReadonlyArray<unknown>): Arr.NonEmptyReadonlyArray<Level> =>
		Arr.map(levels, (l, i): Level => (i === target.level ? { ...l, relations } : l))
	switch (m.kind) {
		case "a derived relation in a root schema":
			return {
				defective: { ...root, relations: [...root.relations, targetDesc] },
				control: Option.none()
			}
		case "a definition that reads its own level": {
			const column = Arr.headNonEmpty(nonEmpty(target.columns, "a column")).name
			const twinAt = (derivedLevel: number) => ({
				kind: "derived" as const,
				name: `${target.name}x`,
				level: derivedLevel,
				storage: "materialized" as const,
				query: {
					stage: {
						kind: "rules" as const,
						arms: [
							{
								vars: [{ id: "x", origin: { relation: target.name, field: column } }],
								matches: [
									{
										source: { kind: "relation" as const, name: target.name },
										bindings: { [column]: { kind: "var" as const, var: "x" } }
									}
								],
								where: [],
								head: { [column]: { kind: "var" as const, var: "x" } },
								interiors: [],
								attach: []
							}
						]
					}
				}
			})
			const above = target.level + 1
			const twinAbove = twinAt(targetDesc.level + 1)
			const control: Arr.NonEmptyReadonlyArray<Level> =
				above < levels.length
					? Arr.map(levels, (l, i): Level =>
							i === above ? { ...l, relations: [...l.relations, twinAbove] } : l
						)
					: Arr.append<Level, Level>(levels, {
							...Arr.lastNonEmpty(levels),
							name: `${root.name}_${levels.length}`,
							relations: [twinAbove],
							statements: []
						})
			return {
				defective: chained(replaced([...level.relations, twinAt(targetDesc.level)])),
				control: Option.some(chained(control))
			}
		}
		case "a parameterized definition": {
			const uuidType: FieldDesc = { kind: "uuid" }
			const conditioned = (operand: ExprDesc) =>
				chained(
					replaced(
						Arr.map(level.relations, (r) =>
							r.name === target.name && r.kind === "derived"
								? {
										...r,
										query: {
											...r.query,
											stage: withFirstArm(r.query.stage, (arm) => ({
												...arm,
												where: [
													...arm.where,
													{ kind: "compare", op: "eq", left: operand, right: operand }
												]
											}))
										}
									}
								: r
						)
					)
				)
			return {
				defective: conditioned({ kind: "param", name: `p${m.parameter}`, type: uuidType }),
				control: Option.some(
					conditioned({
						kind: "literal",
						value: "00000000-0000-4000-8000-000000000001",
						type: uuidType
					})
				)
			}
		}
		case "a definition that matches a context": {
			const context = {
				name: `Session${m.claim}`,
				fields: { sub: { kind: "uuid" as const } },
				claim: undefined
			}
			const defective = chained(
				replaced(
					Arr.map(level.relations, (r) =>
						r.name === target.name && r.kind === "derived"
							? {
									...r,
									query: {
										...r.query,
										stage: withFirstArm(r.query.stage, (arm) => {
											const first = defined(arm.matches[0], "the arm's first match")
											return {
												...arm,
												matches: [
													...arm.matches,
													{ ...first, source: { kind: "context", context }, bindings: {} }
												]
											}
										})
									}
								}
							: r
					)
				)
			)
			return { defective, control: Option.none() }
		}
	}
}

describe("derived relation refusals", () => {
	it.effect(
		"refuse a statement writing a derived relation's rows at every entry, and a rule over an aggregate where the laws compile",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/statements-over-derived",
						draw: drawn(lawSketchGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a statement naming rows grizzle writes is refused at every entry; a rule over a definition that aggregates is owned and refused where the laws compile"
						},
						coverage: required<LawFeature>(
							[
								"law key",
								"law mutable",
								"law check",
								"law contained",
								"law family",
								"law alternatives",
								"a law naming both derived relations",
								"a containment out of a derived relation",
								"a containment into a derived relation"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(law, c) =>
						Effect.sync(() => {
							c.note(`law ${law.kind}`)
							const { statement, named } = lawOf(law)
							if (Arr.dedupe(named).length > 1) {
								c.note("a law naming both derived relations")
							}
							if (law.kind === "contained") {
								if (law.left.kind === "derived") {
									c.note("a containment out of a derived relation")
								}
								if (law.right.kind === "derived") {
									c.note("a containment into a derived relation")
								}
							}
							const desc = { ...twinned, statements: [...twinned.statements, statement] }
							if (writesRows(law)) {
								for (const e of refusalsEverywhere(desc)) {
									assert.ok(e.reason._tag === "MalformedDescription", e.message)
								}
								return
							}
							const [owned, analyzed, installed] = entries(desc)
							assert.ok(owned?.ok === true, "ownership owns a rule over a derived relation")
							assert.ok(analyzed?.ok === true, "the analysis of derived relations reads it")
							const e = refusal(defined(installed, "the installation's entry"))
							assert.ok(e.reason._tag === "Refused", e.message)
							assert.equal(
								e.reason.refusal,
								"a rule reads a derived relation whose definition joins, selects and projects: this one aggregates"
							)
						})
				)
			)
	)

	it.effect(
		"refuse a level, parameter or context an unchecked description can still write down",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/unwritable",
						draw: sketched(unwritableGen, (s) => ({
							gen: buildSchema(s.schema, { name: "Gen" }),
							mutation: s.mutation
						})),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a derived relation stands above the root, reads only lower levels, reads no parameter and matches no context"
						},
						coverage: required<Mutation["kind"]>(
							[
								"a derived relation in a root schema",
								"a definition that reads its own level",
								"a parameterized definition",
								"a definition that matches a context"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ gen, mutation }, c) =>
						Effect.sync(() => {
							c.note(mutation.kind)
							assert.ok(ownedAtDoor(gen.value).ok, "the generated schema is admitted")
							const { defective, control } = mutated(gen, mutation)
							const reason = refusal(ownedAtDoor(defective)).reason
							assert.equal(reason._tag, "MalformedDescription", mutation.kind)
							if (Option.isSome(control)) {
								const admitted = ownedAtDoor(control.value)
								assert.ok(admitted.ok, admitted.ok ? "" : admitted.error.message)
							}
							if (mutation.kind === "a parameterized definition") {
								const base = Arr.headNonEmpty(nonEmpty(gen.base, "a base relation"))
								const column = Arr.headNonEmpty(nonEmpty(base.columns, "a column")).name
								const parameterized = queryOver(gen.value).rule((r: RuleValue) => {
									const vars = varsOver(base.value, "base")
									const p = r.param(`p${mutation.parameter}`, uuid)
									return r
										.match(base.value, { [column]: vars[column] })
										.where(r.eq(p, p))
										.find({ [column]: vars[column] })
								})
								assert.throws(
									() => admitDerived(`P${mutation.parameter}`, parameterized, "materialized", []),
									(e) => isCompileError(e) && e.reason._tag === "MalformedDescription"
								)
							}
						})
				)
			)
	)
})
