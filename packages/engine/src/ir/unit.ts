/**
 * A unit: a value of the key every relation a unit-local rule reads leads with (analysis/theory/unit.ts), each of
 * them immutable, so every fact of the rule's violation lies within one unit and a write changes the rule's verdict
 * only within the units it writes. The judge reads the rule's violation over those units alone (physical/ddl/rules.ts).
 */
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

export interface Unit {
	/** The unit key's types, position by position. */
	readonly key: NonEmptyReadonlyArray<ScalarType>
	/** Each stored relation the rule reads, sorted, with the fields that hold the unit key: its primary key's first
	 * fields, one per position of `key`. */
	readonly holders: NonEmptyReadonlyArray<{
		readonly relation: string
		readonly fields: NonEmptyReadonlyArray<string>
	}>
}
