import { catchRefusal } from "#compiler/core/canonical.ts"
import { exactParts, infinityParts, nanParts } from "#compiler/core/decimal.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type * as Result from "#compiler/core/result.ts"
import type { TheoryRelation } from "#compiler/ir/law.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import {
	type InstallContribution,
	type InstallExtension,
	noContribution
} from "#compiler/physical/install/extension.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { bareNumericDigits } from "#compiler/scalar/values/identity.ts"
import type { Expr, TableConstraint } from "#compiler/sql/ast.ts"
import { binary, call, eq, lit, or, tableCol, types } from "#compiler/sql/build.ts"

type StoredRelation = Extract<TheoryRelation, { readonly kind: "relation" }>

/** One bare numeric column's bound CHECK: its relation and field, its identity and the constraint its table carries. */
interface NumericBound {
	readonly relation: StoredRelation
	readonly field: string
	readonly named: Identity<"numericBound">
	readonly constraint: TableConstraint & { readonly kind: "check"; readonly name: ConstraintName }
}

/** Whether a column stores a bare numeric, a contract over one included: numeric with no precision and scale. */
const isBareNumeric = (t: ScalarType): boolean => {
	const base = baseOf(t)
	return base.carrier === "numeric" && base.typmod === undefined
}

/** 10^1000: the least magnitude with more than 1,000 integer digits. */
const pastBound = lit.decimal(exactParts(10n ** BigInt(bareNumericDigits), 0), types.numeric)

/** `abs(c) < 10^1000 OR c = 'NaN' OR abs(c) = 'Infinity'`: at most 1,000 integer digits, or NaN, or an infinity. */
const boundPredicate = (column: string): Expr => {
	const c = tableCol(column)
	return or([
		binary("<", call("abs", [c]), pastBound),
		eq(c, lit.decimal(nanParts, types.numeric)),
		eq(call("abs", [c]), lit.decimal(infinityParts, types.numeric))
	])
}

/** Every stored relation's bare numeric columns' bound CHECKs, in relation then field order. */
const numericBounds = (b: InstallBuilder): ReadonlyArray<NumericBound> =>
	Object.values(b.model.theory.relations)
		.flatMap((r) => (r.kind === "relation" ? [r] : []))
		.toSorted((x, y) => compareStrings(x.name, y.name))
		.flatMap((r) =>
			r.fields
				.filter((f) => isBareNumeric(f.type))
				.map((f): NumericBound => {
					const named = identity.numericBound(r.name, f.name)
					return {
						relation: r,
						field: f.name,
						named,
						constraint: {
							kind: "check",
							name: b.name(named),
							predicate: boundPredicate(b.names.column(r.name, f.name))
						}
					}
				})
		)

/** Each bound CHECK as a physical object: an `ALTER TABLE ... ADD CONSTRAINT ... CHECK` in Structure after its table. */
const addBounds = (b: InstallBuilder, bounds: ReadonlyArray<NumericBound>): void => {
	for (const n of bounds) {
		b.add(
			{
				kind: "check",
				ident: {
					kind: "constraint",
					schema: b.settings.installation,
					relation: b.names.relationNamed(n.relation.name),
					name: n.named
				},
				ddl: [
					{
						kind: "alterTable",
						table: b.names.relation(n.relation.name),
						actions: [{ kind: "addConstraint", constraint: n.constraint, notValid: false }]
					}
				],
				reasons: [
					enforcement(
						`the numeric bound of ${n.relation.name}.${n.field}: at most ${bareNumericDigits} integer digits`
					)
				],
				phase: "structure"
			},
			[b.table(n.relation.name)]
		)
	}
}

/**
 * Each bound CHECK with the law a violation reports (identity.boundLaw), described as the field's bound: a write of a
 * value past it, a computed value grizzle writes or a direct SQL writer's, is refused by that law.
 */
const boundLaws = (bounds: ReadonlyArray<NumericBound>): ReadonlyArray<ConstraintLaw> =>
	bounds.map((n): ConstraintLaw => ({
		kind: "constraint",
		name: n.constraint.name,
		owner: n.relation.ident,
		law: identifierOf(identity.boundLaw(n.named)),
		described: Object.freeze({ kind: "numericBound", relation: n.relation.name, field: n.field })
	}))

/**
 * Numeric bounds: the CHECK every bare numeric column carries, as the installer's built-in contribution (T4).
 *
 * A bare `pg.numeric` field, a contract over one included, stores at most 1,000 integer digits, NaN or an infinity:
 * `__<table>_bound_<column>_<digest>`, `abs(c) < 10^1000 OR c = 'NaN' OR abs(c) = 'Infinity'`, wrapped in IS TRUE by the
 * printer, on every write, grizzle's or a direct SQL writer's. The encoder refuses such a value before any SQL (values/identity.ts
 * bareNumericDigits), so the CHECK refuses a computed value grizzle writes and a direct writer's, each by the bound's
 * law. Every numeric value a read meets then has a known digit bound, and no numeric arithmetic overflows
 * (scalar/compute/bounds.ts).
 *
 * Every name is minted at the naming door from the CHECK's identity (identity.numericBound). `compileInstallation` runs
 * this extension before any caller extension, so no installation path leaves the bounds out.
 */
export const numericBoundStorage: InstallExtension = {
	contribute: (b): Result.Result<InstallContribution, CompileError> =>
		catchRefusal(() => {
			const bounds = numericBounds(b)
			addBounds(b, bounds)
			return { ...noContribution, constraintLaws: boundLaws(bounds) }
		}),
	textDomainUses: noTextDomainUses
}
