/**
 * A unit: a value of the key every relation a unit-local rule reads leads with (analysis/theory/unit.ts), each of
 * them immutable, so every fact of the rule's violation lies within one unit and a write changes the rule's verdict
 * only within the units it writes. The judge reads the rule's violation over those units alone (physical/ddl/rules.ts).
 */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
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

/**
 * The unit of a stored derived relation (ir/desc.ts DerivedStorage `stored`), as its admission decided it
 * (analysis/theory/unit.ts storedUnit): the unit its definition is unit-local at, the widest at which its head delivers
 * it, and the fields of the stored relation that hold the unit key, one per position of `unit.key`. Its rows at one
 * unit are its definition's rows there, which the relations `unit.holders` hold, so grizzle replaces them by unit, and
 * the isolation checker reads which unit a read or a write of it stands in from here, never deriving it again.
 */
export interface StoredUnit {
	readonly kind: "unit"
	readonly unit: Unit
	readonly fields: NonEmptyReadonlyArray<string>
	/**
	 * The declared unit its rows sit under (schema/own.ts OwnedUnit), the one its every holder sits in, whose key leads
	 * `unit`'s, and the fields of the stored relation that carry that unit's key, the first of `fields`: every write of a
	 * holder's rows holds that unit exclusively, so grizzle writes the stored rows at COMMIT under the writer's own
	 * borrow, and a write that reads them borrows it shared, as it does to read its holders.
	 */
	readonly declared: { readonly unit: string; readonly fields: NonEmptyReadonlyArray<string> }
}

/**
 * A stored derived relation frozen at the installation (analysis/theory/frozen.ts): its definition reads no relation a
 * program writes, only closed relations, which a migration alone writes, and stored relations frozen alike, every
 * function it calls immutable, so its rows change only with a migration, which fills its table again
 * (physical/derived/meaning.ts, its meaning reading the closed facts), and no COMMIT keeps it.
 */
export interface FrozenUnit {
	readonly kind: "installation"
}

/** Where a stored derived relation's rows are kept: by the unit its admission decided, or frozen at the installation. */
export type StoredHolding = StoredUnit | FrozenUnit
