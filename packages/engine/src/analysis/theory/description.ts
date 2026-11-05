import type { LawIdentity, ResolvedSide } from "#compiler/analysis/theory/laws.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { fieldNames } from "#compiler/ir/law.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import type { Law, LawSide, LawValue } from "#compiler/types/changeset/changeset.ts"

/**
 * The public description of a law (types/changeset Law): what an `invariant-rejected` outcome names, built from the
 * law's identity, so two laws of one schema have the same description exactly when they are one law (theory.ts
 * lawStatement states the same parts as the naming door's identity). It is frozen, shared by every outcome that names
 * the law.
 *
 * A selection's literal is given as the host holds a fact's field: a smallint's or an integer's as a number, a bigint's
 * as a bigint, a span's endpoints by its carrier, a handle as its string, the exact carriers as their values.
 */
export const lawDescription = (law: LawIdentity): Law => {
	const side = sideOf
	const d = law.detail
	switch (d.kind) {
		case "key":
			return Object.freeze({
				kind: d.key.primary ? "primaryKey" : "key",
				relation: d.relation,
				fields: Object.freeze(fieldNames(d.key.fields))
			})
		case "check":
			return Object.freeze({ kind: "check", relation: d.relation, name: d.name })
		case "contract":
			return contractLaw(d.contract)
		case "containment":
			return d.pairing.kind === "span"
				? Object.freeze({
						kind: "coverage",
						statement: d.stated.kind,
						from: side(d.from),
						to: side(d.to)
					})
				: Object.freeze({ kind: d.stated.kind, from: side(d.from), to: side(d.to) })
		case "alternatives":
			return Object.freeze({ kind: "alternatives", relation: d.parent, field: d.discriminator })
		case "alternativesArm":
			return Object.freeze({
				kind: "alternativesArm",
				relation: d.parent,
				field: d.discriminator,
				arm: d.arm,
				handles: Object.freeze(mapNonEmpty(d.handles, (h) => h))
			})
		case "capacity":
			return Object.freeze({
				kind: "capacity",
				target: side(d.target),
				from: side(d.from),
				weight: Object.freeze(
					d.weight.kind === "count"
						? { kind: "count" }
						: { kind: d.weight.kind, field: d.weight.field }
				),
				within: Object.freeze({
					low:
						typeof d.within.low === "bigint"
							? d.within.low
							: Object.freeze({ ref: d.within.low.ref }),
					high:
						typeof d.within.high === "bigint" || d.within.high === "*"
							? d.within.high
							: Object.freeze({ ref: d.within.high.ref })
				})
			})
	}
}

/** A contract's law, wherever its domain is installed (theory.ts contractLawIdentity): its name. */
export const contractLaw = (contract: string): Law => Object.freeze({ kind: "contract", contract })

/** A side of a law, its selection's literals as the host holds the selected fields. */
const sideOf = (side: ResolvedSide): LawSide =>
	Object.freeze({
		relation: side.relation,
		fields: Object.freeze(mapNonEmpty(side.fields, (f) => f)),
		selection: Object.freeze(
			side.selection.map((s) =>
				Object.freeze({ field: s.column, value: lawValue(s.value, s.col.type) })
			)
		)
	})

/** A selection's typed literal as the host holds a value of its field's type. */
const lawValue = (literal: TypedLiteral, type: ScalarType): LawValue => {
	switch (literal.kind) {
		case "int":
			return baseOf(type).carrier === "int8" ? literal.value : Number(literal.value)
		case "numeric":
			return Decimal.fromValue(literal.value)
		case "money":
			return Money.fromValue(literal.value)
		case "vector":
			return Vector.fromValue(literal.value)
		case "float":
		case "bool":
		case "text":
		case "uuid":
			return literal.value
		case "floatSpecial":
			return literal.value === "NaN"
				? Number.NaN
				: literal.value === "Infinity"
					? Number.POSITIVE_INFINITY
					: Number.NEGATIVE_INFINITY
		case "enum":
			return literal.handle
		case "span":
			return baseOf(type).carrier === "range8"
				? Object.freeze({ start: literal.start, end: literal.end })
				: Object.freeze({ start: Number(literal.start), end: Number(literal.end) })
	}
}
