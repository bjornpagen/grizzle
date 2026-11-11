import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { regex } from "arkregex"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Order,
	Runtime,
	Schema,
	String as Str,
	pipe
} from "effect"
import type { PlatformError } from "effect"

import { printJson } from "#emit/printer.ts"
import { JsonLiteral } from "#model/brands.ts"

/**
 * Inventory export: the element table of `oas-inventory.md` as the tracked `rows.json`.
 *
 * Bun tools/inventory-export.ts [--check] <inventory.md> <rows.json>
 */

const usage = "usage: bun tools/inventory-export.ts [--check] <inventory.md> <rows.json>"

/**
 * A bad command line: exit 2.
 */
export class ExportUsageError extends Schema.TaggedError<
	ExportUsageError,
	{ readonly brand: unique symbol }
>()("ExportUsageError", { reason: Schema.String }) {
	override readonly [Runtime.errorExitCode] = 2

	override readonly [Runtime.errorReported] = true

	override get message(): string {
		return `${this.reason}\n${usage}`
	}
}

/**
 * A file that cannot be read or written: exit 1.
 */
export class ExportFileError extends Schema.TaggedError<
	ExportFileError,
	{ readonly brand: unique symbol }
>()("ExportFileError", { file: Schema.String, reason: Schema.String }) {
	override readonly [Runtime.errorExitCode] = 1

	override readonly [Runtime.errorReported] = true

	override get message(): string {
		return `${this.file}: ${this.reason}`
	}
}

/**
 * A row the export refuses; `row` is the inventory id: exit 1.
 */
export class ExportRowError extends Schema.TaggedError<
	ExportRowError,
	{ readonly brand: unique symbol }
>()("ExportRowError", { row: Schema.String, reason: Schema.String }) {
	override readonly [Runtime.errorExitCode] = 1

	override readonly [Runtime.errorReported] = true

	override get message(): string {
		return `${this.row}: ${this.reason}`
	}
}

/**
 * `--check` found the rows file different from the inventory: exit 1.
 */
export class ExportCheckFailed extends Schema.TaggedError<
	ExportCheckFailed,
	{ readonly brand: unique symbol }
>()("ExportCheckFailed", { file: Schema.String, reason: Schema.String }) {
	override readonly [Runtime.errorExitCode] = 1

	override readonly [Runtime.errorReported] = true

	override get message(): string {
		return `${this.file}: ${this.reason}`
	}
}

const dispositions = ["implemented", "refused", "informational"] as const

type Disposition = (typeof dispositions)[number]

export interface ExportRow {
	readonly coveredBy: readonly string[]
	readonly disposition: Disposition
	readonly id: string
	readonly versions: readonly string[]
}

const rowLine = regex("^\\| `(?<id>[A-Z][A-Z0-9]*-[0-9]+)` ", "u")

const idList = regex("^[A-Z][A-Z0-9]*-[0-9]+(?:, [A-Z][A-Z0-9]*-[0-9]+)*$", "u")

const idStart = regex("^[A-Z][A-Z0-9]*-[0-9]+", "u")

const globOrRange = regex("[A-Z][A-Z0-9]*-\\*|[A-Z][A-Z0-9]*-[0-9]+\\.\\.", "u")

const leadingBar = regex("^\\| ", "u")

const trailingBar = regex(" \\|$", "u")

const seeClause = regex("\\bsee (?<clause>[^;]*)", "gu")

const coveredMarker = "covered by: "

const isDisposition = (cell: string): cell is Disposition =>
	Arr.some(dispositions, (value) => value === cell)

/**
 * The text of a `covered by:` clause: up to the first `;`, or the `. src:` that closes the cell.
 */
const coveredClause = (reason: string): Option.Option<string> =>
	Option.map(Str.indexOf(coveredMarker)(reason), (at) => {
		const rest = Str.slice(at + coveredMarker.length)(reason)

		return Arr.match(Arr.getSomes([Str.indexOf(";")(rest), Str.indexOf(". src:")(rest)]), {
			onEmpty: () => rest,
			onNonEmpty: (ends) => Str.slice(0, Arr.min(ends, Order.Number))(rest)
		})
	})

/**
 * Whether a `see` clause of the reason does not start with a row id, or holds a glob or a range.
 */
const hasBadSeeClause = (reason: string): boolean =>
	Arr.some(Arr.fromIterable(Str.matchAll(seeClause)(reason)), (match) => {
		const clause = Arr.headNonEmpty(Str.split(". src:")(match.groups?.["clause"] ?? ""))

		return !idStart.test(clause) || globOrRange.test(clause)
	})

const parseRow = (line: string): Effect.Effect<Option.Option<ExportRow>, ExportRowError> => {
	const id = rowLine.exec(line)?.groups.id

	if (id === undefined) {
		return Effect.succeedNone
	}

	const cells = Arr.map(
		Str.split(" | ")(
			pipe(line, Str.trimEnd, Str.replace(leadingBar, ""), Str.replace(trailingBar, ""))
		),
		Str.trim
	)

	if (cells.length !== 6) {
		return Effect.succeedNone
	}

	const versions = cells[1] ?? ""
	const disposition = cells[4] ?? ""
	const reason = cells[5] ?? ""

	if (!isDisposition(disposition)) {
		return Effect.fail(
			ExportRowError.make({ reason: `unknown disposition \`${disposition}\``, row: id })
		)
	}

	const clause = coveredClause(reason)

	if (Option.isSome(clause) && !idList.test(clause.value)) {
		return Effect.fail(
			ExportRowError.make({ reason: "a `covered by:` clause holds only row ids", row: id })
		)
	}

	if (disposition !== "informational" && hasBadSeeClause(reason)) {
		return Effect.fail(
			ExportRowError.make({
				reason: "a `see` clause names row ids, never a glob, a range or prose",
				row: id
			})
		)
	}

	return Effect.succeedSome({
		coveredBy: Option.match(clause, { onNone: () => [], onSome: Str.split(", ") }),
		disposition,
		id,
		versions: Str.split(", ")(versions)
	})
}

/**
 * Parses the element table; a `covered by:` target must be an implemented or refused row.
 */
export const parseInventory = (text: string): Effect.Effect<readonly ExportRow[], ExportRowError> =>
	Effect.gen(function* parse() {
		const rows = yield* Effect.forEach(Str.split("\n")(text), parseRow)
		const parsed = Arr.getSomes(rows)

		const covering = new Set(
			Arr.map(
				Arr.filter(parsed, (row) => row.disposition !== "informational"),
				(row) => row.id
			)
		)

		for (const row of parsed) {
			const target = Arr.findFirst(row.coveredBy, (id) => !covering.has(id))

			if (Option.isSome(target)) {
				return yield* ExportRowError.make({
					reason: `\`covered by:\` names ${target.value}, which is not an implemented or refused row`,
					row: row.id
				})
			}
		}

		return parsed
	})

interface Options {
	readonly check: boolean
	readonly inventory: string
	readonly rows: string
}

const parseArgs = (args: readonly string[]): Effect.Effect<Options, ExportUsageError> => {
	const check = Arr.contains(args, "--check")
	const positional = Arr.filter(args, (arg) => arg !== "--check")
	const [inventory, rows] = positional

	if (positional.length !== 2 || inventory === undefined || rows === undefined) {
		return Effect.fail(ExportUsageError.make({ reason: "expected <inventory.md> and <rows.json>" }))
	}

	return Effect.succeed({ check, inventory, rows })
}

const fileError =
	(file: string) =>
	(cause: PlatformError.PlatformError): ExportFileError =>
		ExportFileError.make({ file, reason: cause.message })

const exportInventory = Effect.gen(function* run() {
	const fs = yield* FileSystem.FileSystem
	const options = yield* parseArgs(process.argv.slice(2))
	const text = yield* fs
		.readFileString(options.inventory)
		.pipe(Effect.mapError(fileError(options.inventory)))
	const rows = yield* parseInventory(text)
	const json = yield* Schema.decodeUnknownEffect(JsonLiteral)(rows).pipe(
		Effect.mapError(() =>
			ExportFileError.make({ file: options.inventory, reason: "rows are not JSON" })
		)
	)
	const output = printJson(json)

	if (options.check) {
		const current = yield* fs
			.readFileString(options.rows)
			.pipe(Effect.mapError(fileError(options.rows)))

		if (current !== output) {
			return yield* ExportCheckFailed.make({
				file: options.rows,
				reason: "differs from the inventory; rerun without --check"
			})
		}
	} else {
		yield* fs
			.writeFileString(options.rows, output)
			.pipe(
				Effect.mapError(fileError(options.rows)),
				Effect.andThen(Console.log(`${options.rows}: ${rows.length} rows`))
			)
	}
})

if (import.meta.main) {
	NodeRuntime.runMain(
		exportInventory.pipe(
			Effect.tapError((failure) => Console.error(failure.message)),
			Effect.provide(NodeServices.layer)
		)
	)
}
