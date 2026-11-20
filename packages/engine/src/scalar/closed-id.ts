import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { codeColumn } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription, ruleRefused } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isList } from "#compiler/core/record.ts"
import { isValidText } from "#compiler/core/text.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { handlesInOrder, Roster, type RosterHandles, rosterOrders } from "#compiler/ir/scalar.ts"
import {
	carrierSql,
	defineField,
	type RosterLookup,
	type ScalarEnv
} from "#compiler/scalar/registry.ts"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !isList(value)

/**
 * The name, order and handles of a roster as the caller's value holds them, the handles in its order (ir/scalar.ts
 * handlesInOrder): never empty.
 */
interface ClosedRoster extends RosterHandles {
	readonly closed: string
}

/** The roster the caller's value holds, read once: everything after it reads the admitted copy only. */
const readRoster = (closed: unknown): Result.Result<ClosedRoster, CompileError> => {
	if (!isRecord(closed) || closed["kind"] !== "closed") {
		return Result.err(
			malformedDescription(
				captureLoc("closedId", []),
				"a closed relation, built by closed.ordered(name, handles) or closed.unordered(name, handles)"
			)
		)
	}
	const { name, handles, order } = closed
	const stated = rosterOrders.find((o) => o === order)
	if (stated === undefined) {
		return Result.err(
			malformedDescription(
				captureLoc("closedId", []),
				`a closed relation of a roster order, one of ${rosterOrders.join(", ")}`
			)
		)
	}
	if (typeof name !== "string" || name.length === 0 || !isValidText(name)) {
		return Result.err(
			malformedDescription(captureLoc("closedId", []), "a closed relation with a nonempty name")
		)
	}
	if (!isList(handles)) {
		return Result.err(
			malformedDescription(
				captureLoc("closedId", []),
				"a closed relation with a nonempty roster of handles"
			)
		)
	}
	const seen = new Set<string>()
	const roster: ReadonlyArray<unknown> = handles
	for (const handle of roster) {
		if (typeof handle !== "string" || handle.length === 0 || !isValidText(handle)) {
			return Result.err(
				malformedDescription(
					captureLoc("closedId", []),
					"roster handles that are nonempty storable strings"
				)
			)
		}
		if (seen.has(handle)) {
			return Result.err(
				malformedDescription(captureLoc("closedId", []), "roster handles without repeats")
			)
		}
		seen.add(handle)
	}
	const [first, ...rest] = seen
	if (first === undefined) {
		return Result.err(
			malformedDescription(
				captureLoc("closedId", []),
				"a closed relation with a nonempty roster of handles"
			)
		)
	}
	const admitted: NonEmptyReadonlyArray<string> = [first, ...rest]
	return Result.ok(
		Object.freeze({
			closed: name,
			order: stated,
			handles: Object.freeze(handlesInOrder(stated, admitted))
		})
	)
}

/**
 * What the admission core decided: the roster, the handles of it the reference holds (`only`, in the roster's order;
 * none for every handle), the reference's Description and location, and the environment that resolves the roster by
 * name.
 */
export interface ClosedIdParts {
	readonly roster: ClosedRoster
	readonly only: NonEmptyReadonlyArray<string> | undefined
	readonly desc: FieldDesc
	readonly loc: SourceLoc
	readonly env: ScalarEnv
}

/**
 * The parts of a closed id over `roster` holding `only` (readSubset), whose environment resolves the roster's name by
 * `typed`.
 */
const partsOf = (
	roster: ClosedRoster,
	only: NonEmptyReadonlyArray<string> | undefined,
	typed: RosterLookup
): ClosedIdParts => ({
	roster,
	only,
	desc: { kind: "closedId", roster: roster.closed, only },
	loc: SourceLoc(`closedId(${roster.closed})`, []),
	env: { kind: "builder", roster: typed }
})

const subsetRefused = (what: string): CompileError =>
	malformedDescription(captureLoc("closedId", []), what)

/**
 * The handles of `roster` a closed id's subset states, read once: none where the caller states none, and otherwise
 * `{ only }` or `{ except }`, a nonempty list of the roster's handles, each once, `except` leaving some handle. Its
 * handles are held in the roster's order, so two spellings of one subset are one, and a subset of every handle is the
 * closed id of the whole roster, none.
 */
const readSubset = (
	roster: ClosedRoster,
	subset: unknown
): Result.Result<NonEmptyReadonlyArray<string> | undefined, CompileError> => {
	if (subset === undefined) {
		return Result.ok(undefined)
	}
	if (!isRecord(subset) || Object.keys(subset).length !== 1) {
		return Result.err(
			subsetRefused("a closed id's subset as { only: handles } or { except: handles }")
		)
	}
	const only = subset["only"]
	const except = subset["except"]
	const listed = only === undefined ? except : only
	if (!isList(listed) || listed.length === 0) {
		return Result.err(subsetRefused("a closed id's subset of a nonempty list of handles"))
	}
	const live = new Set<string>(roster.handles)
	const named = new Set<string>()
	for (const handle of listed) {
		if (typeof handle !== "string" || !live.has(handle)) {
			return Result.err(subsetRefused(`a closed id's subset of handles of ${roster.closed}`))
		}
		if (named.has(handle)) {
			return Result.err(
				ruleRefused(captureLoc("closedId", []), "a closed id's subset lists each handle once")
			)
		}
		named.add(handle)
	}
	const held =
		only === undefined
			? roster.handles.filter((handle) => !named.has(handle))
			: roster.handles.filter((handle) => named.has(handle))
	const [first, ...rest] = held
	if (first === undefined) {
		return Result.err(
			ruleRefused(
				captureLoc("closedId", []),
				"a closed id's subset holds some handle: except leaves none"
			)
		)
	}
	return Result.ok(
		held.length === roster.handles.length ? undefined : Object.freeze([first, ...rest])
	)
}

/**
 * The subset the arguments after a closed id's roster state of `roster`, none or one, read through hostRead, or its
 * refusal thrown.
 */
const subsetOf = (
	roster: ClosedRoster,
	rest: ReadonlyArray<unknown>
): NonEmptyReadonlyArray<string> | undefined => {
	if (rest.length > 1) {
		throw subsetRefused("closedId(roster) or closedId(roster, { only } or { except })")
	}
	const [subset] = rest
	const read = hostRead(
		() => subsetRefused("a closed id's subset whose properties can be read: no refusing proxy"),
		() => readSubset(roster, subset)
	)
	if (!read.ok) {
		throw read.error
	}
	return read.value
}

/**
 * The admission core of closedId for a JavaScript look-alike of a roster: a JavaScript caller can pass anything.
 * Reading its value can run its code (a proxy's traps, a getter), so it is read once through hostRead, and a value whose
 * reading throws is refused like any other value that is no closed relation. `rest` is the arguments after the roster:
 * none, or the subset the caller states (readSubset).
 */
export const closedIdParts = (closed: unknown, rest: ReadonlyArray<unknown>): ClosedIdParts => {
	const read = hostRead(
		() =>
			malformedDescription(
				captureLoc("closedId", []),
				"a closed relation whose properties can be read: no refusing proxy"
			),
		() => readRoster(closed)
	)
	if (!read.ok) {
		throw read.error
	}
	const roster = read.value
	return partsOf(roster, subsetOf(roster, rest), (name) =>
		name === roster.closed ? Roster.of(name, roster.order, roster.handles) : undefined
	)
}

/**
 * The parts of a closed id over a roster closed.ordered(name, handles) or closed.unordered(name, handles) built: the
 * name, order and handles its admission read, the subset of them the arguments after the roster state (readSubset),
 * and the roster it typed once, absent when its name is no declared name, which the registry refuses before it resolves
 * one (scalar/registry.ts rosterAt).
 */
export const builtRosterParts = (
	closed: string,
	roster: RosterHandles,
	rest: ReadonlyArray<unknown>,
	typed: Roster | undefined
): ClosedIdParts => {
	const admitted = { closed, order: roster.order, handles: roster.handles }
	return partsOf(admitted, subsetOf(admitted, rest), (name) =>
		typed?.closed === name ? typed : undefined
	)
}

/**
 * closedId(C): a reference to a closed relation's roster.
 *
 * The field's values are C's handles, stored as their codes, a smallint under the roster's domain. An ordered roster's
 * closed id is ordered by its declared order, which is comparison order; an unordered roster's has no order, so its
 * type lacks ordering and minMax (scalar/registry.ts closedIdCapabilities). A closedId keeps its particular roster
 * identity: two rosters with equal handles are different types. The descriptor holds the closed
 * relation itself as `roster`, and its Description names the roster by the closed relation's name, which ownership
 * resolves, and the subset it holds, `only`, where it holds no more than some of the handles: the column delivers those,
 * every stored column of it is held to them by a CHECK (physical/closed/storage.ts), and the codec refuses any other
 * handle before any SQL (codec/scalar.ts).
 *
 * closedId reads only what a closed relation is: kind "closed", a nonempty name, a roster order, and a nonempty
 * list of distinct nonempty handles, each storable text. Anything else from a JavaScript caller is
 * MalformedDescription, a value whose reading throws (a refusing proxy, a throwing getter) among them.
 *
 * The descriptor over `closed`, whose parts its admission decided (schema/relation.ts closedIdOf): it holds the closed
 * relation it was given, and its column is the handles it holds, its subset's or the admitted roster's. The public closedId (public/fields.ts) builds
 * the same descriptor with the column typed by the closed relation's literal handles, and admittedClosedId
 * (schema/relation.ts) builds it for a caller that holds none.
 */
export const closedIdField = (closed: unknown, parts: ClosedIdParts) =>
	defineField(
		{},
		carrierSql.code,
		parts.desc,
		{ roster: closed, column: codeColumn(parts.roster.closed, parts.only ?? parts.roster.handles) },
		parts.loc,
		parts.env
	)
