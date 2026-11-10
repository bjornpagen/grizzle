import { Array as Arr, Effect } from "effect"
import { summarize } from "#bench/cold/stats.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { settle } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	installWrites,
	loadedByOwner,
	observedChange,
	openFull,
	scanDelta,
	type TableScans,
	tableScans,
	timed,
	transactionScans,
	writePhases
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { counted, fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"

/**
 * families (W5.BF): what a family's writes cost, by the family's length (fin.md §4.5, §5.3).
 *
 * The gate's text is the families entry of bench/harness/rules.ts. The mechanisms measured, each by what PostgreSQL
 * counts in the write's own transaction (pg_stat_xact_user_tables), read on the session that applies it just before its
 * COMMIT: the rows it changed, then the scans its deferred foreign key checks make when SET CONSTRAINTS ALL IMMEDIATE
 * fires them there, one each:
 * - a fresh family is written with its owner: its owner's one row and its members' rows inserted, and no row of either
 *   updated, since an owner its stratum inserts carries its count in its own insert (runtime/write/bind.ts freshOwners).
 *   The family is a sequence, written nested under its owner;
 * - an append of k members to a stored family of n: its k members inserted and its owner's row updated once, by the one
 *   recount of its stratum's family additions statement (write/family/additions.ts), whose new count the owner axis's
 *   ON UPDATE CASCADE writes into the copy ‹n› of each of the n stored members, so the append updates n member rows,
 *   O(n); and its deferred checks, each appended member's predecessor key and its owner's last-slot key, k + 1 scans of
 *   the member table, O(k). The family is counted, the kind whose members a write appends to a stored owner; a sequence
 *   is written whole with its owner.
 *
 * Each write is made twice at each length, on twin owners: counted, read by a probe that holds its COMMIT back and fires
 * its deferred checks early; and timed, committing in the write's one flight as the served program sends it. Each goes
 * through a Db of its own, whose sessions change no row before the write, so its rows read are its own or more
 * (transactionScans), and every count is checked exactly. Every figure is recorded beside its check; times are
 * recorded and gate nothing.
 */
const Owner = relation("Owner", { id: pg.integer, members: drawn(natural) }, ["id"])
const Item = relation("Item", { owner: pg.integer, at: drawn(natural), payload: pg.integer }, [
	"owner",
	"at"
])
const Group = relation("Group", { id: pg.integer, size: drawn(natural) }, ["id"])
const Tag = relation("Tag", { id: pg.integer, grp: pg.integer, payload: pg.integer }, ["id"])

const build = (name: string) =>
	schema(name, { Owner, Item, Group, Tag }, [
		ordered(on(Item, "owner", "at"), fin(Owner, "members")),
		counted(on(Tag, "grp"), fin(Group, "size")),
		mutable(Owner),
		mutable(Item),
		mutable(Group),
		mutable(Tag)
	])

interface Options extends Readonly<Record<string, unknown>> {
	/** The lengths of the families written, two owners of each kind each. */
	readonly lengths: ReadonlyArray<number>
}

/** The ChangeSet inserting owner `id` with a sequence of `length` members, nested at its count field. */
const freshFamily = (s: ReturnType<typeof build>, id: number, length: number) =>
	ChangeSet.empty(s).insert(Owner, [
		{ id, members: Arr.map(indices(length), (k) => ({ payload: k })) }
	])

/** A group and the ids of its counted members. */
interface GroupTags {
	readonly id: number
	readonly tags: ReadonlyArray<number>
}

/** The ChangeSet inserting each group of `groups` with its counted members. */
const storedGroups = (s: ReturnType<typeof build>, groups: ReadonlyArray<GroupTags>) =>
	ChangeSet.empty(s)
		.insert(
			Group,
			Arr.map(groups, (g) => ({ id: g.id }))
		)
		.insert(
			Tag,
			Arr.flatMap(groups, (g) => Arr.map(g.tags, (t) => ({ id: t, grp: g.id, payload: t })))
		)

/** The ChangeSet appending the members `tags` to the stored group `id`. */
const append = (s: ReturnType<typeof build>, group: GroupTags) =>
	ChangeSet.empty(s).insert(
		Tag,
		Arr.map(group.tags, (t) => ({ id: t, grp: group.id, payload: t }))
	)

/** A table as a counted write left it: the rows it inserted and updated, and the scans its deferred checks made. */
interface TableWrite {
	readonly inserted: number
	readonly updated: number
	readonly deferredChecks: number
}

/**
 * A counted write: read, its owner and member tables as it left them; or unread, where a statement before its COMMIT
 * failed, so no probe ran.
 */
type Counted =
	| {
			readonly kind: "read"
			readonly applied: string
			readonly owner: TableWrite
			readonly member: TableWrite
	  }
	| { readonly kind: "unread"; readonly applied: string }

/** A timed write: its outcome and the milliseconds its apply took. */
interface Timed {
	readonly applied: string
	readonly ms: number
}

/** One length's write of one kind, made on twin owners: counted and timed. */
interface Measured {
	readonly length: number
	readonly counted: Counted
	readonly timed: Timed
}

/** The relations a write's family has: its owner's and its members'. */
interface FamilyTables {
	readonly owner: string
	readonly member: string
}

export default defineGate({
	name: "write-families",
	gates: ["families"],
	title:
		"A family's writes: a fresh family updates no row; an append updates its owner once and ‹n› on every stored sibling, and defers a check per member",
	scope:
		"two owners per length with a sequence of that length written through a Db; two groups per length with a counted " +
		"family of that length, then an append of as many members again to each, through a Db; one of each pair counted " +
		"before its COMMIT, the other timed.",
	phases: writePhases,
	options: {
		full: { lengths: [10, 1000, 100000] },
		quick: { lengths: [10, 200] }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installWrites(build("Families"), "benchfamilies", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared)
			/** A table as a write's reading left it, from its counts after its statements and after its deferred checks. */
			const tableWrite = (
				written: Readonly<Record<string, TableScans>>,
				checked: Readonly<Record<string, TableScans>>,
				relation: string
			): TableWrite => {
				const table = fx.relationName(relation)
				const rows = tableScans(written, table)
				const checks = tableScans(scanDelta(written, checked), table)
				return {
					inserted: rows.inserted,
					updated: rows.updated,
					deferredChecks: checks.seq + checks.idx
				}
			}
			/** A write through a Db of its own, read on its session just before its COMMIT (see the head of the file). */
			const countedWrite = (change: unknown, tables: FamilyTables) =>
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* openFull(fx, S)
						const readings: Array<{ readonly owner: TableWrite; readonly member: TableWrite }> = []
						const observed = yield* observedChange(db, change, attemptLabel, {
							kind: "probe",
							run: (session) =>
								Effect.gen(function* () {
									const written = yield* transactionScans(session.rows, fx.installed.schema)
									yield* session.rows("SET CONSTRAINTS ALL IMMEDIATE", [])
									const checked = yield* transactionScans(session.rows, fx.installed.schema)
									readings.push({
										owner: tableWrite(written, checked, tables.owner),
										member: tableWrite(written, checked, tables.member)
									})
								})
						})
						const applied = (yield* observed.apply({})).value.kind
						const [reading] = readings
						return reading === undefined
							? ({ kind: "unread", applied } satisfies Counted)
							: ({ kind: "read", applied, ...reading } satisfies Counted)
					})
				)
			/** A write through a Db of its own, committed in its one flight, timed. */
			const timedWrite = (change: unknown) =>
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* openFull(fx, S)
						const observed = yield* observedChange(db, change, attemptLabel, { kind: "none" })
						const applied = yield* timed(observed.apply({}))
						return { applied: applied.value.value.kind, ms: applied.ms } satisfies Timed
					})
				)
			/**
			 * Each length's twin owners, counted and timed, each with its two blocks of member ids, consecutive and disjoint
			 * across the run: its group's stored members, and the members appended to it.
			 */
			const plan = Arr.map(options.lengths, (length, i) => {
				const first = 1 + 4 * Arr.reduce(Arr.take(options.lengths, i), 0, (sum, n) => sum + n)
				const block = (b: number) => Arr.map(indices(length), (k) => first + b * length + k)
				return {
					length,
					counted: { id: 2 * i + 1, stored: block(0), appended: block(2) },
					timed: { id: 2 * i + 2, stored: block(1), appended: block(3) }
				}
			})
			const fresh: Array<Measured> = []
			for (const p of plan) {
				fresh.push({
					length: p.length,
					counted: yield* countedWrite(freshFamily(S, p.counted.id, p.length), {
						owner: "Owner",
						member: "Item"
					}),
					timed: yield* timedWrite(freshFamily(S, p.timed.id, p.length))
				})
			}
			const stored = yield* Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFull(fx, S)
					const groups = Arr.flatMap(plan, (p) => [
						{ id: p.counted.id, tags: p.counted.stored },
						{ id: p.timed.id, tags: p.timed.stored }
					])
					const observed = yield* observedChange(db, storedGroups(S, groups), attemptLabel, {
						kind: "none"
					})
					return (yield* observed.apply({})).value.kind
				})
			)
			yield* settle(fx)
			const appended: Array<Measured> = []
			for (const p of plan) {
				appended.push({
					length: p.length,
					counted: yield* countedWrite(append(S, { id: p.counted.id, tags: p.counted.appended }), {
						owner: "Group",
						member: "Tag"
					}),
					timed: yield* timedWrite(append(S, { id: p.timed.id, tags: p.timed.appended }))
				})
			}
			/** A counted write's tables as measures: none where its probe read none. */
			const countedMeasures = (c: Counted): Readonly<Record<string, number>> =>
				c.kind === "unread"
					? {}
					: {
							ownerInserted: c.owner.inserted,
							ownerUpdated: c.owner.updated,
							ownerDeferredChecks: c.owner.deferredChecks,
							memberInserted: c.member.inserted,
							memberUpdated: c.member.updated,
							memberDeferredChecks: c.member.deferredChecks
						}
			const caseOf = (
				m: Measured,
				name: string,
				workload: string,
				parameters: Readonly<Record<string, number>>
			): CaseRecord<"families"> => ({
				name,
				gates: ["families"],
				conditions: {
					workload,
					schemaState: loadedByOwner,
					dataDistribution: `${2 * options.lengths.length} owners and ${2 * options.lengths.length} groups, one family each`,
					parameters,
					resultSemantics: "every write is lawful and commits",
					cacheState: "a fresh Db per write"
				},
				phases: { operationMs: summarize([m.timed.ms]) },
				variants: [],
				comparisons: [],
				transactions: {},
				loads: {},
				measures: countedMeasures(m.counted)
			})
			const cases: Array<CaseRecord<"families">> = [
				...Arr.map(fresh, (m) =>
					caseOf(
						m,
						`a sequence of ${m.length} members`,
						`one owner with ${m.length} nested members written through a Db`,
						{ length: m.length }
					)
				),
				...Arr.map(appended, (m) =>
					caseOf(
						m,
						`an append of ${m.length} members to a stored counted family of ${m.length}`,
						`${m.length} members appended to a stored group's counted family of ${m.length}, written through a Db`,
						{ length: m.length, appended: m.length }
					)
				)
			]
			/** A table's counts as text, for a check's evidence. */
			const tableText = (t: TableWrite): string =>
				`${t.inserted} inserted, ${t.updated} updated, ${t.deferredChecks} deferred checks`
			const evidence = (ms: ReadonlyArray<Measured>): string =>
				Arr.join(
					Arr.map(ms, (m) =>
						m.counted.kind === "unread"
							? `${m.length}: unread (${m.counted.applied})`
							: `${m.length}: owner ${tableText(m.counted.owner)}; members ${tableText(m.counted.member)}`
					),
					", "
				)
			const families: VerdictInput = {
				checks: [
					mechanism(
						"a fresh family is its owner's one inserted row and its members' rows, with no row of either updated",
						Arr.every(
							fresh,
							(m) =>
								m.length > 0 &&
								m.counted.kind === "read" &&
								m.counted.owner.inserted === 1 &&
								m.counted.owner.updated === 0 &&
								m.counted.member.inserted === m.length &&
								m.counted.member.updated === 0
						),
						evidence(fresh)
					),
					mechanism(
						"an append of k members to a stored family of n updates its owner's row once and ‹n› on its n stored members",
						Arr.every(
							appended,
							(m) =>
								m.length > 0 &&
								m.counted.kind === "read" &&
								m.counted.owner.inserted === 0 &&
								m.counted.owner.updated === 1 &&
								m.counted.member.inserted === m.length &&
								m.counted.member.updated === m.length
						),
						evidence(appended)
					),
					mechanism(
						"an append of k members defers k + 1 checks: each member's predecessor key and its owner's last-slot key",
						Arr.every(
							appended,
							(m) =>
								m.counted.kind === "read" &&
								m.counted.owner.deferredChecks === 0 &&
								m.counted.member.deferredChecks === m.length + 1
						),
						evidence(appended)
					),
					equivalence(
						"every write was accepted",
						stored === "accepted" &&
							Arr.every(
								[...fresh, ...appended],
								(m) => m.counted.applied === "accepted" && m.timed.applied === "accepted"
							),
						`stored groups ${stored}; ${Arr.join(
							Arr.map([...fresh, ...appended], (m) => `${m.counted.applied}/${m.timed.applied}`),
							", "
						)}`
					)
				]
			}
			return { cases, verdicts: { families } }
		})
})
