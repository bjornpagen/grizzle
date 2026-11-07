import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	boolean,
	codePoint,
	type Gen,
	map,
	recursive,
	string,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { conversionOf, identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import type { SchemaDesc, SideDesc, StatementDesc } from "#compiler/ir/desc.ts"
import { expandAlternatives } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { type ConstraintOwner, constraintLaw } from "#compiler/ir/products.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { pg } from "#compiler/public/fields.ts"
import { type AnySchema, check, relation, type Statement, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import {
	constraintOwner,
	installationNamesOf,
	installationOf,
	lawIdOf,
	lawNamesOf
} from "#test/support/kernel/naming.ts"
import {
	alternativesBox,
	compositeAlternatives,
	type Family,
	queueFamily,
	spanCoverage,
	timekeepingFamily
} from "#test/support/laws/boxes.ts"
import { lawBox } from "#test/support/laws/generated.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import { rawContract } from "#test/unit/schema/support.ts"

/**
 * Production names from src: the test kit's naming (test/support/kernel/naming.ts) agrees with src's own records, and
 * every name the law model mints keeps the naming door's rule (core/identity.ts).
 *
 * - Each case draws a schema of a law family's box (test/support/laws: keys over whole and selected sides, checks,
 *   containments, alternatives over single and composite keys, span coverage, a work queue, timekeeping), or a relation
 *   of drawn contracts under drawn names over two definitions, read at its own level or at an empty level above it. Every named native's constraint reports a law of the theory, among the
 *   constraints of its kind the kit names for that law; every key statement's law, as the kit names it, is reported by
 *   a constraint of the model; every alternatives expansion's arms and reverses are its tagged and native foreign keys;
 *   every checked contract's and text domain's CHECK reports its law. Every native's name is readable exactly where its
 *   identity is a declared row check's, then the check's name's conversion, and otherwise hashed, `__<stem>_<digest>`
 *   with the digest the naming door's rule restated over the identity's canonical encoding; each fits an identifier,
 *   and no two natives of one namespace share a name.
 * - A row check's law is named by its statement rebuilt in its written operand order, which ownership reorders, over
 *   every predicate of at most two levels of connectives over two leaves.
 */
/** Every statement of a schema description, at every level. */
const levelStatements = (desc: SchemaDesc): ReadonlyArray<StatementDesc> => [
	...desc.statements,
	...(desc.extends === undefined ? [] : levelStatements(desc.extends))
]

type Alternatives = Extract<StatementDesc, { readonly kind: "alternatives" }>

/** The alternatives statements among a schema's statements. */
const alternativesStatements = (
	statements: ReadonlyArray<StatementDesc>
): ReadonlyArray<Alternatives> =>
	Arr.flatMap(statements, (s) => (s.kind === "alternatives" ? [s] : []))

/**
 * The handles an expansion's selected parent side fixes its discriminator to: one by `eq`, several, an arm relation's,
 * by `in`.
 */
const handlesOf = (side: SideDesc): Arr.NonEmptyReadonlyArray<string> => {
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
const foreignKeysInto = (
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

/** The declared relation and field of an installed table and column, as ownership registered them. */
const declaredColumn = (owned: Owned, table: string, column: string): readonly [string, string] => {
	const [found] = Arr.flatMap(Rec.values(owned.relations), (owner) =>
		owner.kind === "relation" && identifierOf(owner.named) === table
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

const leafGen: Gen<Shape> = map(boolean, (inSet): Shape => ({
	kind: "leaf",
	leaf: inSet ? "in" : "ne"
}))

/** Every shape of at most two levels of connectives over the leaves, each connective of one or two operands. */
const shapeGen: Gen<Shape> = recursive(
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

/**
 * A case: a schema of a law family's box by its picks, or a relation of drawn contracts, read at its own level or at an
 * empty level above it.
 */
interface NamingCase {
	readonly subject:
		| { readonly kind: "family"; readonly space: number; readonly variant: number }
		| { readonly kind: "contracts"; readonly contracts: Arr.NonEmptyReadonlyArray<ContractSketch> }
	readonly extended: boolean
}

const contractNameGen: Gen<string> = map(
	string(codePoint(0x61, 0x63), { min: 0, max: 2 }),
	(rest) => `C${rest}`
)

const namingCaseGen: Gen<NamingCase> = (source) => ({
	subject: source.draw(
		weighted<NamingCase["subject"]>([
			[3, (s) => ({ kind: "family", space: s.draw(pickGen), variant: s.draw(pickGen) })],
			[
				1,
				(s) => ({
					kind: "contracts",
					contracts: nonEmpty(
						Arr.map(
							s.draw(uniqueArray(contractNameGen, (n) => n, { min: 1, max: 3 }, 20)),
							(name) => ({ name, atLeastZero: s.draw(boolean) })
						),
						"the contracts"
					)
				})
			]
		])
	),
	extended: source.draw(boolean)
})

/** A contract predicate VALUE >= 0 or VALUE <= 100, as Compute's comparisons record them. */
const boundOf = (atLeastZero: boolean): OpenExpr => ({
	kind: "compare",
	op: atLeastZero ? "ge" : "le",
	left: { kind: "value" },
	right: { kind: "literal", value: atLeastZero ? 0n : 100n, type: undefined }
})

/** The schema of a family's box at a variant, both by their picks. */
const familySchema = (spacePick: number, variantPick: number): AnySchema => {
	const space = pickFrom(spaces, spacePick)
	return space.schemaAt(pickIndex(variantPick, space.variants))
}

/** The schema a case reads: the family's schema, or the contracts', and its subject, it or an empty level over it. */
const subjectOf = (c: NamingCase): { readonly base: AnySchema; readonly subject: AnySchema } => {
	const sub = c.subject
	const base =
		sub.kind === "family"
			? familySchema(sub.space, sub.variant)
			: schema(
					"Contracts",
					{
						Line: relation(
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
					},
					[]
				)
	return { base, subject: c.extended ? schema.extend(base, {}, []) : base }
}

/**
 * A hashed name as the naming door's rule spells it, restated: `__`, the stem, `_` and the first fifty bits of the
 * SHA-256 of the identity's canonical encoding as ten characters of lowercase RFC 4648 base32.
 */
const hashedName = (stem: string, canonical: string): string => {
	const bits = BigInt(`0x${Str.slice(0, 13)(sha256Hex(canonical))}`) >> 2n
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
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

type NamingFeature =
	| CrossCheck
	| "a key statement"
	| "a readable row check"
	| "a hashed law column"
	| "an empty level above"

describe("production names from src", () => {
	it.effect(
		"agree with src's records at every named native, key, alternatives expansion, checked contract and text domain, each named by the door's rule",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/kernel/naming",
						draw: drawn(namingCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "src's law model and installation records, and the naming door's rule restated: readable a row check's conversion, hashed __stem_digest of its identity"
						},
						coverage: required<NamingFeature>(
							[
								"named native",
								"alternatives expansion",
								"checked contract",
								"text domain",
								"a key statement",
								"a readable row check",
								"a hashed law column",
								"an empty level above"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const { base, subject } = subjectOf(c)
							if (c.extended) {
								k.note("an empty level above")
							}
							const L = lawNamesOf(subject)
							const N = installationNamesOf(installationOf(subject, { kind: "declared" }))
							const theory = new Set<LawId>(Arr.map(L.model.theory.laws, (l) => l.id))
							const named: Array<readonly [string, string]> = []
							for (const native of L.model.natives) {
								if (native.namespace !== "constraint" && native.namespace !== "column") {
									continue
								}
								const id = native.named
								named.push([`${native.namespace} ${native.owner}`, identifierOf(id)])
								assert.ok(bytesOf(identifierOf(id)) <= 63, `${identifierOf(id)} fits an identifier`)
								if (id.kind === "check") {
									k.note("a readable row check")
									assert.equal(id.form, "readable")
									const declared = id.parts[1]
									assert.ok(
										typeof declared === "string",
										"a row check's identity holds its declared name"
									)
									assert.equal<string>(identifierOf(id), conversionOf(declared))
								} else {
									if (id.kind === "lawColumn") {
										k.note("a hashed law column")
									}
									assert.equal(id.form, "hashed", `${id.display} is hashed`)
									assert.equal<string>(identifierOf(id), hashedName(id.stem, id.canonical))
								}
								if (native.namespace !== "constraint") {
									continue
								}
								k.note("named native")
								const owner: ConstraintOwner = { kind: "table", name: native.owner }
								const ident = identifierOf(native.named)
								const law = L.lawOfConstraint(owner, ident)
								assert.ok(theory.has(law), `${ident} reports ${law}, which is no law of the theory`)
								assert.ok(
									L.constraintsOf(law, native.object.kind).includes(ident),
									`${ident} is among the ${native.object.kind} constraints reporting ${law}`
								)
							}
							assert.equal(
								new Set(Arr.map(named, ([space, ident]) => `${space} ${ident}`)).size,
								named.length,
								"no two natives of one namespace share a name"
							)
							for (const statement of Arr.filter(base.statements, (s) => s.kind === "key")) {
								k.note("a key statement")
								const law = lawIdOf(subject, statement)
								const reporting = Arr.filter(
									L.model.constraints,
									(entry) =>
										constraintLaw(L.model.constraintToLaw, constraintOwner(entry), entry.name) ===
										law
								)
								assert.ok(reporting.length > 0, `a constraint reports the key's law ${law}`)
							}
							for (const statement of alternativesStatements(levelStatements(L.model.owned.desc))) {
								k.note("alternatives expansion")
								const laws = L.alternativesOfDesc([statement])
								const expansion = expandAlternatives(statement)
								const all = [...new Set(Rec.values(laws.arms)), ...Rec.values(laws.reverse)]
								assert.equal(new Set(all).size, all.length, "arm and reverse laws are distinct")
								for (const forward of Arr.filter(
									expansion,
									(s) => s.right.selection.conjuncts.length > 0
								)) {
									const parent = forward.right.relation
									const fks = foreignKeysInto(L.model, forward.left.relation, parent)
									for (const handle of handlesOf(forward.right)) {
										assert.ok(
											Arr.some(
												fks,
												(fk) => L.lawOfConstraint(fk.owner, fk.ident) === laws.arms[handle]
											),
											`${handle}'s arm is contained in its parents through a foreign key into them`
										)
									}
								}
								for (const reverse of Arr.filter(
									expansion,
									(s) => s.left.selection.conjuncts.length > 0
								)) {
									const handle = Arr.headNonEmpty(handlesOf(reverse.left))
									const law = defined(laws.reverse[handle], `${handle}'s reverse law`)
									assert.ok(theory.has(law), `${handle}'s reverse is a law of the theory`)
									assert.equal(
										L.lawOfConstraint(
											{ kind: "table", name: N.tableIdent({ name: reverse.left.relation }) },
											L.constraintOf(law, "ForeignKey")
										),
										law,
										`${handle}'s reverse is its own native foreign key`
									)
								}
							}
							for (const contractName of Rec.keys(N.model.owned.contracts)) {
								const contract = N.contract(contractName)
								if (contract.kind === "brand") {
									continue
								}
								k.note("checked contract")
								const [first] = Arr.sort(
									Arr.filter(Rec.keys(N.model.owned.contracts), (other) => {
										const o = N.contract(other)
										return o.kind !== "brand" && o.domain === contract.domain
									}),
									Order.String
								)
								assert.equal(
									N.lawOfConstraint({ kind: "domain", name: contract.domain }, contract.constraint),
									N.contract(defined(first, `${contractName}'s domain`)).law,
									contractName
								)
							}
							for (const domain of N.installation.textDomains) {
								for (const use of domain.uses) {
									k.note("text domain")
									const [owner, field] = declaredColumn(N.model.owned, use.table, use.column)
									const textNames = N.textDomain({ name: owner }, field)
									assert.equal(textNames.domain, domain.name, `${owner}.${field}`)
									const law = N.patternLaw({ name: owner }, field)
									/** The law src's installation records for the column under the domain's CHECK. */
									const recorded = Arr.flatMap(N.installation.constraintLaws, (c) =>
										c.kind === "domainConstraint" &&
										c.owner === textNames.domain &&
										c.name === textNames.constraint
											? Arr.filter(c.uses, (u) => u.table === use.table && u.column === use.column)
											: []
									)
									assert.deepEqual(
										Arr.map(recorded, (u) => u.law.law),
										[law],
										`${owner}.${field}'s column states its own pattern law under its domain's CHECK`
									)
									const described = N.described(law)
									assert.ok(
										described.kind === "pattern" &&
											described.relation === owner &&
											described.field === field,
										`${owner}.${field}'s law names its relation and field`
									)
								}
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
						generator: shapeGen,
						literal: Formatter.format,
						limit: 422,
						box: "every predicate over the two leaves of at most two levels of connectives, each of one or two operands",
						oracle: {
							kind: "specification",
							name: "the one law of the schema's one row check"
						},
						coverage: requiredInSpace<ShapeFeature>(["and under or", "singleton and"]),
						caseHang
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
})
