import { Effect, Predicate, Record as Rec } from "effect"
import { type Codebook, codeNames } from "#compiler/ir/codes.ts"
import { isDrawn, type Sendable } from "#test/support/laws/model.ts"
import type { FieldDomain, HostFact, HostValue } from "#test/support/worlds/model/types.ts"

import { regex } from "arkregex"
/** Whether a field's integer values are int8 on the host, so a host number is passed as a bigint. */
export const isWide = (domain: FieldDomain): boolean =>
	(domain.kind === "integer" && domain.bits === 64) ||
	(domain.kind === "contract" && domain.bits === 64) ||
	(domain.kind === "serial" && domain.bits === 64) ||
	(domain.kind === "span" && domain.bits === 64)

/**
 * A host value the executor hands the real system: any value but a draw, which no writer can name (draws.ts
 * nameableFacts), so a draw here is a defect of whatever drew the action.
 */
export const sendable = (value: HostValue): Sendable => {
	if (isDrawn(value)) {
		throw new Error(
			`the executor was handed draw #${value.draw}, a value an identity drew that no writer has seen`
		)
	}
	return value
}

/**
 * A host value as grizzle's carrier of a field's domain, the one way the executor hands grizzle a model value: an
 * int8's number as a bigint, a wide span's endpoints too.
 */
export const carrierOf = (domain: FieldDomain, value: HostValue): unknown => {
	const given = sendable(value)
	if (!isWide(domain)) {
		return given
	}
	if (typeof given === "number") {
		return BigInt(given)
	}
	if (typeof given === "object") {
		return { start: BigInt(given.start), end: BigInt(given.end) }
	}
	return given
}

/**
 * What the executor reads back into the model's host values, strictly: a value grizzle decoded (a row, a witness key),
 * or a cell's output text a direct writer read. A value of another shape is a defect of the run, never a value: the
 * model's domains are text, uuid, the integer types, boolean, a closed handle and an integer span.
 */
const refused = (what: string, value: unknown): Effect.Effect<never> =>
	Effect.die(
		new Error(`the executor reads ${what}, which is no host value of the model: ${String(value)}`)
	)

const numberOf = (n: bigint, what: string): Effect.Effect<number> => {
	const value = Number(n)
	return Number.isSafeInteger(value)
		? Effect.succeed(value)
		: refused(`${what} past the safe integers`, n)
}

/** A value grizzle decoded: text, a number, a bigint the model holds as a number, a boolean, or a span. */
const valueOfCarrier = (cell: unknown, what: string): Effect.Effect<HostValue> => {
	if (typeof cell === "string" || typeof cell === "boolean") {
		return Effect.succeed(cell)
	}
	if (typeof cell === "number") {
		return Number.isSafeInteger(cell) ? Effect.succeed(cell) : refused(what, cell)
	}
	if (typeof cell === "bigint") {
		return numberOf(cell, what)
	}
	if (
		Predicate.isObject(cell) &&
		Predicate.hasProperty(cell, "start") &&
		Predicate.hasProperty(cell, "end")
	) {
		const { start, end } = cell
		return Effect.gen(function* () {
			const s = yield* valueOfCarrier(start, `${what} start`)
			const e = yield* valueOfCarrier(end, `${what} end`)
			return typeof s === "number" && typeof e === "number"
				? { start: s, end: e }
				: yield* refused(what, cell)
		})
	}
	return refused(what, cell)
}

/** A row grizzle decoded, read as a fact of exactly `fields`. */
export const factOfRow = (
	row: unknown,
	fields: ReadonlyArray<string>,
	what: string
): Effect.Effect<HostFact> =>
	Predicate.isObject(row)
		? Effect.map(
				Effect.forEach(fields, (field) =>
					Predicate.hasProperty(row, field)
						? Effect.map(
								valueOfCarrier(row[field], `${what}.${field}`),
								(value) => [field, value] as const
							)
						: refused(`${what} without ${field}`, row)
				),
				Rec.fromEntries
			)
		: refused(what, row)

/** A witness key's values, read as a fact of the fields it names. */
export const factOfKey = (values: unknown, what: string): Effect.Effect<HostFact> =>
	Predicate.isObject(values) ? factOfRow(values, Rec.keys(values), what) : refused(what, values)

const integerText = regex("^-?(0|[1-9][0-9]*)$")
const spanText = regex("^\\[(-?[0-9]+),(-?[0-9]+)\\)$")

const integerOf = (text: string, what: string): Effect.Effect<number> =>
	integerText.test(text) ? numberOf(BigInt(text), what) : refused(what, text)

/**
 * A cell's output text as its field's domain spells it. A closed id's column holds its handle's code, a smallint
 * under its roster's domain, and `codes`, the installation's codebook, names the live handle each code stands for
 * (ir/codes.ts): a hole or a code past the roster is no host value.
 */
export const valueOfText = (
	domain: FieldDomain,
	text: string,
	what: string,
	codes: Codebook
): Effect.Effect<HostValue> => {
	switch (domain.kind) {
		case "uuid":
		case "text":
			return Effect.succeed(text)
		case "handle":
			return Effect.flatMap(integerOf(text, what), (code) => {
				const handle = codeNames(codes)(domain.closed)[code]
				return handle === undefined || handle === "" ? refused(what, text) : Effect.succeed(handle)
			})
		case "integer":
		case "serial":
		case "contract":
			return integerOf(text, what)
		case "boolean":
			return text === "t"
				? Effect.succeed(true)
				: text === "f"
					? Effect.succeed(false)
					: refused(what, text)
		case "span": {
			const match = spanText.exec(text)
			const [, start, end] = match ?? []
			return start === undefined || end === undefined
				? refused(what, text)
				: Effect.gen(function* () {
						return { start: yield* integerOf(start, what), end: yield* integerOf(end, what) }
					})
		}
	}
}
