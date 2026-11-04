import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import type { SchemaDesc, StatementDesc } from "#compiler/ir/desc.ts"
import { type ConstraintOwner, constraintLaw } from "#compiler/ir/products.ts"
import { compileLaws, constraintOwner, type LawModel } from "#compiler/laws/model/model.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	type AnySchema,
	check,
	key,
	relation,
	type Statement,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import {
	Employee,
	Employer,
	PayLine,
	Payroll,
	Posting,
	Reporting
} from "#test/support/fixtures/api/payroll.ts"
import * as P from "#test/support/fixtures/ir/payroll.ts"
import * as Q from "#test/support/fixtures/ir/queue.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import {
	constraintOf,
	installationNamesOf,
	installationOf,
	lawIdOf,
	lawNamesOf,
	type NamingSubject
} from "#test/support/kernel/naming.ts"
import { argumentsOf } from "#test/support/list.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * Every key statement of the payroll fixture, rebuilt through the public builder, with its constraint named by its
 * relation and fields in `schema`.
 */
const declaredKeys = (subject: AnySchema): ReadonlyArray<readonly [Statement, ConstraintName]> => [
	[key(Employer, ["ein"]), constraintOf(subject, Employer, "key", ["ein"])],
	[
		key(Employee, ["employer", "code"]),
		constraintOf(subject, Employee, "key", ["employer", "code"])
	],
	[key(PayLine, ["run", "employee"]), constraintOf(subject, PayLine, "key", ["run", "employee"])],
	[key(Posting, ["line", "account"]), constraintOf(subject, Posting, "key", ["line", "account"])]
]

/** Every statement of a schema description, at every level. */
const levelStatements = (desc: SchemaDesc): ReadonlyArray<StatementDesc> => [
	...desc.statements,
	...(desc.extends === undefined ? [] : levelStatements(desc.extends))
]

/**
 * The alternatives expansions among a schema's statements, each as the desc helper spells one: the contained head its
 * origin marks, then the mirrors arms it marks.
 */
const alternativesExpansions = (
	statements: ReadonlyArray<StatementDesc>
): ReadonlyArray<ReadonlyArray<StatementDesc>> => {
	const origins = new Set(
		Arr.flatMap(statements, (s) =>
			(s.kind === "contained" || s.kind === "mirrors") && s.origin !== undefined
				? [s.origin.alternatives]
				: []
		)
	)
	return Arr.map([...origins], (origin) => {
		const marked = Arr.filter(
			statements,
			(s) => (s.kind === "contained" || s.kind === "mirrors") && s.origin?.alternatives === origin
		)
		return [
			...Arr.filter(marked, (s) => s.kind === "contained"),
			...Arr.filter(marked, (s) => s.kind === "mirrors")
		]
	})
}

/**
 * The constraint of the one tagged foreign key from an alternatives arm into its parent, among the law model's natives:
 * the arm's own foreign key, which a field set alone does not tell from another foreign key of the arm's key fields.
 */
const taggedForeignKey = (
	model: LawModel,
	arm: string,
	parent: string
): { readonly owner: ConstraintOwner; readonly ident: ConstraintName } => {
	const keys = Arr.flatMap(model.natives, (n) =>
		n.namespace === "constraint" &&
		n.object.kind === "TaggedForeignKey" &&
		n.object.relation.name === arm &&
		n.object.target.name === parent
			? [{ owner: { kind: "table", name: n.owner } as const, ident: identifierOf(n.named) }]
			: []
	)
	const [only, ...more] = keys
	if (only === undefined || more.length > 0) {
		return assert.fail(`${arm} has ${keys.length} tagged foreign keys into ${parent}`)
	}
	return only
}

/** The declared relation and field of an installed table and column, as ownership registered them. */
const declaredColumn = (owned: Owned, table: string, column: string): readonly [string, string] => {
	const [found] = Arr.flatMap(Rec.values(owned.relations), (owner) =>
		owner.ident === table
			? Arr.flatMap(Rec.values(owner.fields), (field) =>
					field.column === column ? [[owner.name, field.name] as const] : []
				)
			: []
	)
	return found ?? assert.fail(`no owned field is installed as ${table}.${column}`)
}

type CrossCheck = "named native" | "alternatives expansion" | "checked contract" | "text domain"

/**
 * A row check's predicate shape over two leaves (t <> '' and t IN ('ca')): a connective over an optional leaf and a
 * nested chain of up to two unary connectives over a leaf, so ownership's canonical operand order (schema/own.ts) differs
 * from the written one, and a singleton conjunction sits under a disjunction.
 */
type Leaf = "ne" | "in"
type Connective = "and" | "or"
type Shape =
	| { readonly kind: "leaf"; readonly leaf: Leaf }
	| { readonly kind: Connective; readonly args: readonly [Shape] | readonly [Shape, Shape] }

const leaves: ReadonlyArray<Leaf> = ["ne", "in"]
const connectives: ReadonlyArray<Connective> = ["and", "or"]
const leafShape = (leaf: Leaf): Shape => ({ kind: "leaf", leaf })
const chains = (leaf: Leaf): ReadonlyArray<Shape> => [
	leafShape(leaf),
	...Arr.map(connectives, (c): Shape => ({ kind: c, args: [leafShape(leaf)] })),
	...Arr.flatMap(connectives, (outer) =>
		Arr.map(connectives, (inner): Shape => ({
			kind: outer,
			args: [{ kind: inner, args: [leafShape(leaf)] }]
		}))
	)
]

const shapes: Arr.NonEmptyReadonlyArray<Shape> = nonEmpty(
	Arr.flatMap(connectives, (top) =>
		Arr.flatMap(leaves, (leaf) =>
			Arr.flatMap(chains(leaf), (chain): ReadonlyArray<Shape> => [
				{ kind: top, args: [chain] },
				...Arr.map(leaves, (other): Shape => ({ kind: top, args: [leafShape(other), chain] }))
			])
		)
	),
	"row check shapes"
)

type ShapeFeature = "and under or" | "singleton and"

/** The features of a shape, `underOr` whether its parent is a disjunction. */
const shapeFeatures = (shape: Shape, underOr: boolean): ReadonlyArray<ShapeFeature> => {
	if (shape.kind === "leaf") {
		return []
	}
	const own: ReadonlyArray<ShapeFeature> = [
		...(shape.kind === "and" && underOr ? (["and under or"] as const) : []),
		...(shape.kind === "and" && shape.args.length === 1 ? (["singleton and"] as const) : [])
	]
	return [...own, ...Arr.flatMap(shape.args, (arg) => shapeFeatures(arg, shape.kind === "or"))]
}

const Item = relation("Item", { id: pg.integer, t: str.regex("^[a-c]{0,3}$") }, ["id"])

/** A row check has no parameters, so its predicate's parameter map is unknown. */
const predicateOf = (shape: Shape, r: RowScalars<typeof Item>): Predicate => {
	if (shape.kind === "leaf") {
		return shape.leaf === "ne" ? r.ne(r.t, "") : r.in(r.t, ["ca"])
	}
	const [first, ...rest] = shape.args
	return r[shape.kind](
		predicateOf(first, r),
		...argumentsOf(Arr.map(rest, (arg) => predicateOf(arg, r)))
	)
}
const checkOf = (shape: Shape): Statement => check("H", Item, (r) => predicateOf(shape, r))

/** The subjects, by a name the exhaustion's report prints in place of the schema. */
const subjects = {
	Work: W.WorkDesc,
	Queue: Q.Queue,
	"Payroll desc": P.PayrollDesc,
	Payroll
} satisfies Readonly<Record<string, NamingSubject>>

/** The levels of the extended payroll schema, by name: the base schema and the schema that extends it. */
const levels = { Payroll, Reporting } satisfies Readonly<Record<string, AnySchema>>

describe("production names from src", () => {
	it.effect(
		"name a key statement's law as the law its constraint reports, at every level of an extended schema",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/kernel/naming-key-levels",
						generator: element<keyof typeof levels>(["Payroll", "Reporting"]),
						literal: Formatter.format,
						/** The space is the two levels: the base schema and the schema that extends it. */
						limit: 2,
						coverage: requiredInSpace<keyof typeof levels>(["Payroll", "Reporting"]),
						caseHang: Duration.minutes(2)
					},
					(name, c) =>
						Effect.sync(() => {
							const level: AnySchema = levels[name]
							c.note(name)
							const owned = ownedInput(level)
							assert.ok(owned.ok, level.name)
							const model = compileLaws(owned.value)
							assert.ok(model.ok, level.name)
							const declared = declaredKeys(level)
							assert.equal(
								declared.length,
								Arr.filter(level.statements, (s) => s.kind === "key").length,
								"every key statement of every level is named"
							)
							for (const [statement, constraint] of declared) {
								const [entry, ...more] = Arr.filter(
									model.value.constraints,
									(k) => k.name === constraint
								)
								assert.ok(
									entry !== undefined && more.length === 0,
									`${constraint} is one constraint`
								)
								assert.equal(
									constraintLaw(model.value.constraintToLaw, constraintOwner(entry), constraint),
									lawIdOf(level, statement),
									constraint
								)
							}
						})
				)
			)
	)

	it.effect(
		"name a row check's law by a statement rebuilt in its written operand order, which ownership reorders",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/kernel/naming-owned-form",
						generator: element(shapes),
						literal: Formatter.format,
						/**
						 * The space is every shape above: 2 connectives x 2 leaves x 7 chains x 3 left operands (none or
						 * a leaf).
						 */
						limit: 84,
						coverage: requiredInSpace<ShapeFeature>(["and under or", "singleton and"]),
						caseHang: Duration.minutes(2)
					},
					(shape, c) =>
						Effect.sync(() => {
							c.noteAll(shapeFeatures(shape, false))
							const L = lawNamesOf(schema("S", { Item }, [checkOf(shape)]))
							const theory = Arr.filter(
								L.model.theory.laws,
								(l) => l.detail.kind === "check" && l.detail.name === "H"
							)
							const [declared, ...more] = theory
							if (declared === undefined || more.length > 0) {
								return assert.fail("the schema's one row check is one law")
							}
							assert.equal(L.lawOf(checkOf(shape)), declared.id)
						})
				)
			)
	)

	it.effect(
		"agree with src's own records at every named native, alternatives expansion, checked contract and text domain",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/kernel/naming",
						generator: element<keyof typeof subjects>(["Work", "Queue", "Payroll desc", "Payroll"]),
						literal: Formatter.format,
						/** The space is the four fixtures, each a schema the door names. */
						limit: 4,
						coverage: requiredInSpace<CrossCheck>([
							"named native",
							"alternatives expansion",
							"checked contract",
							"text domain"
						]),
						caseHang: Duration.minutes(2)
					},
					(name, c) =>
						Effect.sync(() => {
							const subject: NamingSubject = subjects[name]
							const L = lawNamesOf(subject)
							const theory = new Set<LawId>(Arr.map(L.model.theory.laws, (l) => l.id))
							for (const native of L.model.natives) {
								const idents: ReadonlyArray<readonly [ConstraintOwner, ConstraintName]> =
									native.namespace === "constraint" || native.namespace === "index"
										? [[{ kind: "table", name: native.owner }, identifierOf(native.named)]]
										: native.namespace === "domain" && native.check.kind === "checked"
											? [[{ kind: "domain", name: native.owner }, native.check.ident]]
											: []
								for (const [owner, ident] of idents) {
									c.note("named native")
									const law = L.lawOfConstraint(owner, ident)
									assert.ok(
										theory.has(law),
										`${ident} reports ${law}, which is no law of the theory`
									)
									assert.equal(L.constraintOf(law, native.object.kind), ident)
								}
							}
							for (const expansion of alternativesExpansions(levelStatements(L.model.owned.desc))) {
								c.note("alternatives expansion")
								const laws = L.alternativesOfDesc(expansion)
								const all = [laws.head, laws.reverse, ...Rec.values(laws.arms)]
								assert.equal(
									new Set(all).size,
									all.length,
									"head, arm and reverse laws are distinct"
								)
								const [head, ...arms] = expansion
								assert.ok(head?.kind === "contained", "an expansion's head")
								const discriminator = head.left.fields[0]
								const triggered = new Set(
									Arr.map(L.residual(laws.reverse).units, (u) => u.relation)
								)
								assert.ok(
									triggered.has(head.left.relation),
									`the reverse law triggers on ${head.left.relation}`
								)
								for (const arm of arms) {
									assert.ok(arm.kind === "mirrors", "an expansion's arm")
									const handle = arm.left.selection[discriminator]
									assert.ok(
										typeof handle === "string",
										`the handle of the arm ${arm.right.relation}`
									)
									const fk = taggedForeignKey(L.model, arm.right.relation, head.left.relation)
									assert.equal(laws.arms[handle], L.lawOfConstraint(fk.owner, fk.ident), handle)
									assert.ok(
										triggered.has(arm.right.relation),
										`the reverse law triggers on ${arm.right.relation}`
									)
								}
							}
							const N = installationNamesOf(installationOf(subject, { kind: "declared" }))
							for (const contractName of Rec.keys(N.model.owned.contracts)) {
								const contract = N.contract(contractName)
								if (contract.kind === "brand") {
									continue
								}
								c.note("checked contract")
								assert.equal(
									N.lawOfConstraint({ kind: "domain", name: contract.domain }, contract.constraint),
									contract.law,
									contractName
								)
							}
							for (const domain of N.installation.textDomains) {
								for (const use of domain.uses) {
									c.note("text domain")
									const [owner, field] = declaredColumn(N.model.owned, use.table, use.column)
									const named = N.textDomain({ name: owner }, field)
									assert.equal(
										named.law,
										N.lawOfConstraint({ kind: "domain", name: named.domain }, named.constraint),
										`${owner}.${field}`
									)
									assert.ok(
										named.law === identifierOf(identity.patternLaw(domain.named)),
										`${owner}.${field}`
									)
								}
							}
						})
				)
			)
	)
})
