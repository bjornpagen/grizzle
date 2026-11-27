/**
 * Each variant's objects (ir/scalar.ts VariantType): its composite, `CREATE TYPE … AS (tag smallint, <each arm's fields,
 * each at its base type>)`, and its domain over the composite, whose one CHECK holds the arm its tag's code names whole,
 * each of its fields judged by its own type, and every other arm's attributes absent:
 *
 *   CHECK (VALUE IS NULL OR (CASE (VALUE)."tag" WHEN <code> THEN num_nulls(<the arm's attributes, each cast to its
 *     field's type>) = 0 AND num_nonnulls(<every other arm's attributes>) = 0 WHEN … ELSE false END) IS TRUE)
 *
 * Every column, cast and parameter of the variant is typed by the domain, so a value of it is a sum value wherever it
 * stands, whoever writes it: its tag is the code of a handle one of its arms names, of the subset of its roster the
 * variant holds, since the CHECK names each and refuses any other, a live handle of no arm among them, and each present
 * field is cast to its own type (ir/physical.ts fieldColumnType), its contract's, its pattern's, its roster's or the
 * digest's domain, which judges it there, raising its own refusal, a closed id of a subset held to its subset's codes
 * beside its roster's domain and an exact value to its scale beside plain numeric, as a stored column of it is by its
 * CHECK.
 *
 * The composite holds bases alone (ir/physical.ts variantAttributeType): PostgreSQL refuses to add or validate a
 * constraint of a domain that an attribute of a composite some column holds is typed by ("cannot alter type … because
 * column … uses it"), as a roster's domain is whenever its roster changes, and a session's carrier holds the composite.
 * A domain the CHECK casts to that takes another constraint judges the stored values again through the variant's domain,
 * whose CHECK the migration replaces and validates (deploy/diff/diff.ts domainObject).
 *
 * PostgreSQL 19.0's record equality, hash and B-tree order over the composite hold two absent attributes equal, so a key,
 * a reference, DISTINCT, UNION, GROUP BY and ORDER BY read the column as the sum it is, its order the tag's code and
 * then the arm's fields in declared order. ALTER TYPE … ADD ATTRIBUTE leaves every stored value as it is, each reading
 * the new attribute NULL, so an arm appended to the roster, which takes the next code and so comes last in the layout
 * (ir/codes.ts variantLayout), or an arm of a handle of the roster past every arm's code, adds its attributes in place
 * (deploy/diff/diff.ts rowTypeGrown), and the domain's CHECK replaced and validated admits its code (verified on 19.0,
 * 2026-11-24). An arm of no field added or removed changes the CHECK alone, whose validation refuses a stored value of
 * a removed arm (23514).
 *
 * Both are named by the variant's declared name (core/identity.ts identity.variantRow, identity.variantDomain), in the
 * installation's types schema, as a contract's domain is. PUBLIC holds nothing on the composite and no role is granted
 * USAGE on it: PostgreSQL checks USAGE on a type only where a statement creates an object of it, a table or a function,
 * which no role's statement does. A carrier holding a variant holds it at its composite (ir/physical.ts
 * sessionTypeRef), the text of an array of it in a transaction's setting (write/carriers), which filling, casting and
 * reading need no USAGE for (PostgreSQL 19.0, 2026-11-26: a role holding none filled such a carrier and read its rows,
 * and was refused only a temporary table of the type, 42501).
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { canonicalEquals, unwrap } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { predicateTree } from "#compiler/ir/expr.ts"
import {
	fieldColumnType,
	type PhysicalNames,
	qualifiedType,
	variantAttributes,
	variantAttributeType,
	variantTagAttribute
} from "#compiler/ir/physical.ts"
import { type ArmField, onlyOf, type VariantInfo } from "#compiler/ir/scalar.ts"
import { isNegativeZero } from "#compiler/lower/conservative/expr/variant.ts"
import { subsetPredicate } from "#compiler/physical/closed/storage.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { lowerPersistent } from "#compiler/physical/ddl/expr.ts"
import { exactNumeric, exactPredicate } from "#compiler/physical/numeric/storage.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import type { ColumnDefinition, Expr, ObjectName } from "#compiler/sql/ast.ts"
import { and, call, cast, eq, lit, types } from "#compiler/sql/build.ts"

/** A variant's objects: its composite's and its domain's names. */
export interface VariantObjects {
	readonly row: ObjectName
	readonly domain: ObjectName
}

/** `(VALUE).attribute`: an attribute of the value a domain's CHECK judges. */
const valueAttribute = (attribute: string): Expr => ({
	kind: "attribute",
	record: { kind: "domainValue" },
	attribute
})

/** A present field's attribute as the CHECK reads it: cast to the field's own type where that is a domain, which judges
 * it, raising its own refusal; the attribute itself where the field's type is its base. */
const judged = (names: PhysicalNames, field: ArmField, attribute: string): Expr => {
	const own = fieldColumnType(names, field.type)
	return canonicalEquals(own, variantAttributeType(names, field.type))
		? valueAttribute(attribute)
		: cast(valueAttribute(attribute), own.type)
}

/** `fn(…) = 0` over `args`, true of none. */
const noneBy = (fn: "num_nulls" | "num_nonnulls", args: ReadonlyArray<Expr>): ReadonlyArray<Expr> =>
	args.length === 0 ? [] : [eq(call(fn, args), lit.int(0, types.integer))]

/**
 * The domain's CHECK over its value: the arm its tag's code names whole, each of its fields present and judged by its
 * own type, each float's zero sign its value's (isNegativeZero), each closed id of a subset among its codes
 * (physical/closed/storage.ts subsetPredicate), which no roster's domain the field is cast to holds, each exact value at
 * its type's scale, never NaN or an infinity (physical/numeric/storage.ts exactPredicate), which the plain numeric the
 * field is cast to does not hold, and every other arm's attributes absent; false at any other code, and at a NULL tag.
 * So a direct writer's value, or a declared function's the call casts to the domain, of an exact integer arm holding
 * 2.5 is refused (23514), as a stored exact column refuses it, where the host could not decode it.
 */
const armCheck = (names: PhysicalNames, variant: VariantInfo): Expr => {
	const layout = variantAttributes(variant, names.codes)
	const attributesOf = (f: (typeof layout)[number]["fields"][number]): ReadonlyArray<string> =>
		f.zero === undefined ? [f.attribute] : [f.attribute, f.zero]
	const all = layout.flatMap((arm) => arm.fields.flatMap(attributesOf))
	const whens = mapNonEmpty(
		nonEmptyArms(layout),
		(arm): { readonly when: Expr; readonly result: Expr } => {
			const own = new Set(arm.fields.flatMap(attributesOf))
			const conditions = [
				...noneBy(
					"num_nulls",
					arm.fields.flatMap((f) => [
						judged(names, f.field, f.attribute),
						...(f.zero === undefined ? [] : [valueAttribute(f.zero)])
					])
				),
				...arm.fields.flatMap((f) =>
					f.zero === undefined
						? []
						: [
								eq(
									valueAttribute(f.zero),
									isNegativeZero(valueAttribute(f.attribute), f.field.type)
								)
							]
				),
				...arm.fields.flatMap((f) =>
					onlyOf(f.field.type) === undefined
						? []
						: [subsetPredicate(names.codes, valueAttribute(f.attribute), f.field.type)]
				),
				...arm.fields.flatMap((f) =>
					exactNumeric.holds(f.field.type)
						? [exactPredicate(valueAttribute(f.attribute), f.field.type)]
						: []
				),
				...noneBy(
					"num_nonnulls",
					all.filter((attribute) => !own.has(attribute)).map(valueAttribute)
				),
				...armCheckOf(names, variant, arm.handle)
			]
			const [first, ...rest] = conditions
			return {
				when: lit.int(arm.code, types.smallint),
				result: first === undefined ? lit.bool(true) : and([first, ...rest])
			}
		}
	)
	return {
		kind: "case",
		operand: valueAttribute(variantTagAttribute),
		whens,
		else: lit.bool(false)
	}
}

/**
 * The check the variant states of its arm `handle` (ir/scalar.ts VariantArm `check`), lowered over the domain's VALUE
 * as a contract's predicate is: its reads of the arm's fields are the composite's attributes, which the conjunction
 * before it holds present; none for an arm of no check.
 */
const armCheckOf = (
	names: PhysicalNames,
	variant: VariantInfo,
	handle: string
): ReadonlyArray<Expr> => {
	const check = variant.arms.find((a) => a.handle === handle)?.check
	return check === undefined
		? []
		: [
				lowerPersistent(names, unwrap(predicateTree(check)), {
					reads: { kind: "domain" },
					loc: SourceLoc(`the check of arm ${handle} of variant ${variant.name}`, [])
				})
			]
}

/** A variant's layout, never empty: a variant holds at least one arm (scalar/registry.ts variantAt). */
const nonEmptyArms = <A>(arms: ReadonlyArray<A>): NonEmptyReadonlyArray<A> => {
	const [first, ...rest] = arms
	if (first === undefined) {
		defect("a variant holds at least one arm")
	}
	return [first, ...rest]
}

/**
 * Adds each variant the owned schema holds (schema/own.ts OwnedVariant), in name order: its composite, then its domain
 * over it. Each is created after every object its statements name (physical/obligations/graph.ts namedEdges): the
 * domain after each domain its CHECK casts to.
 */
export const addVariants = (b: InstallBuilder): ReadonlyArray<VariantObjects> =>
	Object.values(b.owned.variants)
		.toSorted((x, y) => compareStrings(x.name, y.name))
		.map((v): VariantObjects => {
			const type = b.checked.fieldType(v.desc, v.loc)
			if (type.carrier !== "variant") {
				defect(`variant ${v.name}'s descriptor is a variant's`)
			}
			const { variant } = type
			const why = [enforcement(`the arms of variant ${v.name}`)]
			const rowNamed = identity.variantRow(v.name)
			const row: ObjectName = { schema: b.names.variantRow(v.name).schema, name: b.name(rowNamed) }
			const attributes: NonEmptyReadonlyArray<ColumnDefinition> = [
				{ name: variantTagAttribute, type: types.smallint, collation: undefined },
				...variantAttributes(variant, b.names.codes).flatMap((arm) =>
					arm.fields.flatMap((f): ReadonlyArray<ColumnDefinition> => {
						const held = variantAttributeType(b.names, f.field.type)
						const value = { name: f.attribute, type: held.type, collation: held.collation }
						return f.zero === undefined
							? [value]
							: [value, { name: f.zero, type: types.boolean, collation: undefined }]
					})
				)
			]
			const rowNode = b.add(
				{
					kind: "rowType",
					ident: { kind: "type", schema: b.names.installation, name: rowNamed },
					ddl: [
						{ kind: "createRowType", name: row, attributes },
						{
							kind: "revoke",
							privileges: ["ALL"],
							on: { kind: "TYPE", names: [row] },
							from: [{ kind: "PUBLIC" }]
						}
					],
					reasons: why,
					phase: "setup"
				},
				[b.schemaNode]
			)
			const domainNamed = identity.variantDomain(v.name)
			const domain: ObjectName = {
				schema: b.names.variantDomain(v.name).schema,
				name: b.name(domainNamed)
			}
			b.addType(
				"domain",
				b.names.installation,
				domainNamed,
				{
					ddl: [
						{
							kind: "createDomain",
							name: domain,
							base: qualifiedType(b.names.variantRow(v.name)),
							collation: undefined,
							constraints: [
								{
									name: b.name(identity.domainCheck(domainNamed)),
									predicate: armCheck(b.names, variant)
								}
							]
						}
					],
					reasons: why
				},
				[rowNode]
			)
			return { row, domain }
		})
