/** What the properties of fields.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { type TextSearchConfiguration, textSearchConfigurations } from "#compiler/ir/search.ts"
import { numericMaxFractionDigits, numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import {
	fieldSketchGen,
	type PgMember,
	type SketchedField
} from "#test/support/unit/schema/field-sketch.ts"
import { upTo } from "#test/support/up-to.ts"

/** A relation of drawn fields: each roster's handle count, and its fields' types, each contract named by its field. */
interface DeclaredCase {
	readonly rosters: Arr.NonEmptyReadonlyArray<number>
	readonly fields: Arr.NonEmptyReadonlyArray<SketchedField>
}

export const handlesOf = (count: number): Arr.NonEmptyReadonlyArray<string> =>
	Arr.prepend(
		Arr.map(
			upTo(count - 1, (i) => i + 1),
			(h) => `h${h}`
		),
		"h0"
	)

export const declaredGen: Gen<DeclaredCase> = (source) => {
	const rosters = nonEmpty(source.draw(array(int(1, 3), { min: 1, max: 2 })), "the rosters")
	const fields = nonEmpty(
		source.draw(array(fieldSketchGen(rosters.length, constant("C")), { min: 1, max: 4 })),
		"the fields"
	)
	return {
		rosters,
		fields: Arr.map(fields, (f, i): SketchedField =>
			f.kind === "contract" ? { ...f, name: `C${i}` } : f
		)
	}
}

/**
 * A declared field's kind, a `pg` member's by its member: each member is a descriptor of its own, which its own arm of
 * declaredDescOf gives back, so a case of one member reaches no other's.
 */
export type DeclaredFeature = `kind ${Exclude<SketchedField["kind"], "pg">}` | `pg ${PgMember}`

/**
 * Where a derived definition's cast stands: in its head; in an aggregate of its head, the ledger's LastPresence,
 * `r.max(Type.cast(…, LastBeacon))`; or in the head of a query its definition imports, a canonical relation of its own,
 * PresentTime's import, its pieces cast to PieceStart.
 */
export type CastSite = "head" | "max" | "import"

/**
 * Contracts over bigint, each checked or not, the ones a relation declares, the one a derived field is cast to, and
 * where the cast stands.
 */
interface ContractCase {
	readonly contracts: ReadonlyArray<boolean>
	readonly declared: ReadonlyArray<number>
	readonly target: number
	readonly site: CastSite
}

/** A contract predicate VALUE >= 0, as Logic.ge records it. */
export const nonNegative: OpenExpr = {
	kind: "compare",
	op: "ge",
	left: { kind: "value" },
	right: { kind: "literal", value: 0n }
}

export const contractCaseGen: Gen<ContractCase> = (source) => {
	const contracts = source.draw(array(boolean, { min: 1, max: 3 }))
	return {
		contracts,
		declared: source.draw(subarray(upTo(contracts.length, (i) => i))),
		target: source.draw(int(0, contracts.length - 1)),
		site: source.draw(element(["head", "max", "import"] as const))
	}
}

/** Where a derived field holds a variant column: its definition's head, or the head of a query the definition imports. */
export type VariantSite = "head" | "import"

/**
 * A variant a derived field holds, qti-pie's QtiValue's shape, two arms of two fields each: whether each arm states
 * the check that orders its two fields, and where the definition finds its column.
 */
export interface VariantCase {
	readonly checks: readonly [boolean, boolean]
	readonly site: VariantSite
}

export const variantCaseGen: Gen<VariantCase> = (source) => ({
	checks: [source.draw(boolean), source.draw(boolean)],
	site: source.draw(element(["head", "import"] as const))
})

/**
 * A stored field of a read's column, one of the three kinds a records relation keeps of a read's heading: a search
 * document of a configuration (pg.tsvector), numeric of no typmod within a computed bound (pg.numeric.within), or at
 * numeric's own limits (pg.numeric, the bound's one descriptor), and an instant stored as it is (instant.stored).
 */
export type StoredKind =
	| { readonly kind: "search"; readonly configuration: TextSearchConfiguration }
	| { readonly kind: "bound"; readonly digits: number; readonly scale: number }
	| { readonly kind: "own limits" }
	| { readonly kind: "stored instant" }

export const storedKindGen: Gen<StoredKind> = weighted<StoredKind>([
	[2, (s) => ({ kind: "search", configuration: s.draw(element(textSearchConfigurations)) })],
	[
		3,
		(s) => ({
			kind: "bound",
			digits: s.draw(int(-numericMaxFractionDigits, numericMaxIntegerDigits - 1)),
			scale: s.draw(int(0, numericMaxFractionDigits))
		})
	],
	[1, () => ({ kind: "own limits" })],
	[1, () => ({ kind: "stored instant" })]
])
