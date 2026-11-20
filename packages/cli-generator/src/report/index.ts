import { Array as Arr, Order, Predicate, Record } from "effect"
import { printJson } from "#emit/printer.ts"
import type { DocumentUri } from "#model/brands.ts"
import { isRefusal, pointerOrder } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { Sha256Hex } from "#model/digest.ts"
import type { Api, Operation, SecurityScheme } from "#model/entities.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { NonStandardChoice, NonStandardUse } from "#model/non-standard.ts"
import { markedUses, nonStandardUses } from "#model/non-standard.ts"
import type { Json, JsonPointer } from "#model/pointer.ts"
import { documentLabel } from "#model/uri.ts"
import type { CommandNameSource, GroupNameSource } from "#names/plan.ts"

/**
 * One emitted command (design 8.1 `commandNames`): its visible path (group names, then the
 * command), the operation's use site, the source of each name, and for an alias command its index
 * in the author-config `aliases` or else in `x-forge-aliases`.
 */
export type CommandName = {
	readonly alias?: number
	readonly command: CommandNameSource
	readonly document: DocumentUri
	readonly group: GroupNameSource
	readonly path: ReadonlyArray<string>
	readonly pointer: JsonPointer
}

/**
 * One element the author config made non-standard (design 8.1 `nonStandard`, 6.1): the choice and
 * the config key that made it, the element's use site, and the row it departs from.
 */
type NonStandardEntry = {
	readonly choice: NonStandardChoice
	readonly configKey: `nonStandard.${NonStandardChoice}`
	readonly document: DocumentUri
	readonly pointer: JsonPointer
	readonly row: "PRM-27"
}

/**
 * One operation the author config skipped (`naming.operations[<id>].skip`, or `naming.byPointer`
 * for an operation with no operationId; design 8.2): a recorded choice, not a refusal, so it has no
 * command and coverage counts it and its subtree as accounted for. `operationId` is absent for an
 * operation keyed by pointer.
 */
type SkippedOperation = {
	readonly document: DocumentUri
	readonly operationId?: string
	readonly pointer: JsonPointer
	readonly reason: "config-skip"
}

/**
 * `generation-report.json` (design 8.1, 3.7): what one run refused, noticed, renamed and accepted,
 * and the digests of its inputs, each a digest the generator computed (Sha256Hex). There is no
 * timestamp, so equal inputs give equal bytes. Fields are alphabetical; the order that matters is
 * carried by arrays. It is JSON as it stands, so printing it cannot fail.
 */
export type GenerationReport = {
	readonly acceptedServers: ReadonlyArray<string>
	/** Present only when the author config added a scheme (D-OQ3 (b)): the scheme and the key that added it. */
	readonly authorSuppliedSchemes?: ReadonlyArray<{ readonly key: string; readonly name: string }>
	readonly commandNames: ReadonlyArray<CommandName>
	readonly generator: { readonly version: string }
	readonly inputs: ReadonlyArray<{ readonly document: DocumentUri; readonly sha256: Sha256Hex }>
	/** Always present, empty unless the author config switched a non-standard choice on. */
	readonly nonStandard: ReadonlyArray<NonStandardEntry>
	readonly notices: ReadonlyArray<Diagnostic>
	readonly refusals: ReadonlyArray<Diagnostic>
	readonly renames: ReadonlyArray<{
		readonly from: string
		readonly pointer: JsonPointer
		readonly to: string
	}>
	/** Always present, empty unless the author config skipped an operation. */
	readonly skipped: ReadonlyArray<SkippedOperation>
}

/**
 * What one run knows. `diagnostics` arrive already in diagnostic order (design 3.7), `inputs` in
 * document order and `commandNames` in command order; the report keeps each order.
 */
export interface GenerationReportInput {
	readonly acceptedServers: GenerationReport["acceptedServers"]
	/** The emitted commands in command order; absent, the run emitted none. */
	readonly commandNames?: GenerationReport["commandNames"]
	readonly diagnostics: readonly Diagnostic[]
	readonly inputs: GenerationReport["inputs"]
	/** The non-standard elements in diagnostic order; absent, none. */
	readonly nonStandard?: GenerationReport["nonStandard"]
	readonly renames: GenerationReport["renames"]
	readonly schemes?: readonly SecurityScheme[]
	/** The author-skipped operations in diagnostic order; absent, none. */
	readonly skipped?: GenerationReport["skipped"]
	readonly version: string
}

/**
 * How a generator run ended, as far as the exit status is concerned: output was written (with
 * these diagnostics, under `--strict` or not), or another run holds the output directory's lock.
 */
export type GeneratorOutcome =
	| {
			readonly _tag: "Written"
			readonly diagnostics: readonly Diagnostic[]
			readonly strict: boolean
	  }
	| { readonly _tag: "LockHeld" }

/** Diagnostic order (design 3.7) over use sites: document index, then pointer. */
interface UseSite {
	readonly document: string
	readonly pointer: string
}

const useSiteOrder = (documents: readonly string[]): Order.Order<UseSite> =>
	Order.combine(
		Order.mapInput(Order.Number, (entry: UseSite) => {
			const index = documents.indexOf(entry.document)

			return index === -1 ? documents.length : index
		}),
		Order.mapInput(pointerOrder, (entry: UseSite) => entry.pointer)
	)

const entryAt = ({ choice, origin }: NonStandardUse): NonStandardEntry => ({
	choice,
	configKey: `nonStandard.${choice}`,
	document: origin.document,
	pointer: origin.pointer,
	row: "PRM-27"
})

/**
 * The elements of the normalized model that carry the non-standard marker (design 6.1): query
 * parameters, and form Encoding entries of bodies and of `querystring` form content, that the
 * author config sends in the bracket convention (`deepObjectBrackets`) or whose scalar value it
 * sends as `name=value` (`deepObjectScalars`). The markers are read as the model holds them, never
 * inferred; a model with none lists none. An element both switches mark is listed once per
 * choice. Entries are in diagnostic order over `documents`, then by choice.
 */
export const nonStandardEntries = (
	api: Api,
	documents: readonly string[]
): GenerationReport["nonStandard"] => {
	const marked = Arr.flatMap(api.operations, (operation) => [
		...Arr.flatMap(operation.parameters, ({ serialization }) => nonStandardUses(serialization)),
		...Arr.flatMap(operation.body?.alternatives ?? [], (alternative) =>
			Arr.flatMap(alternative.encoding, markedUses)
		)
	])

	return Arr.sort(
		Arr.map(marked, entryAt),
		Order.combine(
			useSiteOrder(documents),
			Order.mapInput(Order.String, (entry: NonStandardEntry) => entry.choice)
		)
	)
}

/**
 * The report entries for the operations the author config skipped, in diagnostic order over
 * `documents`. Which operations are skipped is the names plan's rule; the caller passes them.
 */
export const skippedEntries = (
	operations: readonly Operation[],
	documents: readonly string[]
): GenerationReport["skipped"] =>
	Arr.sort(
		Arr.map(operations, ({ operationId, origin }): SkippedOperation => ({
			document: origin.document,
			...(operationId === undefined ? {} : { operationId }),
			pointer: origin.pointer,
			reason: "config-skip"
		})),
		useSiteOrder(documents)
	)

/**
 * Splits the diagnostics by severity into the report value, keeping their order.
 */
export const makeGenerationReport = (input: GenerationReportInput): GenerationReport => {
	const added = Arr.map(
		Arr.filter(input.schemes ?? [], (scheme) => scheme.source === "author-supplied"),
		(scheme) => ({ key: `security.add.schemes.${scheme.name}`, name: scheme.name })
	)

	const report: GenerationReport = {
		acceptedServers: input.acceptedServers,
		commandNames: input.commandNames ?? [],
		generator: { version: input.version },
		inputs: input.inputs,
		nonStandard: input.nonStandard ?? [],
		notices: Arr.filter(input.diagnostics, (diagnostic) => !isRefusal(diagnostic)),
		refusals: Arr.filter(input.diagnostics, isRefusal),
		renames: input.renames,
		skipped: input.skipped ?? []
	}

	return added.length === 0 ? report : { ...report, authorSuppliedSchemes: added }
}

/**
 * A report's JSON with every document it names (each `document` member: an input, a command, a
 * non-standard element, a skipped operation, a diagnostic and its related origins) written as its
 * label against the entry (model/uri.ts documentLabel), so the file names no host path and two runs
 * over the same inputs from different directories write the same bytes.
 */
const labelled = (value: Json, entry: string): Json =>
	isArray(value)
		? Arr.map(value, (item) => labelled(item, entry))
		: isObject(value)
			? Record.map(value, (member, key) =>
					key === "document" && Predicate.isString(member)
						? documentLabel(entry, member)
						: labelled(member, entry)
				)
			: value

/**
 * Prints the report file, its documents labelled against the run's entry document (`labelled`), in
 * the `docs/printer.md` JSON layout, with sorted keys and a final newline.
 */
export const printGenerationReport = (report: GenerationReport, entry: DocumentUri): string =>
	printJson(labelled(report, entry))

/**
 * Design 8.1: 0 when output was written, 1 on a document refusal, on any refusal under `--strict`,
 * and on a held lock.
 */
export const generatorExitStatus = (outcome: GeneratorOutcome): 0 | 1 => {
	if (outcome._tag === "LockHeld") {
		return 1
	}

	const refusals = Arr.filter(outcome.diagnostics, isRefusal)

	if (Arr.some(refusals, (diagnostic) => diagnostic.scope === "document")) {
		return 1
	}

	return outcome.strict && refusals.length > 0 ? 1 : 0
}
