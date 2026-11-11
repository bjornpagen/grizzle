import { Array as Arr, Deferred, Effect, Exit, Option, Ref, Result } from "effect"
import { dbReadFrame, type ServedDbContext } from "#adapter/db/context.ts"
import { memberOpsOn } from "#adapter/db/handles.ts"
import type { ServedOps } from "#adapter/db/ops.ts"
import { toResult } from "#adapter/engine.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import type { ReadExecutor } from "#adapter/reader/executor.ts"
import { type LoadedMember, loadServed } from "#adapter/served/load.ts"
import {
	asReadFailure,
	type BatchOutcome,
	type BatchStatement,
	runFramed
} from "#adapter/wire/batch.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { queryDescOf } from "#compiler/schema/protocol.ts"
import type { ServedFile, ServedMember } from "#compiler/served/forms.ts"
import { servedSource } from "#compiler/served/read.ts"
import { defined } from "#test/support/assert.ts"
import {
	compileTemplate,
	type FixtureSchema,
	type TestCompileOptions,
	testArtifacts
} from "#test/support/compile.ts"
import { conservativePageRuntime } from "#test/support/conservative.ts"
import { factKeySet, sameFact } from "#test/support/worlds/model/host.ts"
import type { HostFact } from "#test/support/worlds/model/types.ts"

/**
 * The differential of one read's two artifacts. Every read a Db serves is compiled by generate's compile into its
 * served file: the optimized artifact, which the Db runs, beside which the oracle lowers the same query conservatively,
 * resting on no evidence the context admits (test/support/conservative.ts). Both must deliver the same from the same
 * snapshot (Delivery): a read's rows as one keyed set, and a paged read's pages one by one, each page's edges in order
 * with their cursors and its flags, over every page it reaches from the first or the last and the pages after and
 * before every cursor those pages delivered. Rows that differ, or that either artifact repeats, are
 * `artifacts-disagree`, a defect no model branch allows.
 *
 * The check reads through the members of two served files over the Db's own context (adapter/db/handles.ts
 * memberOpsOn), as the Db runs a member. One is the file the Db's read was served from, so it runs the very statements
 * and page the Db's read ran. The other is that file with every read's statements its conservative lowering and every
 * page's artifact its conservative page artifact (conservativeServed), loaded as a layer loads a file. Their flights
 * meet: each pair of flights, one per artifact, is sent as one flight in one READ ONLY transaction of the Db's role and
 * claims on one leased session, the optimized statements first. Every read path (execute, get, every page, every
 * anchored page) sends its flights in turn, so the k-th flight of one artifact meets the k-th of the other. A flight left
 * without a partner, because the other artifact read through in fewer flights, is sent alone.
 */
type Side = "optimized" | "conservative"

const otherSide = (side: Side): Side => (side === "optimized" ? "conservative" : "optimized")

/** A side's flight waiting for the other's: its statements, and where its own outcomes are delivered. */
interface Waiting {
	readonly side: Side
	readonly statements: ReadonlyArray<BatchStatement>
	readonly outcomes: Deferred.Deferred<ReadonlyArray<BatchOutcome>, ReadError>
}

/** Where the two sides stand: neither waiting, one waiting for the other, or one reading on after the other finished. */
type Meeting =
	| { readonly kind: "open" }
	| { readonly kind: "waiting"; readonly waiting: Waiting }
	| { readonly kind: "alone"; readonly side: Side }

/** What a side's arriving flight does: wait for the other's, go with the waiting one, or go alone. */
type Arrival =
	| { readonly kind: "wait" }
	| { readonly kind: "pair"; readonly other: Waiting }
	| { readonly kind: "alone" }
	| { readonly kind: "out-of-turn" }

const arrivalAt = (meeting: Meeting, mine: Waiting): readonly [Arrival, Meeting] => {
	switch (meeting.kind) {
		case "open":
			return [{ kind: "wait" }, { kind: "waiting", waiting: mine }]
		case "waiting":
			return meeting.waiting.side === mine.side
				? [{ kind: "out-of-turn" }, meeting]
				: [{ kind: "pair", other: meeting.waiting }, { kind: "open" }]
		case "alone":
			return meeting.side === mine.side
				? [{ kind: "alone" }, meeting]
				: [{ kind: "out-of-turn" }, meeting]
	}
}

/** One flight's statements sent on a session leased from the Db's pool, in one transaction of its read frame. */
const flown = (
	ctx: ServedDbContext,
	statements: ReadonlyArray<BatchStatement>
): Effect.Effect<ReadonlyArray<BatchOutcome>, ReadError> =>
	Effect.scoped(
		Effect.flatMap(
			Effect.mapError(ctx.pool.lease, (reason) => new ReadFailure({ reason })),
			(session) => Effect.mapError(runFramed(session, dbReadFrame(ctx), statements), asReadFailure)
		)
	)

/** Two waiting flights sent as one, the optimized first; each side is delivered its own statements' outcomes. */
const together = (
	ctx: ServedDbContext,
	mine: Waiting,
	other: Waiting
): Effect.Effect<ReadonlyArray<BatchOutcome>, ReadError> => {
	const [first, second] = mine.side === "optimized" ? [mine, other] : [other, mine]
	return Effect.gen(function* () {
		const exit = yield* Effect.exit(flown(ctx, [...first.statements, ...second.statements]))
		const cut = first.statements.length
		yield* Deferred.done(
			first.outcomes,
			Exit.map(exit, (all) => all.slice(0, cut))
		)
		yield* Deferred.done(
			second.outcomes,
			Exit.map(exit, (all) => all.slice(cut))
		)
		return yield* Deferred.await(mine.outcomes)
	})
}

/** A side's flight arriving at the meeting: it waits for the other's, goes with it, or goes alone. */
const arrive = (
	ctx: ServedDbContext,
	meeting: Ref.Ref<Meeting>,
	side: Side,
	statements: ReadonlyArray<BatchStatement>
): Effect.Effect<ReadonlyArray<BatchOutcome>, ReadError> =>
	Effect.gen(function* () {
		const mine: Waiting = {
			side,
			statements,
			outcomes: yield* Deferred.make<ReadonlyArray<BatchOutcome>, ReadError>()
		}
		const arrival = yield* Ref.modify(meeting, (m) => arrivalAt(m, mine))
		switch (arrival.kind) {
			case "wait":
				return yield* Deferred.await(mine.outcomes)
			case "pair":
				return yield* together(ctx, mine, arrival.other)
			case "alone":
				return yield* flown(ctx, statements)
			case "out-of-turn":
				return yield* Effect.die(new Error(`the ${side} artifact sent a flight out of turn`))
		}
	})

/**
 * A side done reading, or interrupted: a flight of the other's still waiting goes alone, and so does every later one.
 * A side interrupted while its own flight waits leaves it unsent.
 */
const finished = (
	ctx: ServedDbContext,
	meeting: Ref.Ref<Meeting>,
	side: Side
): Effect.Effect<void> =>
	Effect.flatMap(
		Ref.modify(meeting, (m): readonly [Option.Option<Waiting>, Meeting] => {
			switch (m.kind) {
				case "open":
					return [Option.none(), { kind: "alone", side: otherSide(side) }]
				case "waiting":
					return m.waiting.side === side
						? [Option.none(), { kind: "alone", side: otherSide(side) }]
						: [Option.some(m.waiting), { kind: "alone", side: m.waiting.side }]
				case "alone":
					return [Option.none(), m]
			}
		}),
		(left) =>
			Option.match(left, {
				onNone: () => Effect.void,
				onSome: (waiting) =>
					Effect.flatMap(Effect.exit(flown(ctx, waiting.statements)), (exit) =>
						Effect.asVoid(Deferred.done(waiting.outcomes, exit))
					)
			})
	)

const executorAt = (ctx: ServedDbContext, meeting: Ref.Ref<Meeting>, side: Side): ReadExecutor => ({
	run: (flight) =>
		Effect.flatMap(arrive(ctx, meeting, side, flight.statements), (outcomes) =>
			Effect.mapError(flight.read(outcomes), (reason) => new ReadFailure({ reason }))
		)
})

/** One page a paged read requested, as two artifacts' pages are held to each other: its edges in order, and its flags. */
export interface DeliveredPage {
	readonly edges: ReadonlyArray<{ readonly fact: HostFact; readonly cursor: string }>
	readonly hasNextPage: boolean
	readonly hasPreviousPage: boolean
}

/**
 * What a read delivers, as the differential holds the two artifacts' deliveries to each other: a keyed set of facts
 * (execute, get, an attachment, a recursive read), or every page a paged read requested, in the order it requested
 * them.
 */
export type Delivery =
	| { readonly kind: "facts"; readonly facts: ReadonlyArray<HostFact> }
	| { readonly kind: "pages"; readonly pages: ReadonlyArray<DeliveredPage> }

/**
 * Whether two sets of facts are one keyed set: neither holds a fact twice, and each fact of one is a fact of the other,
 * each fact by every field and its value. Two artifacts that repeat one row alike deliver no set, so they do not agree.
 */
const sameSet = (left: ReadonlyArray<HostFact>, right: ReadonlyArray<HostFact>): boolean => {
	const l = factKeySet(left)
	const r = factKeySet(right)
	return (
		l.size === left.length &&
		r.size === right.length &&
		l.size === r.size &&
		Arr.every([...l], (key) => r.has(key))
	)
}

/**
 * Whether two pages are one: the same edges in the same order, each the same fact at the same cursor (one codec
 * serves both artifacts, so a boundary's cursor is one token), and the same flags.
 */
const samePage = (left: DeliveredPage, right: DeliveredPage): boolean =>
	left.hasNextPage === right.hasNextPage &&
	left.hasPreviousPage === right.hasPreviousPage &&
	left.edges.length === right.edges.length &&
	Arr.every(
		Arr.zip(left.edges, right.edges),
		([l, r]) => l.cursor === r.cursor && sameFact(l.fact, r.fact)
	)

/**
 * Whether two deliveries agree: two keyed sets that are one set (sameSet), or two requests' pages that are, request by
 * request, one page (samePage).
 */
const sameDelivery = (left: Delivery, right: Delivery): boolean => {
	switch (left.kind) {
		case "facts":
			return right.kind === "facts" && sameSet(left.facts, right.facts)
		case "pages":
			return (
				right.kind === "pages" &&
				left.pages.length === right.pages.length &&
				Arr.every(Arr.zip(left.pages, right.pages), ([l, r]) => samePage(l, r))
			)
	}
}

/** A read's members, loaded from each artifact's served file, by name. */
type SidedMembers = { readonly [S in Side]: ReadonlyMap<string, LoadedMember> }

/**
 * The members of `role` in `file`, the served file the Db's read was served from, and in its conservative file
 * (conservativeServed), each loaded as a layer loads a file, by name. `queries` holds each read member's query under
 * its name, `schema` the role they read over, and `options` the installation's allocation and codes, which compile
 * each query here as the served file's compile compiled it.
 */
export const sidedMembers = (
	file: ServedFile,
	role: string,
	queries: ReadonlyMap<string, unknown>,
	schema: FixtureSchema,
	options: TestCompileOptions
): Result.Result<SidedMembers, CompileError> =>
	Result.flatMap(toResult(testArtifacts(schema, options)), (artifacts) => {
		const optimized = servedMembers(file, role)
		const conservativeOf = (member: ServedMember): Result.Result<ServedMember, CompileError> => {
			const query = queries.get(member.name)
			switch (member.kind) {
				case "read":
				case "key":
					return Result.map(toResult(compileTemplate(query, undefined, options)), (oracle) => ({
						...member,
						read: { ...member.read, source: servedSource(oracle.runs.conservative) }
					}))
				case "paged":
					return Result.gen(function* () {
						const rows = yield* toResult(compileTemplate(query, undefined, options))
						const page = yield* toResult(
							compileTemplate(query, undefined, { ...options, read: "page" })
						)
						const loaded = optimized.get(member.name)
						if (loaded?.kind !== "paged") {
							throw new Error(`the paged member ${member.name} does not load as one`)
						}
						const baseline = yield* conservativePageRuntime(
							loaded.page.runtime,
							page,
							queryDescOf(query, "the paged read's query"),
							artifacts
						)
						return {
							...member,
							read: { ...member.read, source: servedSource(rows.runs.conservative) },
							page: baseline.runtime.page
						}
					})
				case "change":
				case "refresh":
					return Result.succeed(member)
			}
		}
		return Result.map(
			Result.all(
				Arr.map(file.roles, (r) =>
					r.name === role
						? Result.map(Result.all(Arr.map(r.members, conservativeOf)), (members) => ({
								...r,
								members
							}))
						: Result.succeed(r)
				)
			),
			(roles) => ({ optimized, conservative: servedMembers({ ...file, roles }, role) })
		)
	})

/** The members of `role` in `file`, loaded, by name; a file its own compile wrote that does not load is a defect. */
export const servedMembers = (
	file: ServedFile,
	role: string
): ReadonlyMap<string, LoadedMember> => {
	const loaded = loadServed(file, file.login)
	if (Result.isFailure(loaded)) {
		throw new Error("a served file its compile wrote does not load", { cause: loaded.failure })
	}
	const found = defined(
		Option.getOrUndefined(Arr.findFirst(loaded.success.roles, (r) => r.name === role)),
		`role ${role} of the served file`
	)
	return new Map(Arr.map(found.members, (m): readonly [string, LoadedMember] => [m.name, m]))
}

/**
 * Whether the Db's two artifacts of the read `read` makes deliver the same (see the header, and sameDelivery). `read`
 * reads through the operations of the members it names as the Db's read did, a paged read also requesting the pages
 * after and before every cursor its pages reached, each side's run on its own executor over `ctx` (memberOpsOn). A read
 * the Db answered that either artifact refuses here is an answer no observation names, so it is raised as a defect of
 * the run.
 */
export const artifactsAgree = <E>(
	ctx: ServedDbContext,
	members: SidedMembers,
	read: (operations: (name: string) => ServedOps<unknown>) => Effect.Effect<Delivery, E>
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const meeting = yield* Ref.make<Meeting>({ kind: "open" })
		const sideRead = (side: Side) => {
			const executor = executorAt(ctx, meeting, side)
			return Effect.ensuring(
				read((name) =>
					memberOpsOn(executor, ctx, defined(members[side].get(name), `the ${side} member ${name}`))
				),
				finished(ctx, meeting, side)
			)
		}
		const [optimized, conservative] = yield* Effect.orDie(
			Effect.all([sideRead("optimized"), sideRead("conservative")], { concurrency: "unbounded" })
		)
		return sameDelivery(optimized, conservative)
	})
