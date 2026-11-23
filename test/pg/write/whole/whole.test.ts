import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Real, refused, runProgram, took } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { OpenError } from "#adapter/errors/execution.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	Asm,
	asmPlaces,
	Attr,
	attrFacts,
	attrs,
	books,
	wholeTemplate,
	type Feature,
	features,
	Inst,
	instPlaces,
	machine,
	minus,
	type Model,
	nestedNode,
	Node,
	nodes,
	notesOf,
	pages,
	type Params,
	partialOf,
	Place,
	placementRow,
	programGen,
	type Refusal,
	type RelationName,
	relationNames,
	relations,
	render,
	sameRows,
	sameShelf,
	sameTree,
	Shelf,
	storedAt,
	Tag,
	tags,
	Test,
	testPlacements,
	toks,
	type UnitKind,
	unitParts,
	untouchedComponents,
	untouchedUnit,
	weights,
	worldOf
} from "#test/pg/write/whole/whole.fixtures.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { applicationOf, member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Deleting a group whole and replacing it, on PostgreSQL 19 every ChangeSet stores the model's rows and answers its outcome, counts and refusals.
 */
export const deletingAGroupWholeAndReplacingItOnPostgreSQL19EveryChangeSetStoresTheModelsRowsAndAnswersItsOutcomeCountsAndRefusals =
	property.explore(programGen, {
		needs: { whole: Substrate.fresh(wholeTemplate) },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ whole }, c: Case<Feature>) =>
			(steps) =>
				Effect.flatMap(whole, ({ substrate: s, value: done }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const world = worldOf(done.schema)
							const names = namesOf(done)
							const lawNames = lawNamesOf(world)
							/** The laws of the trees' and the shelves' relations, which a unit differing at a stored key breaks. */
							const unitLaws: ReadonlyArray<LawId> = [
								lawNames.primaryKeyLaw({ name: "Node" }),
								lawNames.primaryKeyLaw({ name: "Attr" }),
								lawNames.primaryKeyLaw({ name: "Tok" }),
								lawNames.lawOf(nodes),
								lawNames.lawOf(attrs),
								lawNames.lawOf(weights),
								lawNames.lawOf(toks),
								lawNames.primaryKeyLaw({ name: "Shelf" }),
								lawNames.primaryKeyLaw({ name: "Book" }),
								lawNames.primaryKeyLaw({ name: "Tag" }),
								lawNames.lawOf(books),
								lawNames.lawOf(pages),
								lawNames.lawOf(tags)
							]
							/** The law of each family a crossing group belongs to: an assembly's placements, an instance's. */
							const crossingLaws = {
								asm: lawNames.lawOf(asmPlaces),
								inst: lawNames.lawOf(instPlaces)
							}
							const served = fullWorld(world, {})
							return yield* Effect.gen(function* () {
								const db = yield* openServedDb(done, served.server.roles.app, {})
								/** Every relation's stored rows equal the model's. */
								const storesExactly = (m: Model, what: string) =>
									Effect.gen(function* () {
										const expected = render(m)
										for (const name of relationNames) {
											const stored = yield* tableState(done, relations[name])
											unorderedEqual(stored, expected[name], `${name}'s rows after ${what}`)
										}
									})
								/**
								 * A unit's rows as PostgreSQL stores them, each by its tuple's place and the transaction that wrote it, in its
								 * relations' order: the same text after a write exactly where the write rewrote none of them.
								 */
								const versionsOf = (unit: UnitKind, key: bigint) =>
									Effect.gen(function* () {
										const texts: Array<string> = []
										for (const [r, field] of unitParts[unit]) {
											const rows = yield* s.admin.queryValues(
												`SELECT ctid::text || '@' || xmin::text FROM ${printObjectName(done.names.relation(r.name))} WHERE ${quoteIdent(done.names.column(r.name, field))} = ${String(key)} ORDER BY ctid`,
												[]
											)
											texts.push(
												`${r.name}: ${Arr.join(
													Arr.map(rows, (row) => String(row[0])),
													" "
												)}`
											)
										}
										return Arr.join(texts, "; ")
									})
								/** A ChangeSet loaded as the one member of a workload, or its refusal when it compiles. */
								const load = (changes: unknown) =>
									Effect.gen(function* () {
										const loaded = yield* Effect.result(db.load({ step: changes }))
										if (Result.isFailure(loaded)) {
											const refusal = loaded.failure
											if (refusal instanceof OpenError) {
												return yield* Effect.die(refusal)
											}
											const error = refusal.error
											if (!isCompileError(error)) {
												return yield* Effect.die(new Error(Formatter.format(error)))
											}
											return Result.fail(error.reason)
										}
										return Result.succeed(applicationOf(db.ctx, member(loaded.success, "step")))
									})

								const reals: Real<Model, Params, Refusal, never, Substrate> = {
									write: (w, before, after, verdict) =>
										Effect.orDie(
											Effect.gen(function* () {
												const label = `${Formatter.format(w)} over ${Formatter.format(before)}`
												let changes = ChangeSet.empty(world)
												const facts: Record<string, Record<string, Array<unknown>>> = {}
												const params: Record<string, bigint> = {}
												const add = (
													op: "delete" | "insert",
													target: (typeof relations)[RelationName],
													rows: ReadonlyArray<unknown>
												) => {
													const at = facts[op] ?? {}
													const known = at[target.name]
													if (known === undefined) {
														at[target.name] = [...rows]
														changes =
															op === "delete"
																? changes.delete(target, [])
																: changes.insert(target, [])
													} else {
														for (const row of rows) {
															known.push(row)
														}
													}
													facts[op] = at
												}
												for (const t of w.trees) {
													if (t.op.kind !== "insert") {
														if (w.by === "query") {
															const param = `doc${String(t.doc)}`
															params[param] = t.doc
															changes = changes.delete(
																Node,
																query(world).rule((r) => {
																	const { doc } = v(Node, "node")
																	return r
																		.match(Node, { doc, start: 0n })
																		.where(r.eq(doc, r.param(param, pg.bigint)))
																		.find({ doc })
																})
															)
															c.note("a unit deleted by a query")
														} else {
															add("delete", Node, [{ doc: t.doc }])
														}
													}
													if (t.op.kind !== "delete") {
														add("insert", Node, [{ doc: t.doc, ...nestedNode(t.op.value) }])
														add("insert", Attr, attrFacts(t.doc, t.op.value))
													}
												}
												for (const sh of w.shelves) {
													const stored = storedAt(before.shelves, sh.id)
													if (sh.op.kind !== "insert") {
														if (w.by === "query") {
															const param = `shelf${String(sh.id)}`
															params[param] = sh.id
															changes = changes.delete(
																Shelf,
																query(world).rule((r) => {
																	const { id, note } = v(Shelf, "shelf")
																	return r
																		.match(Shelf, { id, note })
																		.where(r.eq(id, r.param(param, pg.bigint)))
																		.find({ id, note })
																})
															)
															c.note("a unit deleted by a query")
														} else {
															add("delete", Shelf, [{ id: sh.id, note: stored?.note ?? 0n }])
														}
													}
													if (sh.op.kind !== "delete") {
														add("insert", Shelf, [
															{
																id: sh.id,
																note: sh.op.value.note,
																books: Arr.map(sh.op.value.books, (words) => ({ words }))
															}
														])
														add(
															"insert",
															Tag,
															Arr.map(sh.op.value.tags, (label) => ({ shelf: sh.id, label }))
														)
													}
												}
												const queried = new Set<RelationName>()
												for (const te of w.tests) {
													if (te.op.kind !== "insert") {
														if (w.by === "query") {
															const param = `test${String(te.t)}`
															params[param] = te.t
															changes = changes.delete(
																Test,
																query(world).rule((r) => {
																	const { t, note } = v(Test, "test")
																	return r
																		.match(Test, { t, note })
																		.where(r.eq(t, r.param(param, pg.bigint)))
																		.find({ t, note })
																})
															)
															queried.add("Test")
															c.note("a unit deleted by a query")
														} else {
															add("delete", Test, [
																{ t: te.t, note: storedAt(before.tests, te.t)?.note ?? 0n }
															])
														}
													}
													if (te.op.kind !== "delete") {
														add("insert", Test, [{ t: te.t, note: te.op.value.note }])
														add("insert", Inst, [{ t: te.t, ...nestedNode(te.op.value.root) }])
														const placed = Arr.map(testPlacements(te.t, te.op.value), placementRow)
														if (Arr.isReadonlyArrayNonEmpty(placed)) {
															add("insert", Place, placed)
														}
													}
												}
												for (const asm of w.asms) {
													if (asm.op.kind !== "insert") {
														if (w.by === "query") {
															const param = `asm${String(asm.a)}`
															params[param] = asm.a
															changes = changes.delete(
																Asm,
																query(world).rule((r) => {
																	const { a, note } = v(Asm, "asm")
																	return r
																		.match(Asm, { a, note })
																		.where(r.eq(a, r.param(param, pg.bigint)))
																		.find({ a, note })
																})
															)
															queried.add("Asm")
															c.note("a unit deleted by a query")
														} else {
															add("delete", Asm, [
																{ a: asm.a, note: storedAt(before.asms, asm.a) ?? 0n }
															])
														}
													}
													if (asm.op.kind !== "delete") {
														add("insert", Asm, [{ a: asm.a, note: asm.op.value }])
													}
												}
												if (
													Arr.some(w.tests, (x) => x.op.kind !== "insert") ||
													Arr.some(w.asms, (x) => x.op.kind !== "insert")
												) {
													for (const r of [Test, Asm]) {
														if (!queried.has(r.name) && facts["delete"]?.[r.name] === undefined) {
															add("delete", r, [])
														}
													}
												}
												/** The stored units the write adds again unchanged, each with its rows' versions before it. */
												const repeated = [
													...Arr.flatMap(w.trees, (t) => {
														const stored = storedAt(before.trees, t.doc)
														return t.op.kind !== "delete" &&
															stored !== undefined &&
															sameTree(stored, t.op.value)
															? [{ unit: "tree" as const, key: t.doc, feature: untouchedUnit }]
															: []
													}),
													...Arr.flatMap(w.shelves, (sh) => {
														const stored = storedAt(before.shelves, sh.id)
														return sh.op.kind !== "delete" &&
															stored !== undefined &&
															sameShelf(stored, sh.op.value)
															? [{ unit: "shelf" as const, key: sh.id, feature: untouchedUnit }]
															: []
													}),
													...Arr.flatMap(untouchedComponents(before, after, w), (component) => {
														const feature: Feature = Arr.some(component.tests, ([t, value]) =>
															Arr.isReadonlyArrayNonEmpty(testPlacements(t, value))
														)
															? "a crossing component replaced identically left untouched"
															: untouchedUnit
														return [
															...Arr.map(component.tests, ([t]) => ({
																unit: "test" as const,
																key: t,
																feature
															})),
															...Arr.map(component.asms, ([a]) => ({
																unit: "asm" as const,
																key: a,
																feature
															}))
														]
													})
												]
												const versions: Array<{
													readonly unit: UnitKind
													readonly key: bigint
													readonly feature: Feature
													readonly before: string
												}> = []
												for (const u of repeated) {
													const found = yield* versionsOf(u.unit, u.key)
													versions.push({ ...u, before: found })
												}
												const loaded = yield* load(changes)
												if (Result.isFailure(loaded)) {
													return assert.fail(
														`${label}: refused when it compiles, ${Formatter.format(loaded.failure)}`
													)
												}
												const outcome = yield* Effect.orDie(loaded.success({ params, facts }))
												const was = render(before)
												if (verdict.kind === "refused") {
													const partial = partialOf(before, w)
													const allowed = new Set<LawId>([
														...(verdict.refusal === "a differing unit at a stored key"
															? unitLaws
															: []),
														...(partial.asm.length > 0 ? [crossingLaws.asm] : []),
														...(partial.inst.length > 0 ? [crossingLaws.inst] : [])
													])
													assert.equal(
														outcome.kind,
														"invariant-rejected",
														`${label}: ${verdict.refusal}`
													)
													if (outcome.kind === "invariant-rejected") {
														const named = Arr.map(refusedEntries(outcome.refused), (law) =>
															names.reported(law)
														)
														const among = (law: LawId) => allowed.has(law)
														assert.ok(
															outcome.refused.kind === "every"
																? Arr.every(named, among)
																: Arr.some(named, among),
															`${label}: refused by ${Formatter.format(named)}, none of ${Formatter.format([...allowed])}`
														)
													}
													yield* storesExactly(before, `the refused ${label}`)
													if (verdict.refusal === "a crossing group left partial") {
														if (partial.inst.length === 0) {
															c.note("a crossing group left partial by a test's delete refused")
														}
														if (partial.asm.length === 0) {
															c.note(
																"a crossing group left partial by an assembly's delete refused"
															)
														}
													}
													return refused(verdict.refusal)
												}
												const next = render(after)
												const unchanged = Arr.every(relationNames, (n) => sameRows(was[n], next[n]))
												assert.equal(
													outcome.kind,
													unchanged ? "no-change" : "accepted",
													`${label}: the outcome, ${Formatter.format(outcome)}`
												)
												if (outcome.kind === "accepted") {
													for (const name of relationNames) {
														const counted_ = Option.getOrUndefined(
															Arr.findFirst(outcome.counts, (x) => x.relation === name)
														)
														const added = BigInt(minus(next[name], was[name]))
														const deleted = BigInt(minus(was[name], next[name]))
														assert.deepEqual(
															{
																added: counted_?.added ?? 0n,
																deleted: counted_?.deleted ?? 0n,
																put: counted_?.put ?? 0n
															},
															{ added, deleted, put: 0n },
															`${label}: ${name}'s counts, the difference of the two states`
														)
													}
												}
												yield* storesExactly(after, label)
												for (const u of versions) {
													const now = yield* versionsOf(u.unit, u.key)
													assert.equal(
														now,
														u.before,
														`${label}: the ${u.unit} at ${String(u.key)}, added again unchanged, is never written`
													)
													c.note(u.feature)
													if (w.by === "array" && (u.unit === "test" || u.unit === "asm")) {
														c.note(
															"a root named by an array replaced by its own fact, identically, left untouched"
														)
													}
												}
												notesOf(w, before, c.note)
												return took
											})
										),
									"partial group": (p) =>
										Effect.orDie(
											Effect.gen(function* () {
												const name = p.relation
												const loaded = yield* load(
													ChangeSet.empty(world).delete(relations[name], [p.fact])
												)
												assert.ok(
													Result.isFailure(loaded),
													`a delete of ${name} alone is refused when it compiles`
												)
												if (Result.isFailure(loaded)) {
													assert.equal(loaded.failure._tag, "UnstatedKey", `a delete of ${name}`)
													c.note("a sequence member named by a drawn key refused")
													return refused("a sequence member named by a drawn key")
												}
												return took
											})
										),
									"node by key": (p, before) =>
										Effect.orDie(
											Effect.gen(function* () {
												const loaded = yield* load(ChangeSet.empty(world).delete(Node, []))
												if (Result.isFailure(loaded)) {
													return assert.fail(
														`a delete of Node's trees is refused when it compiles: ${Formatter.format(loaded.failure)}`
													)
												}
												const applied = yield* Effect.result(
													loaded.success({
														params: {},
														facts: { delete: { Node: [{ doc: p.doc, start: p.start }] } }
													})
												)
												assert.ok(
													Result.isFailure(applied),
													"a node named by its key is refused before any SQL"
												)
												if (Result.isFailure(applied)) {
													assert.equal(
														applied.failure._tag,
														"EncodingFailure",
														"a node named by its key"
													)
												}
												yield* storesExactly(before, "a node named by its key")
												c.note("a tree's node named by its key refused")
												return refused("a tree's node named by its key")
											})
										),
									"crossing alone": (p) =>
										Effect.orDie(
											Effect.gen(function* () {
												const alone = ChangeSet.empty(world).delete(relations[p.relation], [])
												const loaded = yield* load(
													p.beside === "nothing" ? alone : alone.delete(relations[p.beside], [])
												)
												assert.ok(
													Result.isFailure(loaded),
													`a delete of ${p.relation} beside ${p.beside}, deleting no row of the other, is refused when it compiles`
												)
												if (Result.isFailure(loaded)) {
													assert.equal(
														loaded.failure._tag,
														"UnsupportedOperation",
														`a delete of ${p.relation} beside ${p.beside}`
													)
													c.note("a crossing delete without the other relation's refused")
													return refused("a crossing delete without the other relation's")
												}
												return took
											})
										)
								}
								yield* runProgram(machine, reals, steps)
							}).pipe(Effect.scoped)
						}).pipe(Effect.scoped),
						Substrate,
						s
					)
				),
		oracle: {
			kind: "specification",
			name: "a model of the relations as sets of units: the stored units less the deleted plus the inserted, each relation's rows rendered as the README draws them"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/whole/whole.test.ts#deletingAGroupWholeAndReplacingItOnPostgreSQL19EveryChangeSetStoresTheModelsRowsAndAnswersItsOutcomeCountsAndRefusals:-:0.0.0.0.0.1.2.0.0.2.0.1.1.1.0.0.0.0.0.0.0.0.2.0.0.0.0.0.2.0.0.0.0.0.2.0.0.0.0.0.2.0.2.0.0.0.2.0.0.1.1.0.0.0.2.0.1.0.1.0.0.0.0.0.0.2.0.1.0.0.0.0.0.0.3.0.0.2.0.2.0.0.1.0.0.0"
				),
				reason:
					"CO-PG's conversion to open relations: test 2's root placing assemblies 1 and 2, then one stratum replacing test 2 and both assemblies identically and inserting test 1 placing assembly 1. Assembly 1's group grows, so its stored placement (2, 0, 1) goes, and test 2's root instance kept the other, (2, 0, 2), at its slot: the insert again appended (2, 0, 1) after it and left slot 0 empty, refused by Place's counted predecessor key of fin(Inst, places) where the model accepts",
				since: "2026-11-23"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/delete/unit.ts",
				original: "\t\t\tfirstCounted !== undefined && secondCounted !== undefined\n",
				replacement: "\t\t\tfalse\n",
				why: "A member of two counted families keeps each family's groups by that family's own exclusions alone, so a group another family's exclusion leaves keeps its other members at their slots, and the insert again of the excluded member appends after them, leaving its slot empty: the kept case is refused by the instance's counted predecessor key where it is accepted."
			},
			{
				file: "packages/engine/src/runtime/write/normalize.ts",
				original: '\t\t\treturn act.names === "units" ? "units" : "delete"',
				replacement: '\t\t\treturn "delete"',
				why: "A unit delete's facts join the deletions of rows, so normalization nets a unit's root the stratum inserts again out of them (D EXCEPT A): the unit statement is bound with no unit, nothing nested under the root is removed, and the replace meets the stored instance at its key, refused where it is accepted (9149ad6a9, which this property's crossing writes found at TEST_SEED=4248619513)."
			}
		]
	})
