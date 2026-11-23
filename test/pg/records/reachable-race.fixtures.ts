/**
 * What the race of reachable-race.test.ts reads: its schema, its space of races, the model of how every serial order of
 * them ends, and its case.
 */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { pctSchedule } from "@bjornpagen/testing/interleave"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec } from "effect"
import { pg, retirement, Sha256, sha256 } from "#compiler/public/fields.ts"
import {
	login,
	on,
	reachable,
	records,
	recordsFacts,
	relation,
	retirable,
	role,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	changeTxnOf,
	generatedShapeTemplate,
	type InstalledShape,
	type RacedShape,
	type Shape
} from "#test/pg/isolation/support/race.ts"
import { factsGen, shelfId, shelvesFacts } from "#test/pg/records/attached.fixtures.ts"
import { type RecordsShape, shapeQuery } from "#test/support/agreement/records.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { Shelf, shelvesNamed } from "#test/support/fixtures/records/shelves.ts"
import { Id } from "#test/support/ids.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { openActors, textOfValue } from "#test/support/schedules/actors.ts"
import {
	allowed,
	every,
	exploreEnv,
	exploreInterleavings,
	type Interleaving,
	interleaveStep,
	refusedJudgment,
	type Strategy,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import type { RaceTxn } from "#test/support/schedules/serial.ts"
import type { StepOutcome } from "#test/support/schedules/types.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The records' shape the race stores: the shelf's books, each with its spine and the spine's ink below it, its paper
 * detail as the arm of its kind, and its chapters, each with its remarks as an array, so a release deletes rows three
 * relations deep and an arm's.
 */
const raceShape: RecordsShape = {
	owner: "run",
	books: {
		name: "items",
		descending: false,
		at: false,
		literal: false,
		blurb: Option.none(),
		spine: Option.some({
			name: "notes",
			delivery: "one",
			ink: Option.some({ name: "detail", delivery: "option" })
		}),
		paper: Option.some({ name: "extra", delivery: "arm" }),
		digital: Option.none(),
		chapters: Option.some({ name: "row", remark: Option.some({ name: "at", delivery: "array" }) })
	}
}

/** The header of the holders' unit, a root of den's census. */
const Root = relation("Root", { id: pg.integer, retired: retirement }, ["id"])

/** A root's references to the records, each a digest at its place `n`, a body of the root's unit. */
const Ref = relation("Ref", { root: pg.integer, n: pg.integer, digest: sha256 }, ["root", "n"])

/** The relations a keep inserts: the records' root's, each one an insert states apart, and Ref. */
const keptNamesOf = (kept: {
	readonly row: { readonly name: string }
	readonly apart: ReadonlyArray<{ readonly name: string }>
}): ReadonlyArray<string> => [kept.row.name, ...Arr.map(kept.apart, (r) => r.name), "Ref"]

/** The keep over `level`: an insert of the records and of Ref in one ChangeSet, as den keeps a row beside its reference. */
const keepOf = (level: unknown, names: ReadonlyArray<string>) =>
	changeSetOver.empty(level).insertAll(Rec.fromEntries(Arr.map(names, (n) => [n, []] as const)))

/**
 * How deep a race's records are: the read shelf's row alone, or its books three relations deep with an arm (raceShape).
 */
export type Depth = "flat" | "deep"

/** The query a race's records hold over Shelves `base`: the read shelf's row, or raceShape's books below it too. */
const queryAt = (base: unknown, depth: Depth) =>
	depth === "deep"
		? shapeQuery(base, raceShape)
		: queryOver(base).rule((r: RuleValue) => {
				const { id, label } = varsOver(Shelf, "shelf")
				return r
					.match(Shelf, { id, label })
					.where(r.eq(id, r.param("shelf", Id)))
					.find({ id, label })
			})

/**
 * The race's schema under `name`: Shelves, the records of the query of `depth` keyed by their digest alone, Root's
 * unit over Ref, and the records reachable from Ref; its login, a writer that reads the query and inserts the records'
 * relations and Ref alone, its workload keeping records beside their reference in one call as den does, and a retirer that
 * retires roots.
 */
const raceBuilt = (name: string, depth: Depth) => {
	const base = shelvesNamed(name)
	const query = queryAt(base, depth)
	const kept = records("Kept", query, { digest: sha256 }, ["digest"])
	const level = schema.extend(
		[base],
		levelNameAt(name, 1),
		[Root, Ref, ...kept.relations],
		[
			...kept.rules,
			retirable(Root, [on(Ref, "root")]),
			reachable(on(kept, "digest"), [on(Ref, "digest")])
		]
	)
	const keptNames = keptNamesOf(kept)
	const relations: ReadonlyArray<{ readonly name: string }> = kept.relations
	const written = [...Arr.map(relations, (r) => r.name), "Ref"]
	const writer = role(level, "writer", wholeEntriesOf(level), {
		insert: Arr.filter(writableNamesOf(level), (n) => written.includes(n))
	})
	const retirer = role(level, "retirer", wholeEntriesOf(level), { retire: ["Root"] })
	const app = login(level, "records_app", [writer, retirer], {
		workload: [
			workload(writer, { found: query, keep: keepOf(level, keptNames) }),
			workload(retirer, { retire: changeSetOver.empty(level).retire(Root, []) })
		]
	})
	return { query, kept, keptNames, level, app, writer, retirer }
}

/** The race's schema of `depth` under `name` as the isolation races install it (race.ts Shape). */
export const raceShapeOf =
	(depth: Depth) =>
	(name: string): Shape => {
		const built = raceBuilt(name, depth)
		return {
			schema: built.level,
			roles: { writer: built.writer, retirer: built.retirer },
			login: built.app
		}
	}

/** The race's schema of each depth installed once per member as generate certifies it. */
export const raceTemplates = {
	flat: generatedShapeTemplate(import.meta, "reachable race flat", raceShapeOf("flat")),
	deep: generatedShapeTemplate(import.meta, "reachable race deep", raceShapeOf("deep"))
} as const

/** The key the keep stores and references, and the other key: the digests of the bytes 1 and 2. */
const keptKey = Sha256.ofBytes(Uint8Array.of(1))
const otherKey = Sha256.ofBytes(Uint8Array.of(2))

/**
 * A race: how deep its records are; the Shelves facts the query reads; which of roots 1 and 2 reference the kept key,
 * at least one, and which the other key, none leaving it unstored. Its calls: the retirer's retirements of root 1 and of root 2, each a call of its
 * own, and the writer's keep of the kept key's records beside root 3's reference to them, each call a transaction of
 * its served statements at its role's served level, interleaved at statement boundaries.
 */
export interface Race {
	readonly depth: Depth
	readonly facts: ReturnType<typeof factsGen>
	readonly keptBy: Arr.NonEmptyReadonlyArray<1 | 2>
	readonly otherBy: ReadonlyArray<1 | 2>
}

/** A nonempty set of roots 1 and 2, or any set. */
const rootsGen =
	(nonEmpty: boolean): Gen<ReadonlyArray<1 | 2>> =>
	(source) => {
		const first = source.draw(boolean)
		const second = source.draw(boolean)
		return [
			...(first || (nonEmpty && !second) ? [1 as const] : []),
			...(second ? [2 as const] : [])
		]
	}

export const raceGen: Gen<Race> = (source) => {
	const [first, ...rest] = source.draw(rootsGen(true))
	return {
		depth: source.draw(element<Depth>(["flat", "deep"])),
		facts: source.draw(factsGen),
		keptBy: [defined(first, "a root referencing the kept key"), ...rest],
		otherBy: source.draw(rootsGen(false))
	}
}

/** A run's end or the race's setting differs from the model's. */
class RaceDisagreed extends Data.TaggedError("RaceDisagreed")<{ readonly message: string }> {}

/** The sessions of a race: the two retirements and the keep. */
const sessions = ["retire1", "retire2", "keep"] as const

type Session = (typeof sessions)[number]

/**
 * What one run reached: a retirement or the keep aborted 40001 and retried, and how the kept key's records went, three
 * relations deep among them.
 */
export type RaceFeature =
	| "a retirement aborted and retried"
	| "the keep aborted and retried"
	| "released by the last retirement, then stored again by the keep"
	| "released and stored again three relations deep"
	| "kept by the keep's reference"

/** Whether a step's outcome is PostgreSQL's transient failure: a serialization failure or a deadlock. */
const transient = (outcome: StepOutcome): boolean =>
	outcome._tag === "PgError" && (outcome.fields.code === "40001" || outcome.fields.code === "40P01")

/** Whether `session`'s span overlaps another session's, as a transient failure's cause must. */
const overlapping = (run: Interleaving, session: string): boolean => {
	const own = run.spans[session]
	return (
		own !== undefined &&
		Arr.some(
			Rec.toEntries(run.spans),
			([name, span]) => name !== session && span.start < own.end && own.start < span.end
		)
	)
}

/**
 * Every order where a race makes few moves; past that, a PCT schedule of depth 3 the case draws, as the isolation races
 * choose (arbiter.fixtures.ts strategyOf).
 */
const strategyOf = <F extends string>(c: Case<F>, txns: ReadonlyArray<Txn>): Strategy => {
	const moves = Arr.reduce(txns, 0, (sum, t) => sum + t.steps.length + 1)
	return moves <= 6
		? every
		: {
				kind: "pct",
				nature: c,
				schedule: c.draw(
					pctSchedule(
						nonEmptyList(
							Arr.map(txns, (t) => t.session),
							"a race's sessions"
						),
						3,
						moves
					)
				)
			}
}

/**
 * A race (see reachable-race.test.ts) on the case's own clone of the race's schema: generate certifies the writer and the
 * retirer SERIALIZABLE; then each run of the race's calls, from the race's initial state, in an order the strategy
 * chooses, retries each call PostgreSQL aborted with a transient failure alone after the run, as an application calls
 * again, and must end as every serial order of the three calls ends (the model): roots 1 and 2 retired and root 3 open,
 * root 3's reference to the kept key the one reference left, the kept key's records whole in every relation, and the
 * other key's gone from every one.
 */
export const raceCase = (raced: RacedShape, race: Race, c: Case<RaceFeature>) =>
	Effect.provideService(
		Effect.scoped(
			Effect.gen(function* () {
				const s: InstalledShape = raced.shape
				for (const name of ["writer", "retirer"]) {
					const level = s.levels.get(name)
					if (level !== "serializable") {
						return yield* new RaceDisagreed({
							message: `generate certified the ${name} ${Formatter.format(level)}, where a writer of reachable records and their retirer run SERIALIZABLE`
						})
					}
				}
				const substrate = yield* Substrate
				const installed = s.installed
				const built = raceBuilt(installed.declared, race.depth)
				const writer = yield* openServedDb(installed, built.app.roles.writer, {})
				const served = yield* writer.serve({
					found: built.query,
					keep: keepOf(built.level, built.keptNames)
				})
				const facts = shelvesFacts(race.facts)
				const base = {
					...facts,
					Root: Arr.map([1, 2, 3], (id) => ({ id, retired: false }))
				}
				yield* replaceMigrated(installed, base)
				const found = yield* readOnce(member(served, "found"))({
					params: { shelf: shelfId },
					facts: {}
				})
				const recordsAt = (digests: ReadonlyArray<Sha256>) =>
					recordsFacts(
						built.level,
						built.kept
					)(Arr.flatMap(found, (row) => Arr.map(digests, (digest) => [{ digest }, row] as const)))
				const initialRefs = Arr.flatMap([1, 2] as const, (root) =>
					Arr.map(
						[
							...(race.keptBy.includes(root) ? [keptKey] : []),
							...(race.otherBy.includes(root) ? [otherKey] : [])
						],
						(digest, n) => ({ root, n, digest })
					)
				)
				const seed = writeOnce(member(served, "keep"))({
					params: {},
					facts: {
						insert: {
							...recordsAt([
								keptKey,
								...(Arr.isReadonlyArrayNonEmpty(race.otherBy) ? [otherKey] : [])
							]),
							Ref: initialRefs
						}
					}
				})
				const reset = Effect.provideService(
					Effect.asVoid(Effect.andThen(replaceMigrated(installed, base), seed)),
					Substrate,
					substrate
				)
				yield* reset
				const keyHex = Sha256.toHex(keptKey)
				const relations = built.kept.relations
				const rowsAt = Effect.forEach(relations, (r) => {
					const column = installed.names.column(
						r.name,
						defined(r.primaryKey[0], "a relation of records carrying the digest first")
					)
					return Effect.map(
						substrate.admin.queryValues(
							`SELECT encode(${column}, 'hex'), count(*)::text FROM ${printObjectName(installed.names.relation(r.name))} GROUP BY 1 ORDER BY 1`,
							[]
						),
						(rows) => [r.name, Arr.map(rows, (row) => Arr.map(row, textOfValue))] as const
					)
				})
				const initialRows = yield* rowsAt
				const initial = Rec.fromEntries(initialRows)
				const expected = {
					records: Rec.map(initial, (rows) => Arr.filter(rows, ([hex]) => hex === keyHex)),
					refs: [["3", "0", keyHex]],
					roots: [
						["1", "true"],
						["2", "true"],
						["3", "false"]
					]
				}
				const retirerRole = defined(s.shape.roles["retirer"], "the race's retirer")
				const writerRole = defined(s.shape.roles["writer"], "the race's writer")
				const actors = yield* openActors(substrate, {
					retire1: { kind: "psql", as: installed.world(retirerRole) },
					retire2: { kind: "psql", as: installed.world(retirerRole) },
					keep: { kind: "psql", as: installed.world(writerRole) }
				})
				const raceTxns: ReadonlyArray<readonly [Session, RaceTxn<never>]> = [
					[
						"retire1",
						yield* changeTxnOf(s, {
							kind: "change",
							session: "retire1",
							role: "retirer",
							member: "retire",
							input: { kind: "facts", facts: { retire: { Root: [{ id: 1 }] } }, params: {} }
						})
					],
					[
						"retire2",
						yield* changeTxnOf(s, {
							kind: "change",
							session: "retire2",
							role: "retirer",
							member: "retire",
							input: { kind: "facts", facts: { retire: { Root: [{ id: 2 }] } }, params: {} }
						})
					],
					[
						"keep",
						yield* changeTxnOf(s, {
							kind: "change",
							session: "keep",
							role: "writer",
							member: "keep",
							input: {
								kind: "facts",
								facts: {
									insert: { ...recordsAt([keptKey]), Ref: [{ root: 3, n: 0, digest: keptKey }] }
								},
								params: {}
							}
						})
					]
				]
				const txns: ReadonlyArray<Txn> = Arr.flatMap(raceTxns, ([session, t]): ReadonlyArray<Txn> =>
					t.kind === "direct"
						? [
								{
									kind: "direct",
									session,
									begin: t.begin,
									steps: Arr.map(t.statements, (st) => interleaveStep(st.sql, st.footprint)),
									end: t.end,
									after: undefined
								}
							]
						: []
				)
				const alone = (session: Session) =>
					Effect.gen(function* () {
						const actor = actors[session]
						const t = defined(
							Option.getOrUndefined(Arr.findFirst(raceTxns, ([name]) => name === session)),
							`${session}'s transaction`
						)[1]
						if (t.kind !== "direct") {
							return Option.some(`${session}'s transaction is direct`)
						}
						for (;;) {
							const begun = yield* actor.perform(t.begin)
							if (begun._tag !== "Ok") {
								return Option.some(
									`${session} could not begin alone: ${describeStepOutcome(begun)}`
								)
							}
							const outcomes: Array<StepOutcome> = []
							for (const statement of t.statements) {
								const outcome = yield* actor.perform({ _tag: "Sql", sql: statement.sql })
								outcomes.push(outcome)
								if (outcome._tag !== "Ok") {
									break
								}
							}
							const last = defined(outcomes[outcomes.length - 1], "a statement's outcome")
							const ended =
								last._tag === "Ok"
									? yield* actor.perform({ _tag: "Commit" })
									: yield* Effect.as(actor.perform({ _tag: "Rollback" }), last)
							if (ended._tag === "Ok") {
								return Option.none()
							}
							if (!transient(ended)) {
								return Option.some(`${session} retried alone failed: ${describeStepOutcome(ended)}`)
							}
						}
					})
				const stateNow = Effect.gen(function* () {
					const recordRows = yield* rowsAt
					const records = Rec.fromEntries(recordRows)
					const refRows = yield* substrate.admin.queryValues(
						`SELECT ${installed.names.column("Ref", "root")}::text, ${installed.names.column("Ref", "n")}::text, encode(${installed.names.column("Ref", "digest")}, 'hex') FROM ${printObjectName(installed.names.relation("Ref"))} ORDER BY 1, 2`,
						[]
					)
					const rootRows = yield* substrate.admin.queryValues(
						`SELECT ${installed.names.column("Root", "id")}::text, ${installed.names.column("Root", "retired")}::text FROM ${printObjectName(installed.names.relation("Root"))} ORDER BY 1`,
						[]
					)
					return {
						records,
						refs: Arr.map(refRows, (row) => Arr.map(row, textOfValue)),
						roots: Arr.map(rootRows, (row) => Arr.map(row, textOfValue))
					}
				})
				const judge = (run: Interleaving) =>
					Effect.gen(function* () {
						const aborted: Array<Session> = []
						for (const session of sessions) {
							const result = run.results[session]
							if (result === undefined) {
								return refusedJudgment(`${session} never ran`)
							}
							if (result._tag === "RolledBack") {
								return refusedJudgment(`${session} rolled back`)
							}
							if (result._tag === "Failed") {
								if (!transient(result.failure)) {
									return refusedJudgment(
										`${session} failed: ${describeStepOutcome(result.failure)}`
									)
								}
								if (!overlapping(run, session)) {
									return refusedJudgment(
										`${session} was aborted with ${describeStepOutcome(result.failure)} beside no other session`
									)
								}
								aborted.push(session)
							}
						}
						for (const session of aborted) {
							const failed = yield* alone(session)
							if (Option.isSome(failed)) {
								return refusedJudgment(failed.value)
							}
						}
						const state = yield* stateNow
						const differs = exactValue(state, expected)
						if (Option.isSome(differs)) {
							return refusedJudgment(
								`the race ended with ${Formatter.format(state)}, where every serial order of its calls ends with ${Formatter.format(expected)}: ${differs.value}`
							)
						}
						const order = [
							...Arr.filter(run.commits, (session) => !Arr.some(aborted, (a) => a === session)),
							...aborted
						]
						const at = (session: Session) => order.indexOf(session)
						const lastHolder = Arr.reduce(race.keptBy, -1, (latest, root) =>
							Math.max(latest, at(root === 1 ? "retire1" : "retire2"))
						)
						c.noteAll([
							...(aborted.includes("retire1") || aborted.includes("retire2")
								? ["a retirement aborted and retried" as const]
								: []),
							...(aborted.includes("keep") ? ["the keep aborted and retried" as const] : []),
							...(at("keep") > lastHolder
								? [
										"released by the last retirement, then stored again by the keep" as const,
										...(race.depth === "deep"
											? ["released and stored again three relations deep" as const]
											: [])
									]
								: ["kept by the keep's reference" as const])
						])
						return allowed
					})
				const env = yield* exploreEnv(substrate)
				yield* exploreInterleavings(
					env,
					{ direct: actors, grizzle: {} },
					{
						name: `retire ${Formatter.format(race.keptBy)} beside a keep of their key`,
						txns,
						reset,
						state: { _tag: "Unread" },
						model: judge
					},
					strategyOf(c, txns)
				)
			})
		),
		Substrate,
		raced.substrate
	)
