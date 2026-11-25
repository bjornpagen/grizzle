/**
 * A records' facts (program/records.ts records): the insert of rows a records' query found, each beside its owner's
 * values, as ChangeSet.insertAll takes it, worked out from the records' layout alone (RecordsLayout), data a records
 * value reads off its build and a served file carries (served/forms.ts ServedRecords), so the compile's recordsFacts and
 * a served login's recordedOf (packages/grizzle adapter/public/records.ts) insert one row's facts alike, and a process
 * that serves a login builds them with no records value, query or schema at hand. It loads no compiler.
 */
import { frozenRecordOf, isList, isRecord } from "#compiler/core/record.ts"

/**
 * How an attachment's relation holds its child's records: as an array at its place, nested in its parent's fact at its
 * count, an option, the one child or an arm, each stated apart under its own relation.
 */
export type RecordsHolding = "array" | "option" | "one" | "arm"

/**
 * A relation that holds records, as its insert reads it: its name, its key's fields in order, its stored columns, each
 * attachment's records under it, in the order attached.
 */
export interface RecordsHolder {
	readonly relation: string
	readonly key: ReadonlyArray<string>
	readonly columns: ReadonlyArray<string>
	readonly attachments: ReadonlyArray<RecordsAttachment>
}

/** An attachment's records: its name in its parent's rows, how its relation holds them, and the relation as a holder. */
export interface RecordsAttachment {
	readonly name: string
	readonly holding: RecordsHolding
	readonly holder: RecordsHolder
}

/**
 * What a records' insert is worked out from: its owner's fields in order, its root as a holder, and the relations an
 * insert states apart from the root, in the records' order, each under its name in the insert.
 */
export interface RecordsLayout {
	readonly owner: ReadonlyArray<string>
	readonly root: RecordsHolder
	readonly apart: ReadonlyArray<string>
}

/**
 * Why a found row or an entry is none of a records' rows, refused by the reader of the facts as its caller refuses: the
 * compile's as a malformed description of its call, a served login's as a broken contract.
 */
export type RecordsRefusal = (what: string) => never

/** One fact of a records' insert: its fields' values under their keys, and at each array's count the members it nests. */
interface RecordsFact {
	readonly fields: ReadonlyArray<readonly [string, unknown]>
	readonly nested: ReadonlyArray<readonly [string, ReadonlyArray<RecordsFact>]>
}

/** A fact as the insert holds it: a frozen record, its nested members records too. */
const factRecord = (fact: RecordsFact): Readonly<Record<string, unknown>> =>
	frozenRecordOf([
		...fact.fields,
		...fact.nested.map(
			([count, members]) => [count, Object.freeze(members.map(factRecord))] as const
		)
	])

/** An Option a found row holds, read by its tag: its value, or none. */
const optionValue = (
	value: unknown,
	refuse: RecordsRefusal
): { readonly some: boolean; readonly value: unknown } => {
	if (isRecord(value) && value["_tag"] === "Some") {
		return { some: true, value: value["value"] }
	}
	if (isRecord(value) && value["_tag"] === "None") {
		return { some: false, value: undefined }
	}
	return refuse("an Option of the attachment's records")
}

/** A found row of a holder, refused where it is no record. */
const rowRecord = (row: unknown, refuse: RecordsRefusal): Readonly<Record<string, unknown>> =>
	isRecord(row) ? row : refuse("found rows of the records' query")

/** The facts of a holder's attachments for one of its rows: nested at counts, and apart under their relations. */
interface AttachmentFacts {
	readonly nested: ReadonlyArray<readonly [string, ReadonlyArray<RecordsFact>]>
	readonly apart: ReadonlyArray<readonly [string, RecordsFact]>
}

/**
 * The facts of the holder's attachments for its row `row`, whose key's values are `key`: an array's members nested at
 * its count, each its stored columns and its own arrays, its place its index; every other child's facts apart under
 * its relation's name, its carried key's values then its own.
 */
const attachmentFacts = (
	holder: RecordsHolder,
	key: ReadonlyArray<unknown>,
	row: Readonly<Record<string, unknown>>,
	refuse: RecordsRefusal
): AttachmentFacts => {
	const nested: Array<readonly [string, ReadonlyArray<RecordsFact>]> = []
	const apart: Array<readonly [string, RecordsFact]> = []
	const stateApart = (a: RecordsAttachment, value: unknown): void => {
		const child = rowRecord(value, refuse)
		const below = attachmentFacts(a.holder, key, child, refuse)
		apart.push([
			a.holder.relation,
			{
				fields: [
					...a.holder.key.map((k, i) => [k, key[i]] as const),
					...a.holder.columns.map((c) => [c, child[c]] as const)
				],
				nested: below.nested
			}
		])
		for (const entry of below.apart) {
			apart.push(entry)
		}
	}
	for (const a of holder.attachments) {
		const value = row[a.name]
		switch (a.holding) {
			case "array": {
				if (!isList(value)) {
					return refuse(`an array of ${a.name}'s records`)
				}
				nested.push([
					a.name,
					value.map((member, i): RecordsFact => {
						const child = rowRecord(member, refuse)
						const below = attachmentFacts(a.holder, [...key, BigInt(i)], child, refuse)
						for (const entry of below.apart) {
							apart.push(entry)
						}
						return {
							fields: a.holder.columns.map((c) => [c, child[c]] as const),
							nested: below.nested
						}
					})
				])
				break
			}
			case "option":
			case "arm": {
				const option = optionValue(value, refuse)
				if (option.some) {
					stateApart(a, option.value)
				}
				break
			}
			case "one":
				stateApart(a, value)
				break
		}
	}
	return { nested, apart }
}

/**
 * The insert of found rows into the records `layout` lays out, each row beside its owner's values (`[owner, row]`; one
 * owner's several rows share it), at the type `I` its caller states: under the root's name each row's fact, its owner's
 * values then its stored columns with each array's members nested at its count, and under each apart relation's name
 * its facts. A row or an Option that is none of the records' query's is refused by `refuse`.
 */
export const recordsFacts =
	<I>(layout: RecordsLayout, refuse: RecordsRefusal) =>
	(entries: Iterable<readonly [unknown, unknown]>): I => {
		/**
		 * The one site of the fact "an insert recordsFacts builds is its caller's I": a list of facts under every relation
		 * the layout names, the root's and each apart relation's, which the caller's records type states
		 * (types/schema/records.ts RecordsInsert) and no TypeScript type ties to the layout, read off the insert itself.
		 */
		const holdsLayout = (
			insert: Readonly<Record<string, unknown>>
		): insert is Readonly<Record<string, unknown>> & I =>
			[layout.root.relation, ...layout.apart].every((name) => isList(insert[name]))
		const { root } = layout
		const apart = new Map<string, Array<RecordsFact>>(layout.apart.map((name) => [name, []]))
		const facts = Array.from(entries, ([owner, delivered]): RecordsFact => {
			const values = isRecord(owner) ? owner : refuse("an owner's values, a record of its fields")
			const key = root.key.map((k) => values[k])
			const row = rowRecord(delivered, refuse)
			const below = attachmentFacts(root, key, row, refuse)
			for (const [name, fact] of below.apart) {
				apart.get(name)?.push(fact)
			}
			return {
				fields: [
					...layout.owner.map((field) => [field, values[field]] as const),
					...root.columns.map((c) => [c, row[c]] as const)
				],
				nested: below.nested
			}
		})
		const insert: Readonly<Record<string, unknown>> = frozenRecordOf(
			[[root.relation, facts] as const, ...apart].map(
				([name, relationFacts]) => [name, Object.freeze(relationFacts.map(factRecord))] as const
			)
		)
		if (!holdsLayout(insert)) {
			return refuse("an insert of every relation the records lay out")
		}
		return insert
	}
