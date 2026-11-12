import { Array as Arr, Deferred, Effect, Exit, Option, Ref, Result } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { onceCalls, readCallOf } from "#adapter/db/handles.ts"
import { toResult } from "#adapter/engine.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import type { DecodedRow } from "#adapter/reader/stream.ts"
import { type LoadedMember, loadServed } from "#adapter/served/load.ts"
import type { BatchOutcome, BatchStatement } from "#adapter/wire/batch.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { KeyFields } from "#compiler/live/index.ts"
import { queryDescOf } from "#compiler/schema/protocol.ts"
import type { ServedFile, ServedMember } from "#compiler/served/forms.ts"
import { servedSource } from "#compiler/served/read.ts"
import { defined } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import {
	compileTemplate,
	type FixtureSchema,
	type TestCompileOptions,
	testArtifacts
} from "#test/support/compile.ts"
import { conservativePageRuntime } from "#test/support/conservative.ts"
import { flown, readThrough } from "#test/support/read-calls.ts"
import { factKeySet, sameFact } from "#test/support/worlds/model/host.ts"
import type { HostFact } from "#test/support/worlds/model/types.ts"

/**
 * The differential of one read's two artifacts. Every read a Db serves is compiled by generate's compile into its
 * served file: the optimized artifact, which the Db runs, beside which the oracle lowers the same query conservatively,
 * resting on no evidence the context admits (test/support/conservative.ts). Both must deliver the same from the same
 * snapshot (Delivery): a read's rows as one keyed set, and a paged read's windows one by one, each window's rows in
 * order, over every window it reaches from the start or the end and the windows after and before every row those
 * windows delivered. Rows that differ, or that either artifact repeats, are `artifacts-disagree`, a defect no model
 * branch allows.
 *
 * The check reads through the members of two served files over the Db's own context (adapter/db/handles.ts
 * readCallOf), as the Db runs a member. One is the file the Db's read was served from, so it runs the very statements
 * and windows the Db's read ran. The other is that file with every read's statements its conservative lowering and every
 * page's artifact its conservative page artifact (conservativeServed), loaded as a layer loads a file. Their flights
 * meet: each pair of flights, one per artifact, is sent as one flight in one READ ONLY transaction of the Db's role and
 * claims on one leased session, the optimized statements first. Every read path (a read, every window, every anchored
 * window) sends its flights in turn, so the k-th flight of one artifact meets the k-th of the other. A flight left
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

/**
 * A read member as one side reads it: the key fields its rows are keyed by (a paged member's, its completed order's),
 * and a call's rows, decoded in delivery order, its statement sent through the side's meeting.
 */
export interface MemberReader {
	readonly fields: KeyFields
	readonly read: (input: unknown) => Effect.Effect<ReadonlyArray<DecodedRow>, ReadError>
}

/** `member` read on one side, its flights sent by `send`: a member that is no read is a defect of the run. */
export const readerOf = (
	member: LoadedMember,
	send: (statements: ReadonlyArray<BatchStatement>) => Effect.Effect<unknown, ReadError>
): MemberReader => {
	const parse = readCallOf(member)
	if (Option.isNone(parse) || member.kind === "change" || member.kind === "refresh") {
		throw new Error(`the read member ${member.name} loads as no read`)
	}
	return {
		fields: member.read.key.fields,
		read: (input) => Effect.flatMap(parse.value(input), (parsed) => readThrough(parsed.call, send))
	}
}

/**
 * What a read delivers, as the differential holds the two artifacts' deliveries to each other: a keyed set of facts
 * (a read, a key's, an attachment, a recursive read), or every window a paged read requested, in the order it
 * requested them, each its rows' facts in order.
 */
export type Delivery =
	| { readonly kind: "facts"; readonly facts: ReadonlyArray<HostFact> }
	| { readonly kind: "windows"; readonly windows: ReadonlyArray<ReadonlyArray<HostFact>> }

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

/** Whether two windows are one: the same facts in the same order. */
const sameWindow = (left: ReadonlyArray<HostFact>, right: ReadonlyArray<HostFact>): boolean =>
	left.length === right.length && Arr.every(Arr.zip(left, right), ([l, r]) => sameFact(l, r))

/**
 * Whether two deliveries agree: two keyed sets that are one set (sameSet), or two requests' windows that are, request
 * by request, one window (sameWindow).
 */
const sameDelivery = (left: Delivery, right: Delivery): boolean => {
	switch (left.kind) {
		case "facts":
			return right.kind === "facts" && sameSet(left.facts, right.facts)
		case "windows":
			return (
				right.kind === "windows" &&
				left.windows.length === right.windows.length &&
				Arr.every(Arr.zip(left.windows, right.windows), ([l, r]) => sameWindow(l, r))
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
				case "instant":
					throw new Error(
						`the conservative oracle compiles no clocked member, and ${member.name} is one`
					)
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
 * reads through the members it names as the Db's read did, a paged read also requesting the windows after and before
 * every row its windows reached, each side's flights sent through the meeting over `ctx` (readerOf). A read the Db
 * answered that either artifact refuses here is an answer no observation names, so it is raised as a defect of the
 * run.
 */
export const artifactsAgree = <E>(
	ctx: ServedDbContext,
	members: SidedMembers,
	read: (reader: (name: string) => MemberReader) => Effect.Effect<Delivery, E>
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const meeting = yield* Ref.make<Meeting>({ kind: "open" })
		const sideRead = (side: Side) => {
			const send = (statements: ReadonlyArray<BatchStatement>) =>
				arrive(ctx, meeting, side, statements)
			return Effect.ensuring(
				read((name) =>
					readerOf(defined(members[side].get(name), `the ${side} member ${name}`), send)
				),
				finished(ctx, meeting, side)
			)
		}
		const [optimized, conservative] = yield* Effect.orDie(
			Effect.all([sideRead("optimized"), sideRead("conservative")], { concurrency: "unbounded" })
		)
		return sameDelivery(optimized, conservative)
	})

/**
 * Whether a member's public once delivers what its flight does (sameDelivery): `read` reads through the member as the
 * Db's read did, once with each call's statement sent in a flight of its own (readerOf over flown), and once through the
 * member's once (adapter/db/handles.ts onceCalls), its stream folded to its value, each call its own transaction at
 * the one state no writer moves between them. The flight's rows are the ones the differential holds to the model and to
 * the conservative artifact, so a once that agrees with them answers the model's rows. A once that fails where the
 * flight answered is a defect of the run.
 *
 * Plant (~/.cache/grizzle-release/LIVE-WATCH/plants): stream-drop-first-row.patch (a read's stream drops its first
 * row) turns it red wherever a read delivers a row.
 */
export const onceAgrees = <E>(
	ctx: ServedDbContext,
	member: LoadedMember,
	read: (reader: MemberReader) => Effect.Effect<Delivery, E>
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const flight = readerOf(member, (statements) => flown(ctx, statements))
		const viaFlight = yield* read(flight)
		const once = readOnce(onceCalls(ctx, member))
		const viaOnce = yield* read({
			fields: flight.fields,
			read: (input) => Effect.orDie(once(input))
		})
		return sameDelivery(viaFlight, viaOnce)
	}).pipe(Effect.orDie)
