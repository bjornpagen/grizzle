/**
 * A ChangeSet editing a counted family's members in one stratum and nesting an ordered family's members under new owners
 * in another, or in the same one, on PostgreSQL 19rc2: each stratum's family statements carry its own family edits only
 * (write/frontend/compile.ts and write/program/compile.ts, the edits of their stratum), so every edit takes effect once,
 * in its stratum, whichever stratum comes first.
 *
 * A case stores clubs 0 and 1 with counted members at drawn ids, each in a drawn club, written through a served member;
 * then applies one ChangeSet that deletes some stored members and inserts fresh ones, each in a drawn club, beside an
 * insert of up to two docs, each with up to three lines nested, the edit's stratum before the insert's, after it, or the
 * same.
 *
 * - Property: the write is accepted, or no-change where it changes nothing, and leaves exactly the model's state.
 * - Oracle: the write restated (README, "Writing a family"): the members are the stored ones less the deleted plus the
 *   inserted, as a set; each club's count is its members'; each doc's count is its lines'; and each line sits at the
 *   slot of its place among its doc's nested lines, in order.
 * - Features: each placement; a stored member deleted, a member inserted, both in one edit; a club emptied; a doc of no
 *   line.
 *
 * A stratum that planned every stratum's member edits would leave no trace here: on these lawful ChangeSets an edit
 * planned again in another stratum deletes nothing and meets its inserts as exact repeats, so the stored state and the
 * outcome are the same. The structural property in test/unit/write/stratum-edits.test.ts holds each edit to its
 * stratum.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import { installed } from "#test/pg/reads/support.ts"
import {
	caseGen,
	clubs,
	type Feature,
	placements,
	programs,
	sameMember,
	Strata
} from "#test/pg/write/strata-families/strata-families.fixtures.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Family edits and a nested insert in two strata, on PostgreSQL 19rc2 take effect once each, in their own stratum, whichever comes first.
 *
 * Its pre-conversion budget: runs 32, coverage cases 48 (test/pg/write/strata-families/strata-families.test.ts at d8eed1786).
 */
export const familyEditsAndANestedInsertInTwoStrataOnPostgreSQL19rc2TakeEffectOnceEachInTheirOwnStratumWhicheverComesFirst =
	property.explore(caseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			...placements,
			"a stored member deleted",
			"a member inserted",
			"a deletion and an insertion in one edit",
			"a club emptied",
			"a doc of no line"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, notes: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(Strata, {}, { label: "strata_families", programs })
						const group = installationGroup(namesOf(o.installed))
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})

							yield* replaceRows(s.admin, group, [])
							const seeded = yield* answered(
								db.workload.seed.once({
									params: {},
									facts: {
										insert: { Club: Arr.map(clubs, (id) => ({ id })), Member: c.stored }
									}
								})
							)
							assert.equal(seeded.kind, "accepted", "the clubs and their members are stored")
							const facts = {
								delete: { Member: c.deleted },
								insert: { Member: c.inserted, Doc: c.docs }
							}
							const outcome = yield* c.placement === "the edit first"
								? answered(db.workload.editFirst.once({ params: {}, facts: facts }))
								: c.placement === "the nested insert first"
									? answered(db.workload.nestedFirst.once({ params: {}, facts: facts }))
									: answered(db.workload.together.once({ params: {}, facts: facts }))
							const changes = c.deleted.length + c.inserted.length + c.docs.length
							assert.equal(
								outcome.kind,
								changes === 0 ? "unchanged" : "accepted",
								`${Formatter.format(c)}: the outcome`
							)
							const members = [
								...Arr.filter(c.stored, (m) => !Arr.some(c.deleted, (d) => sameMember(d, m))),
								...c.inserted
							]
							const memberRows = yield* rowsOf(db.workload.members.once({ params: {}, facts: {} }))
							const clubRows = yield* rowsOf(db.workload.clubs.once({ params: {}, facts: {} }))
							const docRows = yield* rowsOf(db.workload.docs.once({ params: {}, facts: {} }))
							const lineRows = yield* rowsOf(db.workload.lines.once({ params: {}, facts: {} }))
							unorderedEqual(
								Arr.map(memberRows, (row) => ({ m: row.m, club: row.club })),
								members
							)
							unorderedEqual(
								Arr.map(clubRows, (row) => ({ id: row.id, n: row.n })),
								Arr.map(clubs, (id) => ({
									id,
									n: BigInt(Arr.filter(members, (m) => m.club === id).length)
								}))
							)
							unorderedEqual(
								Arr.map(docRows, (row) => ({ id: row.id, lines: row.lines })),
								Arr.map(c.docs, (d) => ({ id: d.id, lines: BigInt(d.lines.length) }))
							)
							unorderedEqual(
								Arr.map(lineRows, (row) => ({
									id: row.id,
									doc: row.doc,
									at: row.at,
									qty: row.qty
								})),
								Arr.flatMap(c.docs, (d) =>
									Arr.map(d.lines, (line, at) => ({
										id: line.id,
										doc: d.id,
										at: BigInt(at),
										qty: line.qty
									}))
								)
							)
							notes.note(c.placement)
							if (c.deleted.length > 0) {
								notes.note("a stored member deleted")
							}
							if (c.inserted.length > 0) {
								notes.note("a member inserted")
							}
							if (c.deleted.length > 0 && c.inserted.length > 0) {
								notes.note("a deletion and an insertion in one edit")
							}
							if (
								Arr.some(
									clubs,
									(id) =>
										Arr.some(c.stored, (m) => m.club === id) &&
										!Arr.some(members, (m) => m.club === id)
								)
							) {
								notes.note("a club emptied")
							}
							if (Arr.some(c.docs, (d) => d.lines.length === 0)) {
								notes.note("a doc of no line")
							}
						}).pipe(Effect.scoped, withLayer(o.served.layer))
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the write restated: members less the deleted plus the inserted, each count its family's, each line at its nested place"
		},
		budget: { runs: 32, steered: 48 },
		kept: [],
		kills: []
	})
