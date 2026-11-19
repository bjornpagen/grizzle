/**
 * insertPreview(schema): the host half of an insertion, `ChangeSet.empty(S).insertAll(rows)`, as the first write of an
 * installation holding no row stores it, closed relations aside, with no SQL sent.
 *
 * The schema is compiled once, by the compile every write takes: its artifacts planned over a fresh installation's
 * codes, its rosters' declared order (ir/codes.ts firstCodebook), and `insertAll` over every top-level relation, each
 * member an array, compiled for reality (program/workload/change.ts compileParsed), projected and loaded as a served
 * write is (write/program/served.ts flightOf). Each preview is that write's binding of the call's rows
 * (runtime/write/bind.ts bindWrite), the one every application of the write runs before any SQL, under the transport
 * the caller names; its rows are the rows the bound statements insert (BoundWrite `inserted`).
 *
 * A code is a storage detail of one installation: a preview's rows hold host values, a closed id its handle, so the
 * codes it binds under name nothing it gives, and a roster's declared order is its codes' order for every comparison
 * the fill makes (codes.ts declaredOrder). In an installation holding no row, a group a fresh fill draws holds no stored
 * member, so every family value the host draws is the one the write stores; what PostgreSQL alone would give a row is
 * none of a preview's: a generated field is the row's evaluation's (rowEvaluator), a serial field the caller states
 * (types/changeset PreviewInputOf), and a counted member whose owner the call does not insert is refused (OwnerAbsent),
 * since its family's statement would draw it past a stored owner no such installation holds.
 */
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { familyKey, type FieldWriting } from "#compiler/ir/law.ts"
import { builtLawModel, parseBuiltSchema, schemaArtifacts } from "#compiler/program/schema.ts"
import { compileParsed } from "#compiler/program/workload/change.ts"
import { bindWrite, type InsertedRow } from "#compiler/runtime/write/bind.ts"
import type { CountedFamily, MemberAt } from "#compiler/runtime/write/binding.ts"
import { fieldKey } from "#compiler/runtime/write/fill.ts"
import type { MemberFacts } from "#compiler/runtime/write/normalize.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { insertableNamesOf, writableNamesOf } from "#compiler/schema/world.ts"
import type {
	InsertPreview,
	PreviewRefusal,
	PreviewRows
} from "#compiler/types/changeset/preview.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { changeSetOver, parseChangeSet } from "#compiler/write/changeset/value.ts"
import { flightOf } from "#compiler/write/program/served.ts"

/**
 * A field of a written relation as a preview reads it: its name, and how the write fills it (ir/law.ts FieldWriting),
 * one PostgreSQL does not generate from the row, whose value is the row's evaluation's (rowEvaluator).
 */
interface PreviewField {
	readonly name: string
	readonly writing: Exclude<FieldWriting, { readonly kind: "generated" }>
}

/** A row's fields, by name, as the preview gives them. */
type PreviewRow = Readonly<Record<string, unknown>>

/**
 * The call's rows as the write's members take them, read once off the caller's record (MemberFacts): under each
 * member's relation an array, its own data property, every key of the record one of those relations. Anything else is
 * a fact of another shape than the record insertAll takes (`factShape`): at the member's slot where its array is not
 * there, at the key where the record holds one no member takes, at the whole fact where the value is no plain record or
 * reading it throws.
 */
const memberFactsOf = (
	members: ReadonlyArray<MemberAt>,
	rows: unknown
): Result.Result<MemberFacts, EncodingFailure> =>
	hostRead(
		() => encodeFailure("factShape", factPlace),
		() => {
			if (!isPlainRecord(rows)) {
				return Result.err(encodeFailure("factShape", factPlace))
			}
			const relations = new Set(members.map((m) => m.relation))
			for (const key of Reflect.ownKeys(rows)) {
				if (typeof key !== "string") {
					return Result.err(encodeFailure("factShape", factPlace))
				}
				if (!relations.has(key)) {
					return Result.err(encodeFailure("factShape", slotPlace(key)))
				}
			}
			const facts = new Map<string, Iterable<unknown>>()
			for (const member of members) {
				const held = Reflect.getOwnPropertyDescriptor(rows, member.relation)
				const value: unknown = held?.value
				if (held === undefined || !Object.hasOwn(held, "value") || !isList(value)) {
					return Result.err(encodeFailure("factShape", slotPlace(member.slot)))
				}
				facts.set(member.slot, value)
			}
			return Result.ok(facts)
		}
	)

/**
 * The value an inserted row holds at a stored field PostgreSQL does not generate, as the write stores it: a
 * retirement field's is false, every insert writing its header open, which only its group's retirement sets true; every
 * other field's is the host's, as its statements send it (BoundWrite `inserted`), which fill every one of them where no
 * family draws a row past a stored group and the caller states every serial field.
 */
const storedValue = (
	relation: StoredRelationName,
	row: InsertedRow,
	field: PreviewField
): unknown => {
	switch (field.writing.kind) {
		case "retirement":
			return false
		case "caller":
		case "drawn":
		case "serial":
		case "accumulated": {
			const key = fieldKey(field.name)
			if (!row.values.has(key)) {
				throw defect(
					`the field ${relation}.${field.name} the write's binding fills on a row it inserts`
				)
			}
			return row.values.get(key)
		}
	}
}

/** The member slot an insert of `relation` takes its facts in, one per relation insertAll names. */
const memberSlotOf = (members: ReadonlyArray<MemberAt>, relation: StoredRelationName): string =>
	defined(
		members.find((m) => m.relation === relation),
		`the member slot of ${relation}, a relation the write inserts at its top level`
	).slot

/**
 * The one site of the fact "the rows a preview built are PreviewRows<S>": its keys are S's writable relations, which
 * writableNamesOf read off the schema at run time, and each row holds its relation's stored fields but the generated
 * ones, which the written relation's fields named, each the codec's host value its binding admitted or drew, a
 * correlation of S's type with the compiled write that no TypeScript type ties. Its keys are read against the names.
 */
const isPreviewRowsOf = <S extends AnySchema>(
	built: Readonly<Record<string, ReadonlyArray<PreviewRow>>>,
	names: ReadonlyArray<string>
): built is Readonly<Record<string, ReadonlyArray<PreviewRow>>> & PreviewRows<S> =>
	Object.keys(built).length === names.length && names.every((name) => Object.hasOwn(built, name))

/** A preview's rows by relation name, as a caller that knows its schema only at run time reads them (`previewOver`). */
export type PreviewRowsByName = Readonly<Record<string, ReadonlyArray<PreviewRow>>>

/**
 * insertPreview over `transport` for a caller whose schema is known only at run time (see the header): `schema`
 * compiled once into the preview of its insertions, or the schema's CompileError; each call reads its rows off the
 * caller's record (`memberFactsOf`) and binds them under `transport`, the message bound of the wire the write would go
 * over, so the preview refuses what the write would (InputRefused), and gives every writable relation's rows by name.
 * insertPreviewOver is this one under S's types.
 */
export const previewOver = (
	schema: AnySchema,
	transport: Transport
): Result.Result<
	(rows: unknown) => Result.Result<PreviewRowsByName, PreviewRefusal>,
	CompileError
> => {
	const built = parseBuiltSchema(schema, captureLoc("insertPreview", []))
	if (!built.ok) {
		return built
	}
	const model = builtLawModel(built.value)
	if (!model.ok) {
		return model
	}
	const codes = firstCodebook(rostersOf(model.value.owned))
	const artifacts = schemaArtifacts(built.value, { codes })
	if (!artifacts.ok) {
		return artifacts
	}
	const change = changeSetOver
		.empty(schema)
		.insertAll(Object.fromEntries(insertableNamesOf(schema).map((name) => [name, []] as const)))
	const parsed = parseChangeSet(change)
	if (parsed === undefined) {
		throw defect("insertAll's value, a ChangeSet")
	}
	const entry = compileParsed(artifacts.value, parsed, new Set(), "serializable", noClock)
	if (!entry.ok) {
		return entry
	}
	const { compiled } = entry.value
	const flight = flightOf(compiled, codes)
	const names: ReadonlyArray<string> = writableNamesOf(schema)
	/** Each written relation's fields PostgreSQL does not generate, in declared order. */
	const fields = new Map(
		compiled.frontend.written.map((relation) => [
			relation.name,
			relation.fields.flatMap((f): ReadonlyArray<PreviewField> =>
				f.writing.kind === "generated" ? [] : [{ name: f.name, writing: f.writing }]
			)
		])
	)
	/** Each counted family's law as lawsOf lists it, by the family's key (ir/law.ts familyKey). */
	const familyLaws = new Map(
		artifacts.value.theoryLaws.flatMap(({ described }) =>
			described.kind === "family" && described.order === "counted"
				? [[familyKey(described.slots), described] as const]
				: []
		)
	)
	const ownerAbsent = (
		family: CountedFamily
	): Extract<PreviewRefusal, { readonly _tag: "OwnerAbsent" }> => ({
		_tag: "OwnerAbsent",
		law: defined(
			familyLaws.get(familyKey(family.id)),
			`the law of the counted family ${family.owner}.${family.count}`
		)
	})
	return Result.ok((rows): Result.Result<PreviewRowsByName, PreviewRefusal> => {
		const members = memberFactsOf(flight.binding.members, rows)
		if (!members.ok) {
			return Result.err({ _tag: "InputRefused", failure: members.error })
		}
		const bound = bindWrite(flight, { members: members.value, params: {}, transport })
		if (!bound.ok) {
			return Result.err({ _tag: "InputRefused", failure: bound.error })
		}
		const write = bound.value
		switch (write.kind) {
			case "invariant-rejected":
				return Result.err({ _tag: "KeyConflict", law: write.described, witness: write.witness })
			case "generated-rejected":
				return Result.err({
					_tag: "GeneratedNull",
					law: write.rejection.law,
					witness: write.rejection.witness
				})
			case "bound":
				break
		}
		const inserted = write.inserted().flatMap((stratum) => [...stratum.rows])
		for (const [relation, of] of inserted) {
			if (of.some((row) => row.serial.length > 0)) {
				return Result.err({
					_tag: "InputRefused",
					failure: encodeFailure(
						"factShape",
						slotPlace(memberSlotOf(flight.binding.members, relation))
					)
				})
			}
		}
		for (const [, of] of inserted) {
			const orphan = of.find((row) => row.scanned.length > 0)
			if (orphan !== undefined) {
				return Result.err(ownerAbsent(defined(orphan.scanned[0], "a family that scans the row")))
			}
		}
		const byRelation = new Map<string, Array<PreviewRow>>(names.map((name) => [name, []]))
		for (const [relation, of] of inserted) {
			const stored = defined(
				fields.get(relation),
				`the fields of ${relation}, a relation the write inserts`
			)
			const out = defined(
				byRelation.get(relation),
				`${relation}, a writable relation of the schema`
			)
			for (const row of of) {
				out.push(
					Object.freeze(
						Object.fromEntries(stored.map((f) => [f.name, storedValue(relation, row, f)] as const))
					)
				)
			}
		}
		return Result.ok(
			Object.freeze(
				Object.fromEntries([...byRelation].map(([name, of]) => [name, Object.freeze(of)] as const))
			)
		)
	})
}

/**
 * insertPreview over `transport` (see the header), the shell's (packages/grizzle adapter/public/host.ts): `previewOver`
 * under S's types, its rows read as PreviewInputOf<S> and its rows by name given as PreviewRows<S> (`isPreviewRowsOf`),
 * each preview answered as `answer`, the shell's spelling of a caller's Result, makes it.
 */
export const insertPreviewOver = <S extends AnySchema>(
	schema: S,
	transport: Transport,
	answer: Result.PublicResult
): Result.Result<InsertPreview<S>, CompileError> =>
	Result.map(previewOver(schema, transport), (preview): InsertPreview<S> => {
		const names: ReadonlyArray<string> = writableNamesOf(schema)
		return (rows) =>
			answer(
				Result.map(preview(rows), (built) => {
					if (!isPreviewRowsOf<S>(built, names)) {
						throw defect("a preview's rows keyed by the schema's writable relations")
					}
					return built
				})
			)
	})
