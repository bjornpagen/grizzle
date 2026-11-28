/**
 * A write through a query entry whose filter narrows its target T is read over the objects its role's row security
 * holds it to (program/isolation/member-facts.ts extractNames, program/isolation/extract.ts): T is its relation, a read
 * of T the role makes directly is filtered by the role's policy on T, whose USING is the entry's membership
 * (physical/ddl/roles.ts entryMembership), a call of the entry's filter function or of a key probe is its body at its
 * arguments, and a read of the entry's view is its definition. At 1d105e86c the extractor named no T the role reaches
 * under a policy whose filter reads another relation, read the filter function, the key probe and the view as objects
 * it states no fact of, and charged every relation the installation names with a foreign key check of each statement
 * writing T: metis core's operator held 30,120 such reasons (15,060 pivot, 15,060 snapshot) of 55,910.
 *
 * The box: Account (clerk -> person) and Grant (person, program), which `admin` inserts with Item and Holder (clerk,
 * number); T (number, item, origin), contained in Item, written by `writer` only through `Mine`, T's rows while the
 * session's user holds `act` (a filter reading Account and Grant), T's rows while the session's claim stands (one
 * reading no relation), every row of T, or every row of T in the writer's world, its scope binding T's unit at the
 * numbers Holder gives the session's user; the write an insert, a put, or a delete by `number`, or an insert of Item
 * from the numbers Mine's view holds; compiled for READ COMMITTED as generate compiles it.
 *
 * Oracle: the policy's own semantics, over the writer's facts:
 * - every object a fact names is a relation of the installation or the call's own carrier;
 * - every update or delete of T is fed by a positive read of T and of each relation the filter reads: USING keeps a row
 *   of T the statement changes only where the membership holds of it;
 * - the insert of T is fed by none of them: WITH CHECK only refuses a row, so no row it writes is joined with them;
 * - where the write states rows (an insert, a put), a statement that writes nothing, the entry's precheck, reads T, its
 *   key probe's body, and each relation the filter reads, its filter function's, by their absence;
 * - the read of the numbers Mine's view holds, which the insert of Item copies, reads T and every relation the view
 *   reads by their rows, its definition as the installation renders it (physical/access/world-views.ts): the filter's
 *   relations, and a scoped writer's scope owner's, Holder, at whose keys the view reads T in the writer's world, so
 *   READ COMMITTED's certificate holds the owner's read wherever the scope restricts the rows a write reads.
 *
 * Features: each filter and each write.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import type {
	MemberFacts,
	ReadFact,
	StatementFacts,
	WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { readCommittedChanges, variantsEntries } from "#compiler/program/workload/change.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type Drawn,
	drawnGen,
	type Filter,
	filterReads,
	policedLoginOf,
	viewReads,
	type Write
} from "#test/unit/program/isolation/policed-reads.fixtures.ts"

type Feature = Filter | Write

/** The relations the installation states, besides the call's own carriers. */
const RELATIONS: ReadonlyArray<string> = ["Account", "Grant", "Holder", "Item", "T"]

/** Every read a statement makes: its own body's and each query CTE instance's. */
const readsOf = (s: StatementFacts): ReadonlyArray<ReadFact> => [
	...s.reads,
	...Arr.flatMap(s.ctes, (c) => c.reads)
]

/** The reads a write's rows are positively joined with (WriteFact `from`). */
const fedBy = (s: StatementFacts, w: WriteFact): ReadonlyArray<ReadFact> =>
	Arr.flatMap(w.from, (at) => {
		const read = at.cte === undefined ? s.reads[at.read] : s.ctes[at.cte]?.reads[at.read]
		return read === undefined ? [] : [read]
	})

/** Every object a member's facts name, read or written. */
const namedBy = (m: MemberFacts): ReadonlyArray<string> =>
	Arr.flatMap(m.statements, (s) => [
		...Arr.map(readsOf(s), (r) => r.relation),
		...Arr.map(s.writes, (w) => w.relation)
	])

/** The writer's facts in a case, every variant's. */
const writerFacts = (drawn: Drawn): ReadonlyArray<MemberFacts> => {
	const login = policedLoginOf(drawn)
	const roles = succeeded(readCommittedChanges(login, silentPhases), "the login's compile")
	return Arr.flatMap([...roles], ([name, role]) =>
		name === "writer"
			? Arr.flatMap([...role.changes.members.values()], (variants) =>
					Arr.flatMap(variantsEntries(variants), (entry) => entry.facts)
				)
			: []
	)
}

/** A write through a query entry is read over the objects its role's row security holds it to. */
export const aWriteThroughAPolicedEntryIsReadOverItsRowSecurity = property.exhaust(
	finite(drawnGen),
	{
		box: "T contained in Item, written through an entry filtered by Account and Grant, by the session alone, not at all or by the writer's scope over Holder, by insert, put or delete, or copied into Item",
		needs: {},
		situations: [
			"others",
			"session",
			"none",
			"scoped",
			"insert",
			"put",
			"delete",
			"copy"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawn: Drawn) =>
			Effect.sync(() => {
				const { filter, write } = drawn
				c.note(filter)
				c.note(write)
				const label = `${filter} filter, ${write}`
				const reads = filterReads[filter]
				const members = writerFacts(drawn)
				assert.ok(members.length > 0, `${label}: the writer's member states facts`)
				for (const m of members) {
					assert.deepEqual(
						Arr.filter(
							namedBy(m),
							(relation) => !RELATIONS.includes(relation) && !Str.startsWith("carrier:")(relation)
						),
						[],
						`${label}: every object a fact names is a relation or the call's carrier`
					)
					for (const s of m.statements) {
						for (const w of s.writes) {
							const fed = Arr.map(fedBy(s, w), (r) => r.relation)
							if (w.op === "update" || w.op === "delete") {
								assert.deepEqual(
									Arr.filter(["T", ...reads], (r) => !fed.includes(r)),
									[],
									`${label}: an update or delete of T is fed by T and every relation the filter reads`
								)
							}
							if (w.op === "insert" && w.relation === "T") {
								assert.deepEqual(
									Arr.filter(reads, (r) => fed.includes(r)),
									[],
									`${label}: an insert of T is fed by no relation the filter reads`
								)
							}
						}
					}
					if (write === "copy") {
						/** Each relation the member's statements read by its rows' presence or their number. */
						const found = Arr.flatMap(m.statements, (s) =>
							Arr.flatMap(readsOf(s), (r) =>
								r.mode === "positive" || r.mode === "counted" ? [r.relation] : []
							)
						)
						assert.deepEqual(
							Arr.filter(["T", ...viewReads[filter]], (r) => !found.includes(r)),
							[],
							`${label}: the read of the view's numbers reads T and every relation the view reads by their rows`
						)
					}
					if (write === "insert" || write === "put") {
						const prechecks = Arr.filter(m.statements, (s) => s.writes.length === 0)
						const absent = (relation: string): boolean =>
							Arr.some(prechecks, (s) =>
								Arr.some(readsOf(s), (r) => r.relation === relation && r.mode === "negated")
							)
						assert.deepEqual(
							Arr.filter(["T", ...reads], (r) => !absent(r)),
							[],
							`${label}: the precheck reads T and every relation the filter reads by their absence`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the role's row security: T a relation, USING a delete's join, WITH CHECK no join, a world function its body"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/member-facts.ts",
				original: '\t\t\tr.kind === "relation" ? [r.name] : []\n',
				replacement:
					'\t\t\tr.kind === "relation" && ![...owned.writes.values()].some((w) => w.kind !== "whole" && w.writable.target === r.name) ? [r.name] : []\n',
				why: 'A table the role writes through a query entry left unnamed, as at 1d105e86c: T reads as `?"policed_reads"."t"`, so a fact names an object the installation states no fact of; the property fails.'
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					'\t\t\tfound.context.reader === "owner" ? undefined : this.#statement.names.policyOf(table)',
				replacement: "\t\t\tundefined",
				why: "A read of T the role makes directly read past its policy's USING: a put's delete of T is fed by T alone, never by the Account and Grant the policy's membership reads; the property fails."
			},
			{
				file: "packages/engine/src/program/isolation/member-facts.ts",
				original: "\t\tif (filterReadsOther(writable)) {",
				replacement: '\t\tif (filterReadsOther(writable) && writable.filter.kind === "none") {',
				why: "The entry's filter function left opaque, as at 1d105e86c: its call reads as `?function:...`, an object the installation states no fact of; the property fails."
			},
			{
				file: "packages/engine/src/program/isolation/member-facts.ts",
				original: "\t\tdefinitions.set([view.schema, view.name], {",
				replacement: "\t\tdefinitions.set([view.schema, view.name.toUpperCase()], {",
				why: 'The entry\'s view read as a table no relation is, as at 1d105e86c: a delete through it reads `?"policed_reads__writer"."mine"`; the property fails.'
			},
			{
				file: "packages/engine/src/program/isolation/member-facts.ts",
				original:
					"\t\t\t\t\trows: {\n\t\t\t\t\t\t...world.checked.world.base.rows(world.checked.writable),\n\t\t\t\t\t\tworld: world.checked.worldRows()\n\t\t\t\t\t}\n",
				replacement: "\t\t\t\t\trows: world.checked.world.base.rows(world.checked.writable)\n",
				why: "The certifier's model of a scoped writer's view reads T in reality's world, as at 3a53e9d9: the read of the view's numbers reads T alone, Holder only by its absence in the insert's precheck, never the scope owner's rows the installed view reads; the property fails."
			}
		]
	}
)
