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
	 * `unit`'s, and the fields of the stored relation that carry that unit's key, the first of `fields`: the judge of
	 * every transaction that wrote a holder's rows borrows that unit exclusively at their keys before its upkeeps read
	 * anything (physical/ddl/rules.ts judgeBorrow), so grizzle writes the stored rows at COMMIT under that borrow, and a
	 * write that reads them borrows it shared, as it does to read its holders.
	 */
	readonly declared: { readonly unit: string; readonly fields: NonEmptyReadonlyArray<string> }
	/**
	 * The relations of sealed units its definition reads by reference, in name order, none where it reads none
	 * (analysis/theory/unit.ts storedUnit): each sits under a sealed unit other than `declared`, whose rows at a key never
	 * change once founded (analysis/theory/frozen.ts foundedAt), and each read of one stands at a key a row of `unit`'s
	 * holders reaches by a containment the schema states, so every such key was founded, and every row there written,
	 * before any row of the unit read it. So no holder of `unit` is among them, no write of theirs but a data step's
	 * removal changes its rows, and its upkeep at a unit reads their rows by the keys that unit's rows name.
	 */
	readonly references: ReadonlyArray<string>
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
