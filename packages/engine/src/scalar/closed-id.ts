import { codeColumn } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { isValidText } from "#compiler/core/text.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { carrierSql, defineField, type ScalarEnv } from "#compiler/scalar/registry.ts"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !isList(value)

/** The name and roster of a closed relation as the caller's value holds them, the roster in declared order: never empty. */
interface ClosedRoster {
	readonly closed: string
	readonly handles: NonEmptyReadonlyArray<string>
}

/** The roster the caller's value holds, read once: everything after it reads the admitted copy only. */
const readRoster = (closed: unknown): Result.Result<ClosedRoster, CompileError> => {
	if (!isRecord(closed) || closed["kind"] !== "closed") {
		return Result.err(
			malformedDescription(
				captureLoc("closedId", []),
				"a closed relation, built by closed(name, handles)"
			)
		)
	}
	const { name, handles } = closed
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
	return Result.ok(Object.freeze({ closed: name, handles: Object.freeze(admitted) }))
}

/**
 * What the admission core decided: the roster, the reference's Description and location, and the environment that
 * resolves the roster by name.
 */
interface ClosedIdParts {
	readonly roster: ClosedRoster
	readonly desc: FieldDesc
	readonly loc: SourceLoc
	readonly env: ScalarEnv
}

/**
 * The admission core of closedId: a JavaScript caller can pass anything. Reading its value can run its code (a proxy's
 * traps, a getter), so it is read once through hostRead, and a value whose reading throws is refused like any other
 * value that is no closed relation.
 */
export const closedIdParts = (closed: unknown): ClosedIdParts => {
	const read = hostRead(
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
	return {
		roster,
		desc: { kind: "closedId", roster: roster.closed },
		loc: SourceLoc(`closedId(${roster.closed})`, []),
		env: {
			kind: "builder",
			roster: (name) => (name === roster.closed ? new Roster(name, roster.handles) : undefined)
		}
	}
}

/**
 * closedId(C): a reference to a closed relation's roster.
 *
 * The field's values are C's handles, stored as their codes, a smallint under the roster's domain, whose order is the
 * roster's declared order, which is comparison order and part of the type's identity. A closedId keeps its particular
 * roster identity: two rosters with equal handles are different types. The descriptor holds the closed
 * relation itself as `roster`, and its Description names the roster by the closed relation's name, which ownership
 * resolves.
 *
 * closedId reads only what a closed relation is: kind "closed", a nonempty name, and a nonempty
 * list of distinct nonempty handles, each storable text. Anything else from a JavaScript caller is
 * MalformedDescription, a value whose reading throws (a refusing proxy, a throwing getter) among them.
 *
 * The descriptor of the admission core, for a JavaScript caller: it holds the closed relation it was given, and its
 * column is the admitted roster's handles. The public closedId (public/fields.ts) builds the same descriptor with the
 * column typed by the closed relation's literal handles.
 */
export const admittedClosedId = (closed: unknown) => {
	const parts = closedIdParts(closed)
	return defineField(
		{},
		carrierSql.code,
		parts.desc,
		{ roster: closed, column: codeColumn(parts.roster.closed, parts.roster.handles) },
		parts.loc,
		parts.env
	)
}
