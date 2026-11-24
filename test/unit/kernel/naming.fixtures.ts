/** What the properties of naming.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	boolean,
	codePoint,
	element,
	type Gen,
	map,
	recursive,
	string,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import type { FieldDesc, SchemaDesc, SideDesc, StatementDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { ConstraintOwner } from "#compiler/ir/products.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnySchema,
	check,
	derived,
	key,
	on,
	relation,
	type Statement,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
import {
	alternativesBox,
	compositeAlternatives,
	type Family,
	queueFamily,
	spanCoverage,
	timekeepingFamily
} from "#test/support/laws/boxes.ts"
import { lawBox } from "#test/support/laws/generated.ts"
import { argumentsOf } from "#test/support/list.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import { rawContract } from "#test/unit/schema/support.ts"

/** Every statement of a schema description, at every level. */
export const levelStatements = (desc: SchemaDesc): ReadonlyArray<StatementDesc> => [
	...desc.statements,
	...(desc.bases[0] === undefined ? [] : levelStatements(desc.bases[0]))
]

type Alternatives = Extract<StatementDesc, { readonly kind: "alternatives" }>

/** The alternatives statements among a schema's statements. */
export const alternativesStatements = (
	statements: ReadonlyArray<StatementDesc>
): ReadonlyArray<Alternatives> =>
	Arr.flatMap(statements, (s) => (s.kind === "alternatives" ? [s] : []))

/**
 * The handles an expansion's selected parent side fixes its discriminator to: one by `eq`, several, an arm relation's,
 * by `in`.
 */
export const handlesOf = (side: SideDesc): Arr.NonEmptyReadonlyArray<string> => {
	const [predicate, ...more] = side.selection.conjuncts
	if (more.length === 0 && predicate?.kind === "in" && predicate.arg.kind === "field") {
		const handles = Arr.flatMap(predicate.values, (v) => (typeof v === "string" ? [v] : []))
		if (Arr.isReadonlyArrayNonEmpty(handles) && handles.length === predicate.values.length) {
			return handles
		}
	}
	if (
		more.length > 0 ||
		predicate?.kind !== "compare" ||
		predicate.op !== "eq" ||
		predicate.left.kind !== "field" ||
		predicate.right.kind !== "literal" ||
		typeof predicate.right.value !== "string"
	) {
		return assert.fail(`${side.relation}'s side selects no handle of its discriminator`)
	}
	return [predicate.right.value]
}

/**
 * The foreign keys from an alternatives arm into its parent, among the law model's natives: into the parent's key and
 * discriminator through the arm's constant law column where the arm relation is one handle's, or into its key alone.
 */
export const foreignKeysInto = (
	model: LawModel,
	arm: string,
	parent: string
): ReadonlyArray<{ readonly owner: ConstraintOwner; readonly ident: ConstraintName }> =>
	Arr.flatMap(model.natives, (n) =>
		n.namespace === "constraint" &&
		n.object.kind === "ForeignKey" &&
		n.object.relation.name === arm &&
		n.object.target.name === parent
			? [{ owner: { kind: "table", name: n.owner } as const, ident: identifierOf(n.named) }]
			: []
	)

/** Whether the rule judge holds `law` at COMMIT, a unit-local rule that installs nothing, whole or by its probes
 * (laws/model/plan.ts containmentDischarge), rather than its natives. */
export const judged = (model: LawModel, law: LawId): boolean =>
	Arr.some(model.rules, (r) => r.law.id === law)

/** The declared relation, field and field description of an installed table and column, as ownership registered them. */
export const declaredColumn = (
	owned: Owned,
	table: string,
	column: string
): Readonly<{ relation: string; field: string; desc: FieldDesc }> => {
	const [found] = Arr.flatMap(Rec.values(owned.relations), (owner) =>
		owner.kind === "relation" && identifierOf(owner.named) === table
			? Arr.flatMap(Rec.values(owner.fields), (field) =>
					field.column === column
						? [{ relation: owner.name, field: field.name, desc: field.desc }]
						: []
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

const leafGen: Gen<Shape> = map(boolean, (inSet): Shape => ({
	kind: "leaf",
	leaf: inSet ? "in" : "ne"
}))

/** Every shape of at most two levels of connectives over the leaves, each connective of one or two operands. */
export const shapeGen: Gen<Shape> = recursive(
	leafGen,
	(inner) =>
		(source): Shape => {
			const kind: Connective = source.draw(boolean) ? "or" : "and"
			return source.draw(boolean)
				? { kind, args: [source.draw(inner), source.draw(inner)] }
				: { kind, args: [source.draw(inner)] }
		},
	2
)

export type ShapeFeature = "and under or" | "singleton and"

/** The features of a shape, `underOr` whether its parent is a disjunction. */
export const shapeFeatures = (shape: Shape, underOr: boolean): ReadonlyArray<ShapeFeature> => {
	if (shape.kind === "leaf") {
		return []
	}
	const own: ReadonlyArray<ShapeFeature> = [
		...(shape.kind === "and" && underOr ? (["and under or"] as const) : []),
		...(shape.kind === "and" && shape.args.length === 1 ? (["singleton and"] as const) : [])
	]
	return [...own, ...Arr.flatMap(shape.args, (arg) => shapeFeatures(arg, shape.kind === "or"))]
}

export const Item = relation("Item", { id: pg.integer, t: str.regex("^[a-c]{0,3}$") }, ["id"])

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
export const checkOf = (shape: Shape): Statement => check("H", Item, (r) => predicateOf(shape, r))

/** A law family's whole parameter space, each schema declared under one name, by the position of its variant. */
interface Space {
	readonly label: string
	readonly variants: number
	readonly schemaAt: (variant: number) => AnySchema
}

const spaceOf = <P>(family: Family<P>): Space => ({
	label: family.label,
	variants: family.variants.length,
	schemaAt: (variant) =>
		family.schema(defined(family.variants[variant], `${family.label} ${variant}`))("Naming")
})

/** The law families (test/support/laws), whose boxes span keys over selected sides, checks, alternatives and spans. */
const spaces: Arr.NonEmptyReadonlyArray<Space> = [
	spaceOf(lawBox),
	spaceOf(alternativesBox),
	spaceOf(compositeAlternatives),
	spaceOf(spanCoverage),
	spaceOf(queueFamily),
	spaceOf(timekeepingFamily)
]

/**
 * The contracts a case declares beside: each under a drawn name, over bigint, its predicate one of two definitions, so
 * contracts of one definition share one domain.
 */
interface ContractSketch {
	readonly name: string
	readonly atLeastZero: boolean
}

/** A statement over a derived relation: a rule over a query, which its deferred constraint triggers hold. */
type RuleStatement = "check" | "key"

/**
 * A case: a schema of a law family's box by its picks, a relation of drawn contracts, or a rule over a derived relation,
 * read at its own level or at an empty level above it.
 */
interface NamingCase {
	readonly subject:
		| { readonly kind: "family"; readonly space: number; readonly variant: number }
		| { readonly kind: "contracts"; readonly contracts: Arr.NonEmptyReadonlyArray<ContractSketch> }
		| { readonly kind: "rule"; readonly statement: RuleStatement }
	readonly extended: boolean
}

const contractNameGen: Gen<string> = map(
	string(codePoint(0x61, 0x63), { min: 0, max: 2 }),
	(rest) => `C${rest}`
)

export const namingCaseGen: Gen<NamingCase> = (source) => ({
	subject: source.draw(
		weighted<NamingCase["subject"]>([
			[3, (s) => ({ kind: "family", space: s.draw(pickGen), variant: s.draw(pickGen) })],
			[
				1,
				(s) => ({
					kind: "contracts",
					contracts: nonEmpty(
						Arr.map(s.draw(uniqueKeys(contractNameGen, { min: 1, max: 3 })), (name) => ({
							name,
							atLeastZero: s.draw(boolean)
						})),
						"the contracts"
					)
				})
			],
			[1, (s) => ({ kind: "rule", statement: s.draw(element(["check", "key"] as const)) })]
		])
	),
	extended: source.draw(boolean)
})

/** A contract predicate VALUE >= 0 or VALUE <= 100, as Logic's comparisons record them. */
const boundOf = (atLeastZero: boolean): OpenExpr => ({
	kind: "compare",
	op: atLeastZero ? "ge" : "le",
	left: { kind: "value" },
	right: { kind: "literal", value: atLeastZero ? 0n : 100n }
})

/** The schema of a family's box at a variant, both by their picks. */
const familySchema = (spacePick: number, variantPick: number): AnySchema => {
	const space = pickFrom(spaces, spacePick)
	return space.schemaAt(pickIndex(variantPick, space.variants))
}

/** A stored relation, and the level that holds it alone. */
const Reading = relation("Reading", { id: pg.integer, n: pg.integer }, ["id"])
const RuleBase = schema("Rules", [Reading], [])

/** Every Reading, as a derived relation of the level above: a statement over it is a rule over a query. */
const Kept = derived(
	"Kept",
	query(RuleBase).rule((r) => {
		const { id, n } = v(Reading, "reading")
		return r.match(Reading, { id, n }).find({ id, n })
	})
)

/** The level above Rules that derives Kept and states one rule over it, a check or a key. */
const ruleSchema = (statement: RuleStatement): AnySchema =>
	schema.extend(
		[RuleBase],
		"RulesTop",
		[Kept],
		[
			statement === "check"
				? check("Nonzero", Kept, (x) => x.not(x.eq(x.n, 0)))
				: key(on(Kept, "n"))
		]
	)

/**
 * The schema a case reads: the family's schema, the contracts', or the rule's level, and its subject, it or an empty
 * level over it.
 */
export const subjectOf = (
	c: NamingCase
): { readonly base: AnySchema; readonly subject: AnySchema } => {
	const sub = c.subject
	const base =
		sub.kind === "family"
			? familySchema(sub.space, sub.variant)
			: sub.kind === "rule"
				? ruleSchema(sub.statement)
				: schema(
						"Contracts",
						[
							relation(
								"Line",
								{
									id: pg.integer,
									...Rec.fromEntries(
										Arr.map(
											sub.contracts,
											(k, i) =>
												[`f${i}`, rawContract(k.name, pg.bigint, boundOf(k.atLeastZero))] as const
										)
									)
								},
								["id"]
							)
						],
						[]
					)
	return { base, subject: c.extended ? schema.extend([base], "Above", [], []) : base }
}

/**
 * A hashed name as the naming door's rule spells it, restated: `__`, the stem, `_` and the first fifty bits of the
 * SHA-256 of the identity's canonical encoding as ten characters of lowercase RFC 4648 base32.
 */
export const hashedName = (stem: string, canonical: string): string => {
	const bits = BigInt(`0x${Str.slice(0, 13)(sha256Hex(wellFormed(canonical)))}`) >> 2n
	const alphabet = Str.split("abcdefghijklmnopqrstuvwxyz234567", "")
	const digest = Arr.join(
		Arr.map(Arr.reverse(indices(10)), (i) =>
			Arr.getUnsafe(alphabet, Number((bits >> BigInt(5 * i)) & 31n))
		),
		""
	)
	return `__${stem}_${digest}`
}

/** The bytes of a text in UTF-8. */
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length

export type NamingFeature =
	| CrossCheck
	| "a key statement"
	| "a readable row check"
	| "a hashed law column"
	| "an empty level above"
	| "a rule's trigger"
