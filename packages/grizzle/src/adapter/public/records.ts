import type { Result } from "effect"
import { rowOptions, toResult } from "#adapter/engine.ts"
import { RecordsUnserved } from "#adapter/errors/failures.ts"
import type { ServedLogin } from "#adapter/types/layer.ts"
import type {
	AnyRecords,
	CodecFault,
	HeadOf,
	OwnerFacts,
	RecordsInsert
} from "#compiler/plan/common.ts"
import {
	defect,
	parseDeclaredName,
	Roster,
	recordsFacts,
	rowTextOf
} from "#compiler/plan/runtime.ts"

/**
 * Public barrel: a served login's records, read off its served file alone (served/forms.ts ServedFile records), so a
 * process that serves a login, a den worker's among them, reads a found row's text and builds the insert of found rows
 * with no records value, query or schema at hand: its records, its level and its rows by type alone.
 * packages/grizzle/src/runtime.ts re-exports it.
 */

/**
 * A served login's records R, which the level L lists (recordedOf): `text(row)`, the one text of a row the records'
 * query found, rowText(query)(row)'s byte for byte (both runtime/read/text.ts rowTextOf, over the query's rows' form),
 * or the CodecFault of a value its type does not admit; and `facts(entries)`, recordsFacts(level, records)(entries)'s
 * insert of found rows, each beside its owner's values (both runtime/records.ts recordsFacts, over the records'
 * layout).
 */
export interface Recorded<L, R extends AnyRecords> {
	readonly text: (row: HeadOf<R>) => Result.Result<string, CodecFault>
	readonly facts: (entries: Iterable<readonly [OwnerFacts<R>, HeadOf<R>]>) => RecordsInsert<L, R>
}

/**
 * recordedOf<L, R>(served, stem): the records R of stem `stem`, which the level L lists, as the login's served file
 * carries them (Recorded), its rosters read once here and its layout once: bind it once, where the login is served, and
 * read every row by it. The file carries the records whose relations the login's programs read or write; any other
 * stem is RecordsUnserved, thrown here.
 */
export const recordedOf = <L, R extends AnyRecords>(
	served: Pick<ServedLogin<never>, "name" | "file">,
	stem: R["name"]
): Recorded<L, R> => {
	const entry = served.file.records.get(stem)
	if (entry === undefined) {
		throw new RecordsUnserved({ login: served.name, stem })
	}
	const rosters = new Map<string, Roster>()
	const rosterOf = (name: string): Roster => {
		const known = rosters.get(name)
		if (known !== undefined) {
			return known
		}
		const handles = entry.rosters.get(name)
		const declared = parseDeclaredName(name)
		if (handles === undefined || !declared.ok) {
			defect(`a column's roster ${name} is one its records' served form carries`)
		}
		const roster = Roster.of(declared.value, handles.order, handles.handles)
		rosters.set(name, roster)
		return roster
	}
	const text = rowTextOf(entry.form, rosterOf, rowOptions)
	return {
		text: (row) => toResult(text(row)),
		facts: recordsFacts<RecordsInsert<L, R>>(entry.layout, (what) => {
			defect(`a found row of records ${stem}: ${what}`)
		})
	}
}
