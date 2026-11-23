import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Result } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls, readCallOf } from "#adapter/db/handles.ts"
import { toResult } from "#adapter/engine.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import type { DecodedRow } from "#adapter/reader/stream.ts"
import { type LoadedMember, loadServed } from "#adapter/served/load.ts"
import type { BatchStatement } from "#adapter/wire/batch.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { KeyFields } from "#compiler/live/index.ts"
import { queryDescOf } from "#compiler/schema/protocol.ts"
import type { ServedFile, ServedMember } from "#compiler/served/forms.ts"
import { servedSource } from "#compiler/served/read.ts"
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
 * state (Delivery): a read's rows as one keyed set, and a paged read's windows one by one, each window's rows in order,
 * over every window it reaches from the start or the end and the windows after and before every row those windows
 * delivered. Rows that differ, or that either artifact repeats, are `artifacts-disagree`, a defect no model branch
 * allows.
 *
 * The check reads through the members of two served files over the Db's own context (adapter/db/handles.ts readCallOf),
 * as the Db runs a member. One is the file the Db's read was served from, so it runs the very statements and windows
 * the Db's read ran. The other is that file with every read's statements its conservative lowering and every page's
 * artifact its conservative page artifact (conservativeServed), loaded as a layer loads a file. Each statement of
 * either is a read of its own, as the Db reads (read-calls.ts flown), at the one state no writer moves while the action
 * reads: a worlds action runs alone.
 */
type Side = "optimized" | "conservative"

/**
 * A read member as one side reads it: the key fields its rows are keyed by (a paged member's, its completed order's),
 * and a call's rows, decoded in delivery order, its statement sent through the side's meeting.
 */
export interface MemberReader {
	readonly fields: KeyFields
	readonly read: (input: unknown) => Effect.Effect<ReadonlyArray<DecodedRow>, ReadError>
}

/** `member` read on one side, its statements sent by `send`: a member that is no read is a defect of the run. */
export const readerOf = (
	member: LoadedMember,
	send: (statement: BatchStatement) => Effect.Effect<unknown, ReadError>
): MemberReader => {
	const parse = readCallOf(member)
	if (Option.isNone(parse) || member.kind === "change") {
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
 * every row its windows reached, each side's statements sent over `ctx` (readerOf over flown). A read the Db answered
 * that either artifact refuses here is an answer no observation names, so it is raised as a defect of the run.
 */
export const artifactsAgree = <E>(
	ctx: ServedDbContext,
	members: SidedMembers,
	read: (reader: (name: string) => MemberReader) => Effect.Effect<Delivery, E>
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const sideRead = (side: Side) =>
			read((name) =>
				readerOf(defined(members[side].get(name), `the ${side} member ${name}`), (statement) =>
					flown(ctx, statement)
				)
			)
		const [optimized, conservative] = yield* Effect.orDie(
			Effect.all([sideRead("optimized"), sideRead("conservative")], { concurrency: "unbounded" })
		)
		return sameDelivery(optimized, conservative)
	})

/**
 * Whether a member's public once delivers what its flight does (sameDelivery): `read` reads through the member as the
 * Db's read did, once with each call's statement sent as a read of its own (readerOf over flown), and once through the
 * member's once (adapter/db/handles.ts memberCalls), its stream folded to its value, each call its own transaction at
 * the one state no writer moves between them. The flight's rows are the ones the differential holds to the model and to
 * the conservative artifact, so a once that agrees with them answers the model's rows. A once that fails where the
 * flight answered is a defect of the run.
 */
export const onceAgrees = <E>(
	ctx: ServedDbContext,
	member: LoadedMember,
	read: (reader: MemberReader) => Effect.Effect<Delivery, E>
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const flight = readerOf(member, (statement) => flown(ctx, statement))
		const viaFlight = yield* read(flight)
		const once = readOnce(memberCalls(ctx, member))
		const viaOnce = yield* read({
			fields: flight.fields,
			read: (input) => Effect.orDie(once(input))
		})
		return sameDelivery(viaFlight, viaOnce)
	}).pipe(Effect.orDie)
