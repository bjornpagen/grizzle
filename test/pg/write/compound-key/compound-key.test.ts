import { assert, deepEquals, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import { onceCalls, type WrittenOutcome } from "#adapter/db/handles.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { workload } from "#compiler/public/workload.ts"
import { btreeMaxItemSize } from "#compiler/schema/representability.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { rowOf } from "#test/pg/page/support.ts"
import {
	agreeAt,
	arityOf,
	at,
	type Broken,
	built,
	type CallFacts,
	childFact,
	childField,
	type ChildRow,
	foreignKeys,
	imaged,
	imagedPastLimit,
	judgeRefused,
	keyCases,
	type KeyField,
	keyOf,
	layoutBytes,
	opLabels,
	parentFact,
	type ParentRow,
	refusesWidest,
	type Situation,
	situations,
	textsInOrder,
	uniqueIndexes,
	valueAt,
	verdictOf,
	widest,
	type Write
} from "#test/pg/write/compound-key/compound-key.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { answered, readOnce, type WriteAnswer, writeOnce } from "#test/support/calls.ts"
import { paramsOver } from "#test/support/compile.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { plannedIndexes, recordingMembers, sentProblems, unanalyzed } from "#test/support/plans.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Compound text keys are installed in their declared order or refused as UnrepresentableKey exactly where PostgreSQL refuses their widest entry, and their writes and reads keep the set rule through the keys' indexes.
 *
 * Its pre-conversion budget: runs 16, coverage cases 64 (test/pg/write/compound-key/compound-key.test.ts at d8eed1786).
 */
export const compoundTextKeysAreInstalledInTheirDeclaredOrderOrRefusedAsUnrepresentableKeyExactlyWherePostgreSQLRefusesTheirWidestEntryAndTheirWritesAndReadsKeepTheSetRuleThroughTheKeysIndexes =
	property.explore(steered(keyCases), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			(k) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = k.shape
						const b = built(s)
						const widestRow = widest(s, k.salt)
						const declared = b.rename("Keyed")
						const field = (f: string) => defined(b.Parent.fields[f], "a Parent field")
						/**
						 * The case's members over `over`, the declared schema or the installed one, which a level's content
						 * makes one: its writes, and its reads by the key, the declared key and the child's id.
						 */
						const programsOver = (over: typeof declared) => ({
							insert: ChangeSet.empty(over).insert(b.Parent, []).insert(b.Child, []),
							put: ChangeSet.empty(over).put(b.Parent, []),
							delete: ChangeSet.empty(over).delete(b.Parent, []),
							byKey: query(over).rule((r) => {
								const p = v(b.Parent, "p")
								const bound = Rec.fromEntries(
									Arr.map(Rec.keys(b.Parent.fields), (f) =>
										Arr.some(s.key, (x) => x === f)
											? ([f, r.param(`k_${f}`, field(f))] as const)
											: ([f, defined(p[f], "a variable")] as const)
									)
								)
								return r.match(b.Parent, bound).find(bound)
							}),
							byUnique: query(over).rule((r) => {
								const p = v(b.Parent, "p")
								const bound = Rec.fromEntries(
									Arr.map(Rec.keys(b.Parent.fields), (f) =>
										Arr.some(s.unique, (x) => x === f)
											? ([f, r.param(`u_${f}`, field(f))] as const)
											: ([f, defined(p[f], "a variable")] as const)
									)
								)
								return r.match(b.Parent, bound).find(bound)
							}),
							childParent: query(over).rule((r) => {
								const ch = v(b.Child, "c")
								const p = v(b.Parent, "p")
								const joined = Rec.fromEntries(
									Arr.map(Rec.keys(b.Parent.fields), (f) => {
										const keyed = Arr.findFirst(s.key, (x) => x === f)
										return [
											f,
											Option.isSome(keyed)
												? defined(ch[childField(keyed.value)], "a child variable")
												: defined(p[f], "a parent variable")
										] as const
									})
								)
								return r
									.match(b.Child, ch)
									.match(b.Parent, joined)
									.where(r.eq(defined(ch["id"], "the child id"), r.param("id", pg.integer)))
									.find(joined)
							})
						})
						const declaredWorld = fullWorld(declared, {})
						const installedOrNot = yield* Effect.result(
							installMigrated(declared, {
								ambient: ordinarySession,
								label: "keyed",
								logins: [declaredWorld.server],
								extensions: [
									paramsOver([
										{
											login: "server",
											workloads: [workload(declaredWorld.app, programsOver(declared))]
										}
									])
								]
							})
						)
						if (Result.isFailure(installedOrNot)) {
							const e = installedOrNot.failure
							if (!isCompileError(e) || e.reason._tag !== "UnrepresentableKey") {
								return assert.fail(
									`a schema whose keys are refused is refused as UnrepresentableKey, not ${Formatter.format(e)}`
								)
							}
							const reason = e.reason
							const fault = reason.fault
							if (fault.kind !== "btreeEntry") {
								return assert.fail(
									`a byte-bounded key is refused by its entry's bytes, not ${Formatter.format(fault)}`
								)
							}
							assert.ok(
								fault.bytes > fault.limit && fault.limit === btreeMaxItemSize,
								`the refusal counts the entry past BTMaxItemSize: ${Formatter.format(fault)}`
							)
							assert.ok(
								deepEquals<ReadonlyArray<string>>(reason.key, s.key) ||
									deepEquals<ReadonlyArray<string>>(reason.key, s.unique),
								`the refusal names a key of Parent in its declared order, not ${Formatter.format(reason.key)}`
							)
							const refused = yield* refusesWidest(s, reason.key, widestRow)
							c.note("a key refused past the item limit")
							c.note(
								refused
									? "a refused key whose widest entry PostgreSQL refuses too"
									: "a refused key whose widest entry PostgreSQL holds"
							)
							return
						}
						const done = installedOrNot.success
						for (const fields of [s.key, s.unique]) {
							const refused = yield* refusesWidest(s, fields, widestRow)
							assert.ok(
								!refused,
								`grizzle installs ${Formatter.format(fields)}, whose widest entry PostgreSQL refuses`
							)
						}
						if (Option.exists(layoutBytes(s, s.key), (bytes) => bytes > btreeMaxItemSize - 8)) {
							c.note("a key at the item limit accepted")
						}
						if (imagedPastLimit(s, s.key) || imagedPastLimit(s, s.unique)) {
							c.note("a key past the item limit held by its texts' images")
						}
						const names = namesOf(done)
						const parentTable = done.names.relation(b.Parent.name)
						const childTable = done.names.relation(b.Child.name)
						const column = (r: string, f: string) => done.names.column(r, f)
						/** The column a key or a reference holds a field of a relation by: its own, or, for a text of no
						 * bound, the column of its image the naming door names. */
						const keyColumn = (
							r: string,
							key: ReadonlyArray<string>,
							f: string,
							of: string
						): string =>
							imaged(s, key, of)
								? identifierOf(
										identity.lawColumn({
											kind: "image",
											image: "textDigest",
											of: { kind: "field", field: f }
										})
									)
								: column(r, f)
						if (
							Arr.some(s.key, (f) => imaged(s, s.key, f)) ||
							Arr.some(s.unique, (f) => imaged(s, s.unique, f))
						) {
							c.note("a key over a text of no bound, held by its image")
						}
						const indexes = yield* uniqueIndexes(parentTable.schema, parentTable.name)
						assert.ok(
							Arr.some(
								indexes,
								(i) =>
									i.primary &&
									deepEquals(
										i.columns,
										Arr.map(s.key, (f) => keyColumn(b.Parent.name, s.key, f, f))
									)
							),
							`Parent's primary key is planned over ${Formatter.format(s.key)} in that order: ${Formatter.format(indexes)}`
						)
						assert.ok(
							Arr.some(indexes, (i) =>
								deepEquals(
									i.columns,
									Arr.map(s.unique, (f) => keyColumn(b.Parent.name, s.unique, f, f))
								)
							),
							`Parent's declared key is planned over ${Formatter.format(s.unique)} in that order: ${Formatter.format(indexes)}`
						)
						const fks = yield* foreignKeys(parentTable.schema, childTable.name, parentTable.name)
						assert.ok(
							Arr.some(fks, (pairs) =>
								deepEquals(
									pairs,
									Arr.map(
										s.target,
										(f) =>
											[
												keyColumn(b.Child.name, s.target, childField(f), f),
												keyColumn(b.Parent.name, s.target, f, f)
											] as const
									)
								)
							),
							`the containment is one foreign key pairing ${Formatter.format(s.target)} in that order: ${Formatter.format(fks)}`
						)
						const value = b.rename(done.schema)
						const world = fullWorld(value, {})
						const lawNames = lawNamesOf(value)
						const lawOf: { readonly [B in Broken]: LawId } = {
							"the primary key": lawNames.primaryKeyLaw({ name: b.Parent.name }),
							"the declared key": lawNames.lawOf(b.declaredKey),
							"the child key": lawNames.primaryKeyLaw({ name: b.Child.name }),
							"the containment": lawNames.lawOf(b.containment)
						}
						const programs = programsOver(value)
						yield* Effect.gen(function* () {
							const db = yield* openServedDb(done, world.server.roles.app, {})
							const loaded = yield* db.load(programs)
							const applied = (name: Write["op"], facts: CallFacts) =>
								answered(writeOnce(onceCalls(db.ctx, member(loaded, name)))({ params: {}, facts }))
							let parents: ReadonlyArray<ParentRow> = []
							let children: ReadonlyArray<ChildRow> = []
							for (const [i, w] of k.writes.entries()) {
								const label = `write ${String(i)} (${w.op}) over ${Formatter.format(s)}`
								const verdict = verdictOf(s, parents, children, w)
								const facts: CallFacts =
									w.op === "insert"
										? {
												insert: {
													Parent: Arr.map(w.parents, parentFact),
													Child: Arr.map(w.children, (x) => childFact(s, x))
												}
											}
										: { [w.op]: { Parent: Arr.map(w.parents, parentFact) } }
								const outcome: WriteAnswer<WrittenOutcome> = yield* applied(w.op, facts)
								if (verdict.kind === "refused") {
									judgeRefused(label, outcome, verdict, lawOf, names.reported, s)
									for (const broken of verdict.broken) {
										if (broken !== "the child key") {
											c.note(`${opLabels[w.op]} refused on ${broken}`)
										}
									}
								} else {
									assert.equal(outcome.kind, verdict.changed ? "accepted" : "unchanged", label)
									if (outcome.kind === "accepted" && w.op === "insert") {
										for (const [r, n] of Rec.toEntries(verdict.added)) {
											const counted = Arr.findFirst(outcome.counts, (x) => x.relation === r)
											assert.equal(
												Option.getOrUndefined(counted)?.added ?? 0n,
												BigInt(n),
												`${label}: ${r}'s added rows`
											)
										}
									}
									if (i === 0 && Arr.some(verdict.parents, (p) => deepEquals(p, widestRow))) {
										c.note("a write of the widest values accepted")
										if (Arr.some(s.key, (f) => imaged(s, s.key, f))) {
											c.note("a write of a text past the item limit at a key accepted")
										}
									}
									if (
										w.op === "delete" &&
										Arr.some(verdict.parents, (p) =>
											Arr.some(w.parents, (x) => agreeAt(p, x, s.key) && !deepEquals(p, x))
										)
									) {
										c.note("a delete of a row unlike the stored one at its key, which keeps it")
									}
									if (
										w.op === "delete" &&
										Arr.some(w.parents, (x) =>
											Arr.some(w.parents, (y) => agreeAt(x, y, s.key) && !deepEquals(x, y))
										)
									) {
										c.note("a delete of two rows at one key, which is no refusal")
									}
									parents = verdict.parents
									children = verdict.children
								}
								const storedParents = yield* tableState(done, b.Parent)
								unorderedEqual(
									storedParents,
									Arr.map(parents, parentFact),
									`Parent's rows after ${label}`
								)
								const storedChildren = yield* tableState(done, b.Child)
								unorderedEqual(
									storedChildren,
									Arr.map(children, (x) => childFact(s, x)),
									`Child's rows after ${label}`
								)
							}
							const sub = yield* Substrate
							yield* unanalyzed(sub.admin, [parentTable, childTable])
							const planned = plannedIndexes(done.installation)
							const { calls, counts } = recordingMembers(db.ctx)
							const read = (name: string, params: ParamMap) =>
								Effect.gen(function* () {
									const before = counts.sent.length
									const collected = yield* readOnce(calls(member(loaded, name)))({
										params,
										facts: {}
									})
									const rows = Arr.map(collected, (row) => ({ ...rowOf(row) }))
									const problems = yield* sentProblems(
										sub.admin,
										name,
										counts.sent.slice(before),
										planned
									)
									assert.deepEqual(problems, [], `${name} reads through the keys' indexes`)
									return rows
								})
							for (const p of [...parents, widestRow]) {
								const got = yield* read(
									"byKey",
									Rec.fromEntries(Arr.map(s.key, (f) => [`k_${f}`, valueAt(p, f)] as const))
								)
								unorderedEqual(
									got,
									Arr.map(
										Arr.filter(parents, (q) => agreeAt(q, p, s.key)),
										parentFact
									),
									`the Parent at ${Formatter.format(at(p, s.key))}`
								)
								const byUnique = yield* read(
									"byUnique",
									Rec.fromEntries(Arr.map(s.unique, (f) => [`u_${f}`, valueAt(p, f)] as const))
								)
								unorderedEqual(
									byUnique,
									Arr.map(
										Arr.filter(parents, (q) => agreeAt(q, p, s.unique)),
										parentFact
									),
									`the Parent at the declared key ${Formatter.format(at(p, s.unique))}`
								)
							}
							for (const ch of children) {
								const got = yield* read("childParent", { id: ch.id })
								unorderedEqual(
									got,
									Arr.map(
										Arr.filter(parents, (q) => deepEquals(keyOf(s, q), ch.names)),
										parentFact
									),
									`the Parent of Child ${String(ch.id)}`
								)
							}
							c.note(
								`a primary key of ${arityOf(s.key)} fields, its texts ${textsInOrder(s.key) ? "in" : "out of"} their declared order`
							)
							if (!deepEquals<ReadonlyArray<KeyField>>(s.target, s.key)) {
								c.note("a containment out of the key's order")
							}
						}).pipe(Effect.scoped)
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's B-tree item limit (54000) and its catalog and plans, beside the set model of each write"
		},
		budget: { runs: 16, steered: 64 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/representability.ts",
				original:
					"\t\t!fits && c.text && (c.datum === undefined || c.datum.bytes > keyImageDatum.textDigest.bytes)",
				replacement:
					"\t\tfalse && c.text && (c.datum === undefined || c.datum.bytes > keyImageDatum.textDigest.bytes)",
				why: "A key over a text of no bound refused again, unboundedText, where its image keys it."
			},
			{
				file: "packages/engine/src/write/insert/protocol.ts",
				original: "columns: arbiterColumns(w, relation.name, relation.uniques.arbiter),",
				replacement: "columns: mapNonEmpty(pk, column),",
				why: "An insert names its arbiter by the key's fields, which no unique index holds where a text of no bound stands by its image (42P10)."
			}
		]
	})
