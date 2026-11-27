/**
 * A fresh group of a counted family, its owner inserted by the call and none of its members stored, is drawn whole by
 * the host (runtime/write/bind.ts freshOwners) and its members inserted as drawn, where the family's scan (write/family/
 * scan.ts scanOf, run by PostgreSQL inside the additions statement) draws every group holding a stored member
 * (write/family/additions.ts FreshGroups): one rule (ir/fill.ts FillColumn), two engines over disjoint groups. The
 * property holds them to one another on the cluster.
 *
 * Each case draws a schema of two to four mutable relations with one to three counted families, each owner declared
 * before its member, half the time an ordered family nesting a counted member under another relation, and up to two
 * copies along their owner axes, each admitted by the reference (fill.ts admittedSources), and an instance of it
 * (fill.ts instanceGen), its rows written in a drawn order. It installs the
 * schema twice through its first migration:
 *
 * - **Fresh:** one ChangeSet inserts the whole instance, every group fresh, so the host draws every counted member.
 * - **Scanned:** one ChangeSet per depth inserts the instance, the relations no counted family has as a member first,
 *   then each member's relation after every one of its owners', so each group is appended under a stored owner and the
 *   family's scan draws it, from slot 0, the owner recounted.
 *
 * - **The differential:** each table's rows, every column, its hidden ‹i›, ‹n› and fold planes among them, as
 *   PostgreSQL stores them, are the same in both installations.
 * - **An exact repeat beside an append:** a ChangeSet that inserts the instance again, exactly, and appends one new
 *   member to a stored owner's group: the group holds stored members, so the scan draws it, as it did before the host
 *   drew fresh groups, past the stored members, the owner recounted; it is accepted in both installations, adds the
 *   member and leaves them the same. In a third installation of the schema, every relation immutable, so every group
 *   is drawn from its base, the same ChangeSet is refused by a counted family's count axis, the member's copy of the
 *   count past its stored owner's, beside the copies that axis's foreign key carries: the laws the scan from slot 0
 *   named before the host drew fresh groups.
 *
 * Oracle: PostgreSQL itself, which runs the family's scan over the stored groups and proves every native over both
 * installations' rows.
 *
 * Features: each of `features`, noted where the case reaches it.
 */
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	appendedBeside,
	type Feature,
	features,
	type FreshCase,
	freshCaseGen,
	outOfKeyOrder,
	storedRows,
	writesByDepth
} from "#test/pg/write/fresh-groups/fresh-groups.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import {
	buildFill,
	type InstanceRow,
	insertedRelations,
	instanceFacts,
	relationName
} from "#test/support/families/fill.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** A call's facts: under each op of a change member's array members, the rows of each, under its relation's name. */
type CallFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

/** The situations a case's schema and instance reach. */
const reached = ({ spec, rows }: FreshCase): ReadonlyArray<Feature> => {
	const members = (f: number, owner: number) =>
		Arr.filter(rows, (row) => Arr.some(row.memberOf, (m) => m.family === f && m.owner === owner))
	return [
		...(Arr.some(spec.families, (_, f) => Arr.some(rows, (row) => members(f, row.id).length > 1))
			? (["a fresh group of several members"] as const)
			: []),
		...(Arr.some(
			spec.relations,
			(_, r) => Arr.filter(spec.families, (f) => f.member === r).length > 1
		)
			? (["a member of two counted families"] as const)
			: []),
		...(Arr.some(spec.families, (f) => Arr.some(spec.families, (g) => g.owner === f.member))
			? (["a counted member that owns a counted family"] as const)
			: []),
		...(Arr.isReadonlyArrayNonEmpty(spec.copies)
			? (["an owner copy along a counted family"] as const)
			: []),
		...(Arr.some(spec.families, (f) => f.fold !== "none")
			? (["a fold over a counted family"] as const)
			: []),
		...(Arr.some(spec.families, (f) => f.kind === "counted" && outOfKeyOrder(rows, f.member))
			? (["members written out of their key order"] as const)
			: []),
		...(Arr.some(
			spec.families,
			(f) =>
				f.kind !== "counted" &&
				Arr.some(spec.families, (g) => g.kind === "counted" && g.member === f.member) &&
				Arr.some(rows, (row) => row.relation === f.member)
		)
			? (["a counted member nested in a sequence"] as const)
			: [])
	]
}

/** An installation of a case's schema, its served Db over the app role, and the case's programs loaded there. */
const installed = (k: FreshCase, label: string, byDepth: boolean) =>
	Effect.gen(function* () {
		const built = buildFill(k.spec)
		const declared = built.rename("Fresh")
		const done = yield* installFullWorld(declared, {}, { ambient: ordinarySession, label })
		const value = built.rename(done.schema)
		const world = fullWorld(value, {})
		const relationAt = (r: number) => defined(built.relations[relationName(r)])
		const inserting = (relations: ReadonlyArray<number>) =>
			Arr.reduce(relations, ChangeSet.empty(value), (cs, r) => cs.insert(relationAt(r), []))
		const depths = writesByDepth(k.spec)
		const programs = Rec.fromEntries([
			["whole", inserting(insertedRelations(k.spec))] as const,
			...(byDepth
				? Arr.map(depths, (relations, d) => [`depth${String(d)}`, inserting(relations)] as const)
				: [])
		])
		const db = yield* openServedDb(done, world.server.roles.app, {})
		const flight = yield* oneFlight(db.ctx, done.as(world.server))
		const loaded = yield* db.load(programs)
		/** A member applied on the tapped context with its call's facts. */
		const applied = (name: string, facts: CallFacts) =>
			writeAnswerOf(
				writeOnce(memberCalls(flight.context, member(loaded, name)))({ params: {}, facts })
			)
		const state = Effect.forEach(
			Arr.map(k.spec.relations, (_, r) => relationAt(r)),
			(relation) => storedRows(done, relation)
		)
		return { applied, state, depths, flight }
	})

/** The facts of `relations` among `rows`, as an insert of each states them, under each relation's name. */
const factsOf = (
	k: FreshCase,
	rows: ReadonlyArray<InstanceRow>,
	relations: ReadonlyArray<number>
): CallFacts => {
	const facts = instanceFacts(k.spec, rows)
	return {
		insert: Rec.fromEntries(
			Arr.map(relations, (r): readonly [string, ReadonlyArray<unknown>] => [
				relationName(r),
				facts.get(r) ?? []
			])
		)
	}
}

/**
 * The exact repeat of a stored owner beside an append to its group, where the instance holds an owner of a counted
 * family with a member: the whole instance again, exactly, every owner above the new member among it (an immutable
 * owner's family is fixed when the owner is inserted, so a ChangeSet that inserts a member inserts its owners), and one
 * new member of that owner's group.
 */
const repeatOf = (k: FreshCase): Option.Option<{ readonly appended: InstanceRow }> =>
	Arr.findFirst(
		Arr.flatMap(k.spec.families, (family, f) =>
			Arr.flatMap(k.rows, (owner) =>
				family.kind === "counted" &&
				insertedRelations(k.spec).includes(family.owner) &&
				insertedRelations(k.spec).includes(family.member) &&
				owner.relation === family.owner &&
				Arr.some(k.rows, (row) =>
					Arr.some(row.memberOf, (m) => m.family === f && m.owner === owner.id)
				)
					? Option.toArray(
							Option.map(appendedBeside(k.spec, k.rows, f, owner.id), (appended) => ({
								appended
							}))
						)
					: []
			)
		),
		() => true
	)

/** A fresh group drawn by the host is stored as the family's scan draws it, and a stored group goes on being scanned. */
export const aFreshCountedGroupDrawnByTheHostIsStoredAsTheFamilysScanDrawsItAndAStoredGroupIsStillScanned =
	property.explore(freshCaseGen, {
		needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 32, steered: 32 },
		check:
			({ caseSubstrate }, c: Case<Feature>) =>
			(k) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const repeat = repeatOf(k)
						const fresh = yield* installed(k, "fresh", false)
						const scanned = yield* installed(k, "scanned", true)
						const whole = yield* fresh.applied(
							"whole",
							factsOf(k, k.rows, insertedRelations(k.spec))
						)
						assert.equal(
							whole.kind,
							k.rows.length === 0 ? "unchanged" : "accepted",
							"the fresh installation's insert of the whole instance"
						)
						for (const [d, relations] of scanned.depths.entries()) {
							const holds = Arr.some(k.rows, (row) => relations.includes(row.relation))
							const once = yield* scanned.applied(
								`depth${String(d)}`,
								factsOf(k, k.rows, relations)
							)
							assert.equal(
								once.kind,
								holds ? "accepted" : "unchanged",
								`the scanned installation's insert of depth ${String(d)}`
							)
						}
						const freshRows = yield* fresh.state
						const scannedRows = yield* scanned.state
						assert.deepEqual(
							freshRows,
							scannedRows,
							"every table's rows, every column, drawn by the host and by the family's scan"
						)
						c.noteAll(reached(k))
						if (Option.isNone(repeat)) {
							return
						}
						const facts = factsOf(k, [...k.rows, repeat.value.appended], insertedRelations(k.spec))
						for (const at of [fresh, scanned]) {
							const answer = yield* at.applied("whole", facts)
							assert.equal(
								answer.kind,
								"accepted",
								"an exact repeat of a stored owner beside an append"
							)
						}
						const freshAfter = yield* fresh.state
						const scannedAfter = yield* scanned.state
						assert.deepEqual(
							freshAfter,
							scannedAfter,
							"every table's rows after the append to a stored group, in both installations"
						)
						const appended = repeat.value.appended.relation
						assert.equal(
							defined(freshAfter[appended]).length,
							defined(freshRows[appended]).length + 1,
							"the append adds its member to the stored group"
						)
						c.note("an exact repeat of a stored owner beside an append to its group")
						const immutable: FreshCase = {
							spec: {
								...k.spec,
								relations: nonEmpty(Arr.map(k.spec.relations, (r) => ({ ...r, mutable: false })))
							},
							rows: k.rows
						}
						const fixed = yield* installed(immutable, "immutable", false)
						const stored = yield* fixed.applied(
							"whole",
							factsOf(immutable, k.rows, insertedRelations(k.spec))
						)
						assert.equal(
							stored.kind,
							"accepted",
							"the immutable installation's insert of the whole instance"
						)
						const refused = yield* fixed.applied("whole", facts)
						if (refused.kind !== "refused") {
							return assert.fail(
								`an exact repeat of a stored immutable owner beside an append is refused, not ${Formatter.format(refused)}`
							)
						}
						const member = relationName(repeat.value.appended.relation)
						type Refused = ReturnType<typeof refusedEntries>[number]
						const counted = (refusedLaw: Refused): boolean =>
							refusedLaw.law.kind === "family" &&
							refusedLaw.law.order === "counted" &&
							refusedLaw.law.member.relation === member
						const alongItsOwnerAxis = (refusedLaw: Refused): boolean =>
							counted(refusedLaw) ||
							(refusedLaw.law.kind === "contained" && refusedLaw.law.from.relation === member)
						assert.ok(
							Arr.some(refusedEntries(refused.refused), counted) &&
								Arr.every(refusedEntries(refused.refused), alongItsOwnerAxis),
							`the append to a stored immutable group is refused by its counted family's count axis, and the copies its foreign key carries beside it, as the scan from slot 0 refused it before the host drew fresh groups: ${Formatter.format(refused.refused)}`
						)
						c.note("an exact repeat of a stored immutable owner beside an append, refused")
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(caseSubstrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "the family's scan (write/family/scan.ts scanOf), run by PostgreSQL over the stored groups, and every native over both installations"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\t\tgroups.set(group, list.toSorted(order))",
				replacement: "\t\t\t\t\tgroups.set(group, list)",
				why: "The host walks a fresh group's members in the order the call states them, not by their key, so its slots and planes are not the scan's; the differential fails where members come out of their key order."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original:
					'\t\t\treturn drawnValue(row, column, row.place.kind === "member" ? row.place.at : 0)',
				replacement:
					'\t\t\treturn drawnValue(row, column, (row.place.kind === "member" ? row.place.at : 0) + 1)',
				why: "The host draws each member's slot ‹i› one past its place; PostgreSQL refuses the fresh write, or the differential fails."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\t\treturn { family: g.key, group, members: g.groups?.get(group) ?? [] }",
				replacement:
					"\t\t\t\t\treturn { family: g.key, group, members: [...(g.groups?.values() ?? [])][0] ?? [] }",
				why: "The host draws every owner's family from the first group's members, so a member's owner copies and its owner's count come from the wrong owner; the differential fails over two owners."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original: "\t\t\treturn drawnValue(row, column, row.counts.get(rule.family) ?? 0)",
				replacement: "\t\t\treturn drawnValue(row, column, (row.counts.get(rule.family) ?? 0) + 1)",
				why: "The host draws an owner's count, its count fold's end, one past its members; PostgreSQL refuses the fresh write, or the differential fails."
			},
			{
				file: "packages/engine/src/write/family/additions.ts",
				original: "=> and([drawn, eq(kept, lit.int(0, types.bigint))])",
				replacement: "=> and([drawn, drawn])",
				why: "A group the host drew is fresh even where it holds stored members, as an exact repeat of a stored owner's does: the scan leaves it and the host's members stand for it, its appended member, whose key sorts first, at slot 0, a stored member's; the append is refused."
			},
			{
				file: "packages/engine/src/write/family/additions.ts",
				original: "\t\tisFresh(lit.bool(true), keptAt(hostGroup))",
				replacement: "\t\tundefined",
				why: "The host's members stand for every group the host drew, a group holding stored members among them, which the scan draws too: an exact repeat's appended member is drawn twice; the append is refused."
			},
			{
				file: "packages/engine/src/write/family/additions.ts",
				original: "\teq(col(alias, host.keys.first), lit.int(hostTag, types.integer))",
				replacement: "\teq(col(alias, host.keys.tag), lit.int(hostTag, types.integer))",
				why: "No group reads as one the host drew, so the scan draws every fresh group beside the host's members of it: each fresh member is drawn twice; the fresh write is refused."
			}
		]
	})
