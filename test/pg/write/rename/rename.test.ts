import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { boundedShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { onceCalls } from "#adapter/db/handles.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { caseGen } from "#test/pg/write/swarm/case.ts"
import { changeSetOf } from "#test/pg/write/swarm/changes.ts"
import {
	expectStep,
	hostSchema,
	type Laws,
	nothingStored,
	type State,
	type Step,
	type SwarmCase
} from "#test/pg/write/swarm/oracle.ts"
import {
	buildSwarm,
	nonEmptyRelations,
	plainName,
	type SwarmSpec
} from "#test/pg/write/swarm/spec.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import {
	type FollowUp,
	type InstanceRow,
	movingGen,
	relationName
} from "#test/support/families/fill.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import type { StateRow } from "#test/support/substrate/state.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A metamorphic property of grizzle's family writer: renaming every relation of a schema never changes what a write
 * program does. Over the family swarm's drawn schemas and ChangeSets (test/pg/write/swarm/case.ts), a case is written
 * twice, each on an installation of its own: as drawn, and with its relations renamed by a drawn permutation of their
 * names, `R<i>` becoming `R<π(i)>`, every family, law, row and step carried along (`renamed`). The two runs agree step
 * by step: each step compiles in both or in neither, is accepted, unchanged or refused in both, and after each step
 * accepted in both every relation stores the same rows under its name in each run. So the order a stratum's family
 * statements take where no rule orders them, which is their relations' names' (write/frontend/schedule.ts), is never
 * an outcome's cause.
 *
 * The assertion is the contract's and no stronger: a refusal names a law its rows break, and which of several broken
 * laws PostgreSQL meets first follows constraint names, so two refusals agree as refusals, which the families swarm
 * judges law by law. A step is written only from the state the reference writer gives it (swarm/oracle.ts
 * expectStep), so the runs stop at the first step either does not accept.
 *
 * Features: a case written alike step by step, a refusal alike, and the shape a stratum's name order once decided
 * (`movedBeside`): a member that owns a counted family moved to another owner by a put beside an insert of its own
 * member, its member relation renamed to sort before it. The member's additions then ran first and recounted the moved
 * row while it was absent, between its removal and its insert again, so its stored members kept their copy of its old
 * count and the write was refused. A moved row's dependants now follow it as its additions insert it again, its own
 * members' copy of its count among them (write/family/removals.ts cascaded `carried`), whichever statement runs first.
 *
 * Plant: ~/.cache/grizzle-release/FAMILYMOVE/plants/rename-moved-owner-count-copy-not-carried.patch, the members' copy
 * of a moved row's count left out of what its insert again carries, turns the property red at the aimed shape
 * (TEST_SEED=1401971937, the floor's case 2: accepted as drawn, refused renamed by [1,2,0]).
 */

type Situation =
	| "a case written alike step by step"
	| "a refusal alike"
	| "a moved member and its own member's insert, renamed to sort the other way"

const situations: Arr.NonEmptyReadonlyArray<Situation> = [
	"a case written alike step by step",
	"a refusal alike",
	"a moved member and its own member's insert, renamed to sort the other way"
]

/** A case and a permutation of its relations: relation `i` is named `R<order[i]>` in the renamed run. */
interface RenameCase {
	readonly drawn: SwarmCase
	readonly order: Arr.NonEmptyReadonlyArray<number>
}

/** A permutation of the places of `of`, drawn by swapping each place from the last with one at or before it. */
const permutationGen =
	(of: Arr.NonEmptyReadonlyArray<unknown>): Gen<Arr.NonEmptyReadonlyArray<number>> =>
	(source) => {
		const out = Arr.map(of, (_, i) => i)
		for (let i = out.length - 1; i > 0; i -= 1) {
			const j = source.draw(int(0, i))
			const at = defined(out[i], "a place")
			out[i] = defined(out[j], "a place")
			out[j] = at
		}
		return out
	}

/** A swarm case with its relations renamed by `order`: every relation index a spec, a row or a step holds carried. */
const renamed = (c: SwarmCase, order: ReadonlyArray<number>): SwarmCase => {
	const to = (r: number): number => defined(order[r], `relation ${r}'s new place`)
	const spec = c.spec
	/** The relation renamed to `R<i>`: the one whose new place is `i`. */
	const relations = Arr.map(spec.fill.relations, (_, i) =>
		defined(
			spec.fill.relations[
				defined(
					Option.getOrUndefined(Arr.findFirstIndex(order, (p) => p === i)),
					`the relation renamed to ${relationName(i)}`
				)
			],
			"a relation"
		)
	)
	const row = (x: InstanceRow): InstanceRow => ({ ...x, relation: to(x.relation) })
	const followUp = (f: FollowUp): FollowUp => ({
		...f,
		owner: to(f.owner),
		inserted: Arr.map(f.inserted, row),
		appended: Option.map(f.appended, row)
	})
	const step = (s: Step): Step => {
		switch (s.kind) {
			case "insert":
				return { ...s, rows: Arr.map(s.rows, row) }
			case "follow":
				return {
					...s,
					followUp: s.followUp === undefined ? undefined : followUp(s.followUp),
					query: s.query === undefined ? undefined : { ...s.query, relation: to(s.query.relation) }
				}
			case "query put":
				return { ...s, relation: to(s.relation) }
			case "delete all":
				return s
		}
	}
	const renamedSpec: SwarmSpec = {
		...spec,
		fill: {
			...spec.fill,
			relations,
			families: Arr.map(spec.fill.families, (f) => ({
				...f,
				owner: to(f.owner),
				member: to(f.member)
			}))
		},
		laws: Arr.map(spec.laws, (law) => {
			switch (law.kind) {
				case "into set":
				case "into rows":
				case "check":
				case "into member rows":
					return { ...law, relation: to(law.relation) }
				case "into members":
				case "owner into members":
				case "member key":
				case "selected":
					return law
			}
		})
	}
	return { spec: renamedSpec, steps: Arr.map(c.steps, step) }
}

/** What one step did in one run: refused when it compiled, applied with an outcome, and the rows every relation stores
 * after an accepted or unchanged step, by relation name. */
type StepRun =
	| { readonly kind: "uncompiled" }
	| { readonly kind: "refused" }
	| {
			readonly kind: "accepted" | "unchanged" | "outsideWorld" | "refreshed"
			readonly stored: ReadonlyMap<string, ReadonlyArray<StateRow>>
	  }

/**
 * A swarm case written step by step on an installation of its own, as the families swarm writes it (each ChangeSet
 * served, compiled as the one member of a workload of its own, applied from the state the steps before it leave), until
 * a step that is not accepted or that the reference writer does not write.
 */
const written = (c: SwarmCase, label: string) =>
	Effect.gen(function* () {
		const { spec, steps } = c
		const built = buildSwarm(spec)
		const declared = built.rename("Swarm")
		const done = yield* installMigrated(declared, {
			ambient: ordinarySession,
			label: "rename",
			logins: [fullWorld(declared, {}).server],
			extensions: []
		})
		const value = built.rename(done.schema)
		const lawNames = lawNamesOf(value)
		const laws: Laws = {
			of: (s) => lawNames.lawOf(s),
			primaryKey: (name) => lawNames.primaryKeyLaw({ name })
		}
		const host = hostSchema(spec, built, laws)
		const world = fullWorld(value, {})
		const names = [
			...Arr.map(spec.fill.relations, (_, r) => relationName(r)),
			...Arr.map(spec.plains, (_, j) => plainName(j))
		]
		return yield* Effect.gen(function* () {
			const db = yield* openServedDb(done, world.server.roles.app, {})
			const flight = yield* oneFlight(db.ctx, done.as(world.server))
			const runs: Array<StepRun> = []
			let state: State = nothingStored
			for (const [i, step] of steps.entries()) {
				const at = `${label}, step ${String(i)} (${step.kind}) of ${Formatter.format(spec)}`
				const expected = expectStep(spec, built, laws, host, state, step)
				const { changes, facts, params } = changeSetOf(spec, built, value, state, step)
				const loaded = yield* Effect.result(db.load({ step: changes }))
				if (Result.isFailure(loaded)) {
					const refused = loaded.failure
					if (refused instanceof OpenError || !isCompileError(refused.error)) {
						return assert.fail(`${at}: no served call can supply it: ${Formatter.format(refused)}`)
					}
					runs.push({ kind: "uncompiled" })
					return runs
				}
				const served = onceCalls(flight.context, member(loaded.success, "step"))
				const applied = yield* Effect.result(
					flight.judged(at, answered(writeOnce(served)({ params, facts })))
				)
				if (Result.isFailure(applied)) {
					return assert.fail(
						`${at} failed with ${applied.failure.kind}: ${applied.failure.message}`
					)
				}
				const outcome = applied.success
				if (outcome.kind === "refused") {
					runs.push({ kind: "refused" })
					return runs
				}
				const stored = new Map<string, ReadonlyArray<StateRow>>()
				for (const name of names) {
					const rows = yield* tableState(
						done,
						defined(built.relations[name], `the relation ${name}`)
					)
					stored.set(name, rows)
				}
				runs.push({ kind: outcome.kind, stored })
				if (expected.kind !== "written") {
					return runs
				}
				state = expected.next
			}
			return runs
		}).pipe(Effect.scoped)
	}).pipe(Effect.scoped)

/** The mutable owner R0 of an ordered family of R1 and a counted family of R2, R1 the owner of a counted family of R2:
 * each R2 row a member of an R0 row and of an R1 row. */
const movedBesideSpec: SwarmSpec = {
	fill: {
		relations: nonEmptyRelations([
			{ generated: false, mutable: true },
			{ generated: false, mutable: true },
			{ generated: false, mutable: true }
		]),
		families: [
			{ kind: "ordered", owner: 0, member: 1, fold: "none" },
			{ kind: "counted", owner: 1, member: 2, fold: "none" },
			{ kind: "counted", owner: 0, member: 2, fold: "none" }
		],
		copies: [],
		steps: []
	},
	ends: [],
	plains: [],
	laws: []
}

/**
 * The shape a stratum's name order once decided, constructed: an instance of `movedBesideSpec` of two or three R0 rows,
 * the first holding an R1 member at least, and one to three R2 rows, each a member of a drawn R0 row and a drawn R1
 * row; then a follow-up that moves an R1 member to the end of another R0 row's group (fill.ts movingGen) and inserts
 * one or two R2 rows under that R0 row, each a member of the moved R1 row too. Its permutation names R1 after R2, so the
 * renamed run sorts the member relation's additions first, the order that refused it.
 */
const movedBeside: Gen<RenameCase> = (source) => {
	const rows: Array<InstanceRow> = []
	const v = () => BigInt(source.draw(int(-2, 3)))
	const owners = source.draw(int(2, 3))
	for (let o = 0; o < owners; o += 1) {
		const owner = rows.length + 1
		rows.push({ relation: 0, id: owner, v: v(), memberOf: [] })
		const members = source.draw(int(o === 0 ? 1 : 0, 2))
		for (let slot = 0; slot < members; slot += 1) {
			rows.push({
				relation: 1,
				id: rows.length + 1,
				v: v(),
				memberOf: [{ family: 0, owner, slot }]
			})
		}
	}
	const r0 = Arr.filter(rows, (r) => r.relation === 0)
	const r1 = Arr.filter(rows, (r) => r.relation === 1)
	if (!Arr.isReadonlyArrayNonEmpty(r0) || !Arr.isReadonlyArrayNonEmpty(r1)) {
		return assert.fail("the instance holds an R0 row and an R1 member by construction")
	}
	const counted = source.draw(int(1, 3))
	for (let i = 0; i < counted; i += 1) {
		rows.push({
			relation: 2,
			id: rows.length + 1,
			v: v(),
			memberOf: [
				{ family: 1, owner: source.draw(element(r1)).id, slot: 0 },
				{ family: 2, owner: source.draw(element(r0)).id, slot: 0 }
			]
		})
	}
	const move = defined(
		Option.getOrUndefined(source.draw(movingGen(movedBesideSpec.fill, rows, 0))),
		"a move of an R1 member owning R2 rows, which the instance holds by construction"
	)
	const moved = defined(Option.getOrUndefined(move.moved), "the moved member").id
	const first = rows.length + 1
	const inserted = Array.from({ length: source.draw(int(1, 2)) }, (_, i) => ({
		relation: 2,
		id: first + i,
		v: v(),
		memberOf: [
			{ family: 2, owner: move.row, slot: 0 },
			{ family: 1, owner: moved, slot: 0 }
		]
	}))
	const order = source.draw(permutationGen(movedBesideSpec.fill.relations))
	const r1At = defined(order[1], "R1's place")
	const r2At = defined(order[2], "R2's place")
	return {
		drawn: {
			spec: movedBesideSpec,
			steps: [
				{
					kind: "insert",
					rows,
					plain: [],
					conflict: undefined,
					orphan: undefined,
					shape: { split: source.draw(boolean), repeat: false }
				},
				{
					kind: "follow",
					followUp: { ...move, inserted },
					plain: [],
					query: undefined,
					shape: { split: source.draw(boolean), repeat: false }
				}
			]
		},
		order: r1At > r2At ? order : Arr.map(order, (p, i) => (i === 1 ? r2At : i === 2 ? r1At : p))
	}
}

/** The case a witness runs: its drawn one, or, where its turn aims at the moved member's shape, that shape. */
const aimedCase = (drawnCase: RenameCase, c: Case<Situation>): RenameCase =>
	Option.getOrUndefined(c.steering)?.aimed(
		"a moved member and its own member's insert, renamed to sort the other way"
	) === true
		? c.draw(movedBeside)
		: drawnCase

/** A drawn swarm case and a permutation of its relations. */
const renameGen: Gen<RenameCase> = (source) => {
	const c = source.draw(caseGen)
	return { drawn: c, order: source.draw(permutationGen(c.spec.fill.relations)) }
}

/**
 * Whether a case's steps hold a follow-up that moves a member and inserts a row naming it as an owner, and its
 * permutation sorts the two relations' names the other way round from the drawn names.
 */
const reachesMovedBeside = (c: RenameCase): boolean => {
	/** Every row a step of the case writes, its first insert's and every follow-up's own. */
	const rows = Arr.flatMap(c.drawn.steps, (s): ReadonlyArray<InstanceRow> =>
		s.kind === "insert"
			? s.rows
			: s.kind === "follow" && s.followUp !== undefined
				? [...s.followUp.inserted, ...Option.toArray(s.followUp.appended)]
				: []
	)
	const place = (r: number): number => defined(c.order[r], `relation ${r}'s new place`)
	return Arr.some(c.drawn.steps, (s) => {
		const f = s.kind === "follow" ? s.followUp : undefined
		if (f === undefined) {
			return false
		}
		return Option.exists(f.moved, (moved) =>
			Option.exists(
				Arr.findFirst(rows, (r) => r.id === moved.id),
				(mover) =>
					Arr.some(
						f.inserted,
						(row) =>
							Arr.some(row.memberOf, (m) => m.owner === moved.id) &&
							row.relation < mover.relation !== place(row.relation) < place(mover.relation)
					)
			)
		)
	})
}

layer(Substrate.layer, { excludeTestServices: true })(
	"the family writer under renamed relations",
	(it) => {
		it.effect(
			"writes every case alike as drawn and with its relations renamed: each step compiles, is accepted or is refused alike, and every relation stores the same rows",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/write/rename",
							draw: drawn(renameGen),
							literal: Formatter.format,
							coverage: required<Situation>(situations, { cases: 40, sense: notesOnly }),
							kept: [],
							runs: 12,
							shrink: boundedShrink(40),
							concurrency: 1,
							steerEvery: 4,
							caseHang,
							oracle: {
								kind: "specification",
								name: "a relation's name is no part of what a write does: the same case with its relations renamed by a permutation of their names"
							}
						},
						(drawnCase, c) =>
							Effect.gen(function* () {
								const rc = aimedCase(drawnCase, c)
								const as = yield* written(rc.drawn, "as drawn")
								const other = renamed(rc.drawn, rc.order)
								const renamedRuns = yield* written(other, "renamed")
								assert.equal(
									renamedRuns.length,
									as.length,
									`the renamed run writes as many steps as the drawn one: ${Formatter.format(rc.order)}`
								)
								for (const [i, run] of as.entries()) {
									const twin = defined(renamedRuns[i], "the renamed run's step")
									assert.equal(
										twin.kind,
										run.kind,
										`step ${String(i)}: ${run.kind} as drawn, ${twin.kind} renamed by ${Formatter.format(rc.order)}`
									)
									if (run.kind === "uncompiled" || run.kind === "refused") {
										continue
									}
									if (twin.kind === "uncompiled" || twin.kind === "refused") {
										return
									}
									/** Each relation's name as drawn and as renamed: a family relation's by its new place, a plain
									 * relation's its own. */
									const pairs = [
										...Arr.map(rc.drawn.spec.fill.relations, (_, r): readonly [string, string] => [
											relationName(r),
											relationName(defined(rc.order[r], "a place"))
										]),
										...Arr.map(rc.drawn.spec.plains, (_, j): readonly [string, string] => [
											plainName(j),
											plainName(j)
										])
									]
									for (const [name, at] of pairs) {
										unorderedEqual(
											defined(twin.stored.get(at), `the renamed run's ${at}`),
											defined(run.stored.get(name), `the drawn run's ${name}`),
											`step ${String(i)}: ${name}'s rows as drawn are ${at}'s renamed`
										)
									}
								}
								if (
									as.length > 0 &&
									Arr.every(as, (r) => r.kind !== "uncompiled" && r.kind !== "refused")
								) {
									c.note("a case written alike step by step")
								}
								if (Arr.some(as, (r) => r.kind === "refused")) {
									c.note("a refusal alike")
								}
								if (reachesMovedBeside(rc)) {
									c.note(
										"a moved member and its own member's insert, renamed to sort the other way"
									)
								}
							})
					)
				)
		)
	}
)
