import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { DerivedAnalysis } from "#compiler/analysis/schema.ts"
import type { RegionFacts } from "#compiler/analysis/theory/unit.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { type NameKey, nameKey } from "#compiler/sql/ast.ts"
import type { ReadTable, ReadTables } from "#compiler/sql/unit-bound.ts"

/**
 * The tables a program's statements may read (sql/unit-bound.ts ReadTables): each stored relation the law model keys
 * (its primary key, then each candidate key; a stored derived relation by the keys its view's unique indexes hold,
 * `derived`) and each that sits under a declared unit, a stored derived relation its
 * admission seats under one among them (analysis/theory/unit.ts RegionFacts members), under every name a statement reads
 * it by: its installed table (`names`), which a write writes, and the view a program reads it through (`reads`), where
 * `readable` says the program reads it there. A stored derived relation whose rows are an open frontier (RegionFacts
 * `frontiers`) is read at no unit (UnitReach `frontier`).
 */
export const readTables = (
	facts: RegionFacts,
	derived: DerivedAnalysis | undefined,
	names: PhysicalNames,
	reads: PhysicalNames,
	readable: (relation: string) => boolean
): ReadTables => {
	const out = new Map<NameKey, ReadTable>()
	const add = (at: PhysicalNames, relation: string): void => {
		const columns = (fields: NonEmptyReadonlyArray<string>): NonEmptyReadonlyArray<string> =>
			mapNonEmpty(fields, (f) => at.column(relation, f))
		const member = facts.members.get(relation)
		const settledBy = facts.frontiers.get(relation)
		const table = at.relation(relation)
		out.set(nameKey({ schema: table.schema, name: table.name }), {
			relation,
			keys: (
				facts.keys.get(relation) ??
				(derived?.relations[relation]?.keys ?? []).flatMap((k) =>
					isNonEmpty(k.fields) ? [k.fields] : []
				)
			).map(columns),
			unit:
				member === undefined || !isNonEmpty(member.fields)
					? { kind: "none" }
					: settledBy === undefined
						? { kind: "member", name: member.unit, columns: columns(member.fields) }
						: { kind: "frontier", name: member.unit, settledBy },
			determined: []
		})
	}
	for (const relation of new Set([...facts.keys.keys(), ...facts.members.keys()])) {
		add(names, relation)
		if (reads !== names && readable(relation)) {
			add(reads, relation)
		}
	}
	return out
}
