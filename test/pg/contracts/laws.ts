/**
 * The plan contracts' laws over the plans of what a drawn shape's calls send (observed.ts), each a list of the problems
 * it finds:
 * none where the contract holds. Each states its bound from first principles and reads PostgreSQL's plan or the wire
 * against the claim: the model's (shapes.ts), the compiler's own facts it is drawn against, or both.
 */

import { Array as Arr, Option, Record as Rec } from "effect"
import type { Called, Observed, Sent } from "#test/pg/contracts/observed.ts"
import {
	type ReadAsks,
	askedOf,
	contentAsked,
	contentNames,
	contentRead,
	derivedName,
	memberKey,
	memberName,
	ownerName,
	publishWrite,
	readName,
	type ShapeSketch
} from "#test/pg/contracts/shapes.ts"
import type { CopyIndex } from "#test/pg/physical/copies.ts"
import { readText, type ScanBinding, scanBindings } from "#test/pg/physical/plan-bindings.ts"

/** Every relation of the shape, by its declared name: its members, its derived relations, and its content's. */
const relationNames = (s: ShapeSketch): ReadonlyArray<string> => [
	...Arr.map(s.members, (_, at) => memberName(at)),
	...Arr.map(s.derived, (_, at) => derivedName(at)),
	ownerName,
	...(s.content ? Rec.values(contentNames) : [])
]

/**
 * The relation a relation of the shape is installed as: itself, or, a stored derived relation, the canonical relation
 * whose table holds it (analysis/derived/canonical.ts), which two derived relations of one definition share.
 */
const installedAs = (s: ShapeSketch, o: Observed, relation: string): string =>
	isDerived(s, relation) && isStored(o, relation)
		? o.installed.installation.checked.canonicalOf(relation).subject.name
		: relation

/**
 * The shape's relations by the table each is installed in, `<schema>.<table>`: each member's and each stored derived
 * relation's, by the relation it is installed as (`installedAs`, ir/physical.ts PhysicalNames relation).
 */
const relationsByTable = (s: ShapeSketch, o: Observed): ReadonlyMap<string, string> => {
	const names = o.installed.installation.names
	return new Map(
		Arr.flatMap(Arr.dedupe(Arr.map(relationNames(s), (r) => installedAs(s, o, r))), (relation) =>
			isDerived(s, relation) && !isStored(o, relation)
				? []
				: [
						[
							`${names.relation(relation).schema}.${names.relation(relation).name}`,
							relation
						] as const
					]
		)
	)
}

/** A model's claim (shapes.ts ReadAsks) over the relations as installed (`installedAs`), occurrences summed. */
const asInstalled = (s: ShapeSketch, o: Observed, asked: ReadAsks): ReadAsks => {
	const fields = new Map<string, ReadonlySet<string>>()
	const occurrences = new Map<string, number>()
	for (const [relation, f] of asked.fields) {
		fields.set(installedAs(s, o, relation), f)
	}
	for (const [relation, n] of asked.occurrences) {
		const as = installedAs(s, o, relation)
		occurrences.set(as, (occurrences.get(as) ?? 0) + n)
	}
	return { fields, occurrences }
}

/** Whether a relation of the shape is a derived one. */
const isDerived = (s: ShapeSketch, relation: string): boolean =>
	Arr.some(s.derived, (_, at) => derivedName(at) === relation) ||
	relation === contentNames.fact ||
	relation === contentNames.sightings

/** The relation a scan reads, by its table, or none for a table of no relation of the shape. */
const scannedRelation = (
	tables: ReadonlyMap<string, string>,
	scan: ScanBinding
): Option.Option<string> => Option.fromUndefinedOr(tables.get(`${scan.schema}.${scan.relation}`))

/** Whether a derived relation of the shape is stored in a table of its own. */
const isStored = (o: Observed, relation: string): boolean =>
	o.installed.installation.checked.holdings.get(relation)?.kind === "stored"

/** The model of the read a call of `program` makes (shapes.ts ReadAsks), as the installation holds each relation. */
const readAsked = (s: ShapeSketch, o: Observed, program: string): Option.Option<ReadAsks> =>
	Option.map(
		program === contentRead
			? Option.some(contentAsked((name) => isStored(o, name)))
			: Option.map(
					Arr.findFirst(s.reads, (_, at) => readName(at) === program),
					(read) => askedOf(s, read, (name) => isStored(o, name))
				),
		(asked) => asInstalled(s, o, asked)
	)

/** Every scan of a table in each statement a call sent, with the statement. */
const scansOf = (
	call: Called
): ReadonlyArray<{ readonly sent: Sent; readonly scan: ScanBinding }> =>
	Arr.flatMap(call.sent, (sent) => Arr.map(scanBindings(sent.plan), (scan) => ({ sent, scan })))

/** The columns of `relation` holding `fields`. */
const columnsOf = (
	o: Observed,
	relation: string,
	fields: Iterable<string>
): ReadonlyArray<string> =>
	Arr.map([...fields], (f) => o.installed.installation.names.column(relation, f))

/** The primary key's fields of the relation `relation`, a member's: the unit's field and its own keys; none for any other. */
const keyFieldsOf = (s: ShapeSketch, relation: string): ReadonlyArray<string> =>
	Option.match(
		Arr.findFirst(s.members, (_, at) => memberName(at) === relation),
		{ onNone: () => [], onSome: memberKey }
	)

/** The leading run of `index`'s columns a scan's index condition binds by equality: the prefix it descends by. */
const runOf = (index: CopyIndex, scan: ScanBinding): ReadonlyArray<string> => {
	const run: Array<string> = []
	for (const c of index.columns) {
		if (!scan.bound.has(c)) {
			break
		}
		run.push(c)
	}
	return run
}

/**
 * The columns a scan binds in the leading run of an index it reads (`runOf`), each index's: what it descends by. A
 * column bound past an unbound one, a skip scan's, is read at every value of the columns before it, as many descents
 * as they hold values, and binds nothing of the run.
 */
const leadingRun = (indexes: ReadonlyArray<CopyIndex>, scan: ScanBinding): ReadonlySet<string> => {
	const run = new Set<string>()
	for (const i of indexes) {
		if (scan.indexes.includes(i.name)) {
			for (const c of runOf(i, scan)) {
				run.add(c)
			}
		}
	}
	return run
}

/** Whether a scan reads at most one row by a key: every column of a unique index it reads in its leading run. */
const byKey = (indexes: ReadonlyArray<CopyIndex>, scan: ScanBinding): boolean =>
	Arr.some(
		indexes,
		(i) => i.unique && scan.indexes.includes(i.name) && runOf(i, scan).length === i.columns.length
	)

/**
 * C3, keyed reach: every scan of a keyed relation carries every key column the read binds in its index condition,
 * through every derivation between the read and the relation. The bound is the one a keyed read is priced by: a read of
 * k rows of a relation of n reads O(k log n) pages exactly where each of its scans descends an index by every column
 * the read fixes, and a scan that leaves one out reads every row of the rest, a number that grows with the population.
 *
 * - A read's binding is the model's (shapes.ts askedOf): its `doc`, and its `k0` where it binds it, or its `k0` alone,
 *   reach every occurrence of a member in a live derived relation's definition, as the rule's shared variables equate
 *   them, and the stored table of a stored one; each scan of such a relation binds them in the leading run of an index
 *   it reads (`leadingRun`), never past a column it leaves unbound, which a skip scan reads at every value of, or
 *   reads at most one row by a key (`byKey`), as a probe of a key of `k0` alone does.
 * - Every scan a write's statement makes of a member binds in its index condition every column of the member's key its
 *   plan offers it, its own equalities' and the join's that probes its side (plan-bindings.ts binding): a write of k
 *   facts reads each member at the keys of the facts it holds, never the rows of their unit by part of them, which a
 *   unit's history grows. A read's join inside its unit may hash the rows its binding already bounds: its own rows are
 *   the unit's at the binding, so the bound is the read's binding reaching every scan, not each join's.
 */
export const keyedReach = (s: ShapeSketch, o: Observed): ReadonlyArray<string> => {
	const tables = relationsByTable(s, o)
	return Arr.flatMap(o.calls, (call) => {
		const asked = call.kind === "read" ? readAsked(s, o, call.program) : Option.none()
		return Arr.flatMap(scansOf(call), ({ sent, scan }) =>
			Option.match(scannedRelation(tables, scan), {
				onNone: () => [],
				onSome: (relation) => {
					const fromRead = Option.match(asked, {
						onNone: () => [],
						onSome: (a) => columnsOf(o, relation, a.fields.get(relation) ?? [])
					})
					const offered =
						call.kind === "write"
							? Arr.filter(columnsOf(o, relation, keyFieldsOf(s, relation)), (c) =>
									scan.binding.has(c)
								)
							: []
					const indexes = o.indexes.get(`${scan.schema}.${scan.relation}`) ?? []
					const run = leadingRun(indexes, scan)
					const missing = byKey(indexes, scan)
						? []
						: Arr.dedupe(Arr.filter([...fromRead, ...offered], (c) => !run.has(c)))
					return missing.length === 0
						? []
						: [
								`${call.program}'s ${sent.name} reads ${relation} as ${scan.alias} by ${readText(scan)}, the leading run of its index binding (${Arr.join([...run], ", ")}), where the ${call.kind} binds (${Arr.join(missing, ", ")}) too`
							]
				}
			})
		)
	})
}

/**
 * C1, statement size: a read's statement is as large as its definition. Its size is counted in relation scans, the
 * definition's in the occurrences of the relations it reads, a stored relation counted once as its table and a live
 * one as its own definition's (shapes.ts askedOf), so the size bound's constant is one: each relation a read's plan
 * scans is one its definition reads, at most once per occurrence. A plan that scans a relation more often than its
 * definition reads it spells a derivation again in place, which costs its planning and its pages in every call, and one
 * that scans a stored relation's definition reads its derivation per call, where its table holds it. The definition's
 * size is the model's: the definition size the compiler serves for each statement replaces it, the law unchanged.
 */
export const statementSize = (s: ShapeSketch, o: Observed): ReadonlyArray<string> => {
	const tables = relationsByTable(s, o)
	return Arr.flatMap(o.calls, (call) =>
		Option.match(call.kind === "read" ? readAsked(s, o, call.program) : Option.none(), {
			onNone: () => [],
			onSome: (asked) => {
				const scanned = Arr.flatMap(scansOf(call), ({ scan }) =>
					Option.toArray(scannedRelation(tables, scan))
				)
				return Arr.flatMap(Arr.dedupe(scanned), (relation) => {
					const scans = Arr.filter(scanned, (r) => r === relation).length
					const at = asked.occurrences.get(relation) ?? 0
					return scans <= at
						? []
						: [
								`${call.program} scans ${relation} ${scans} times, where its definition reads it at ${at} occurrences`
							]
				})
			}
		})
	)
}

/**
 * C7, publication facts: a fact derived from sealed content alone is derived once, when its package is published, and a
 * call reads it by key, never deriving it again from the content it is a fact of. Sealed content is written whole by
 * the one transaction that founds its unit (analysis/theory/frozen.ts), so the fact over it is the same at every call
 * on it, and a call that derives it reads every row of the content its key reaches, on every call, where its stored
 * table holds the answer at one probe. So F, the count of a package's items, which re-derives the whole package at
 * every write of it and is stored only because the package is sealed, is stored (analysis/derived/storage.ts),
 * and no statement a call sends scans I0 or I1, the content F is the fact of, but the publication's own, which writes
 * them: L's read reads F's table at the packages Seen's rows name, and no other call reads the content.
 */
export const publicationFacts = (s: ShapeSketch, o: Observed): ReadonlyArray<string> => {
	if (!s.content) {
		return []
	}
	const tables = relationsByTable(s, o)
	const content: ReadonlySet<string> = new Set([contentNames.items, contentNames.modes])
	return [
		...(isStored(o, contentNames.fact)
			? []
			: [
					`F, a fact of sealed content alone, is ${o.installed.installation.checked.holdings.get(contentNames.fact)?.kind ?? "unheld"}: every call derives it again`
				]),
		...Arr.flatMap(o.calls, (call: Called): ReadonlyArray<string> =>
			call.program === publishWrite
				? []
				: Arr.flatMap(scansOf(call), ({ sent, scan }) =>
						Option.match(scannedRelation(tables, scan), {
							onNone: () => [],
							onSome: (relation) =>
								content.has(relation)
									? [
											`${call.program}'s ${sent.name} scans ${relation}, the content F is the fact of, by ${readText(scan)}`
										]
									: []
						})
					)
		)
	]
}
