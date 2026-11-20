import { regex } from "arkregex"
import { Array as Arr, Data, Effect, Option, Order, Predicate, Record, String as Str } from "effect"
import { type DocumentUri, isDocumentUri } from "#model/brands.ts"
import { isRowId, type Origin, type RowId } from "#model/entities.ts"
import { isJsonPointer, type JsonPointer } from "#model/pointer.ts"

const codePattern = regex("^(?<row>[A-Z][A-Z0-9]*-[0-9]+)/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", "u")

/** The row a code names, its prefix before the slash, when the code has the code grammar. */
const rowOfCode = (code: string): Option.Option<RowId> =>
	Option.flatMap(
		Option.fromUndefinedOr(codePattern.exec(code)?.groups.row),
		Option.liftPredicate(isRowId)
	)

/**
 * How much a diagnostic covers: the whole document, one operation, one element, or one `field`
 * (design 8.5): a property of a request body alternative that stays generated.
 */
export const diagnosticScopes = ["document", "operation", "element", "field"] as const

export type DiagnosticScope = (typeof diagnosticScopes)[number]

/** Whether a diagnostic stops what it covers from being generated (`refusal`) or only reports (`notice`). */
export const diagnosticSeverities = ["refusal", "notice"] as const

export type DiagnosticSeverity = (typeof diagnosticSeverities)[number]

/**
 * The operation a diagnostic concerns.
 */
export type DiagnosticOperation = Readonly<{
	method: string
	operationId?: string
	path: string
}>

/**
 * One refusal or notice, shared by the report, the verdict file and `--describe` (design 8.1). Its row is its code's
 * prefix, which makeDiagnostic derives, so the two never disagree.
 */
export type Diagnostic = Readonly<{
	code: string
	column?: number
	document: DocumentUri
	element: string
	hint?: string
	line?: number
	message: string
	openapi: string
	operation?: DiagnosticOperation
	pointer: JsonPointer
	related?: ReadonlyArray<Origin>
	row: RowId
	scope: DiagnosticScope
	severity: DiagnosticSeverity
	specSection: DocumentUri
	wire?: string
}>

/**
 * A diagnostic's fields as the code that finds it states them: its texts unbranded and its row left out, since
 * makeDiagnostic derives the row from the code and brands the rest. Every optional field also takes `undefined`, so a
 * caller passes a maybe-absent value without a branch.
 */
export type DiagnosticInput = Readonly<{
	code: string
	column?: number | undefined
	document: string
	element: string
	hint?: string | undefined
	line?: number | undefined
	message: string
	openapi: string
	operation?: DiagnosticOperation | undefined
	pointer: string
	related?: ReadonlyArray<Readonly<{ document: string; pointer: string }>> | undefined
	scope: DiagnosticScope
	severity: DiagnosticSeverity
	specSection: string
	wire?: string | undefined
}>

/** A diagnostic the code built breaks the model: a code outside the grammar, a position below 1, a text no brand. */
export class MalformedDiagnostic extends Data.TaggedError("MalformedDiagnostic")<{
	readonly code: string
}> {}

/** Whether a value is a 1-based line or column. */
const isPosition = (value: unknown): value is number =>
	Predicate.isNumber(value) && Number.isInteger(value) && value >= 1

/** An origin's texts as their brands, when both are. */
const originOf = (origin: Readonly<{ document: string; pointer: string }>): Option.Option<Origin> =>
	isDocumentUri(origin.document) && isJsonPointer(origin.pointer)
		? Option.some({ document: origin.document, pointer: origin.pointer })
		: Option.none()

/** An optional field's value, kept as an absent key when it is undefined. */
const present = <K extends string, A>(key: K, value: A | undefined): Partial<Record<K, A>> =>
	value === undefined ? {} : Record.singleton(key, value)

/**
 * The diagnostic its fields describe, its members in the model's order, or `None` when they break it: a code outside
 * the code grammar, a line or column below 1, a document, section or pointer that is no URI or pointer.
 */
const diagnosticOf = (input: DiagnosticInput): Option.Option<Diagnostic> =>
	Option.flatMap(
		Option.all({
			document: Option.liftPredicate(input.document, isDocumentUri),
			pointer: Option.liftPredicate(input.pointer, isJsonPointer),
			related:
				input.related === undefined
					? Option.some(undefined)
					: Option.all(Arr.map(input.related, originOf)),
			row: rowOfCode(input.code),
			specSection: Option.liftPredicate(input.specSection, isDocumentUri)
		}),
		(branded) =>
			(input.column === undefined || isPosition(input.column)) &&
			(input.line === undefined || isPosition(input.line))
				? Option.some({
						code: input.code,
						...present("column", input.column),
						document: branded.document,
						element: input.element,
						...present("hint", input.hint),
						...present("line", input.line),
						message: input.message,
						openapi: input.openapi,
						...present("operation", input.operation),
						pointer: branded.pointer,
						...present("related", branded.related),
						row: branded.row,
						scope: input.scope,
						severity: input.severity,
						specSection: branded.specSection,
						...present("wire", input.wire)
					})
				: Option.none()
	)

/**
 * Builds a Diagnostic from its fields, the row its code's prefix. The fields are the generator's own, so fields that
 * break the model are a defect (MalformedDiagnostic), never a failure a caller handles.
 */
export const makeDiagnostic = (input: DiagnosticInput): Effect.Effect<Diagnostic> =>
	Option.match(diagnosticOf(input), {
		onNone: () => Effect.die(new MalformedDiagnostic({ code: input.code })),
		onSome: Effect.succeed
	})

/** Every member a Diagnostic may hold, so a value read back holds no other. */
const diagnosticKeys: ReadonlyArray<string> = [
	"code",
	"column",
	"document",
	"element",
	"hint",
	"line",
	"message",
	"openapi",
	"operation",
	"pointer",
	"related",
	"row",
	"scope",
	"severity",
	"specSection",
	"wire"
]

/** Whether an object holds only the given members. */
const holdsOnly = (
	value: { readonly [key: PropertyKey]: unknown },
	keys: ReadonlyArray<string>
): boolean => Arr.every(Record.keys(value), (key) => Arr.contains(keys, key))

/** Whether an object's member is absent or passes the predicate. */
const absentOr = (
	value: { readonly [key: PropertyKey]: unknown },
	key: string,
	holds: (member: unknown) => boolean
): boolean => !Predicate.hasProperty(value, key) || holds(value[key])

const isText = (value: unknown): boolean => Predicate.isString(value)

const isOrigin = (value: unknown): value is Origin =>
	Predicate.isReadonlyObject(value) &&
	holdsOnly(value, ["document", "pointer"]) &&
	Predicate.isString(value["document"]) &&
	isDocumentUri(value["document"]) &&
	Predicate.isString(value["pointer"]) &&
	isJsonPointer(value["pointer"])

const isOperation = (value: unknown): value is DiagnosticOperation =>
	Predicate.isReadonlyObject(value) &&
	holdsOnly(value, ["method", "operationId", "path"]) &&
	Predicate.isString(value["method"]) &&
	absentOr(value, "operationId", isText) &&
	Predicate.isString(value["path"])

const isScope = (value: unknown): value is DiagnosticScope =>
	Arr.some(diagnosticScopes, (scope) => scope === value)

const isSeverity = (value: unknown): value is DiagnosticSeverity =>
	Arr.some(diagnosticSeverities, (severity) => severity === value)

/**
 * Whether a value is a Diagnostic, such as one a report or a child process wrote as JSON: every member the model
 * holds, each of its type and brand, the row its code's prefix, and no other member.
 */
export const isDiagnostic = (value: unknown): value is Diagnostic =>
	Predicate.isReadonlyObject(value) &&
	holdsOnly(value, diagnosticKeys) &&
	Predicate.isString(value["code"]) &&
	Option.exists(rowOfCode(value["code"]), (row) => row === value["row"]) &&
	absentOr(value, "column", isPosition) &&
	Predicate.isString(value["document"]) &&
	isDocumentUri(value["document"]) &&
	Predicate.isString(value["element"]) &&
	absentOr(value, "hint", isText) &&
	absentOr(value, "line", isPosition) &&
	Predicate.isString(value["message"]) &&
	Predicate.isString(value["openapi"]) &&
	absentOr(value, "operation", isOperation) &&
	Predicate.isString(value["pointer"]) &&
	isJsonPointer(value["pointer"]) &&
	absentOr(value, "related", (related) => Arr.isArray(related) && Arr.every(related, isOrigin)) &&
	isScope(value["scope"]) &&
	isSeverity(value["severity"]) &&
	Predicate.isString(value["specSection"]) &&
	isDocumentUri(value["specSection"]) &&
	absentOr(value, "wire", isText)

const indexToken = regex("^(?:0|[1-9][0-9]*)$", "u")

const isIndex = (token: string): boolean => indexToken.test(token)

const tokenOrder = Order.make<string>((left, right) =>
	isIndex(left) && isIndex(right)
		? Order.Number(Number(left), Number(right))
		: Order.String(left, right)
)

/**
 * Whether a diagnostic is a refusal; the only other severity is `notice`.
 */
export const isRefusal = (diagnostic: Diagnostic): boolean => diagnostic.severity === "refusal"

/**
 * Whether a diagnostic is a refusal of the whole document.
 */
export const isDocumentRefusal: (diagnostic: Diagnostic) => boolean = Predicate.and(
	isRefusal,
	(diagnostic) => diagnostic.scope === "document"
)

/**
 * Diagnostic pointer order (design 3.7): JSON Pointers compare token by token, array indices
 * numerically and every other token as a string.
 */
export const pointerOrder: Order.Order<string> = Order.mapInput(
	Order.Array(tokenOrder),
	(pointer: string): readonly string[] => Arr.drop(Str.split(pointer, "/"), 1)
)

/**
 * Orders diagnostics by document index in `documents`, then pointer, then code (design 3.7).
 * Pointers compare token by token, array indices numerically. A document outside `documents` sorts
 * last.
 */
export const sortDiagnostics = (
	documents: readonly string[],
	diagnostics: readonly Diagnostic[]
): readonly Diagnostic[] => {
	const documentIndex = (diagnostic: Diagnostic): number => {
		const index = documents.indexOf(diagnostic.document)

		return index === -1 ? documents.length : index
	}

	const order = Order.combineAll([
		Order.mapInput(Order.Number, documentIndex),
		Order.mapInput(pointerOrder, (diagnostic: Diagnostic) => diagnostic.pointer),
		Order.mapInput(Order.String, (diagnostic: Diagnostic) => diagnostic.code)
	])

	return Arr.sort(diagnostics, order)
}
