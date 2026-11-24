/**
 * insertPreview(schema): the host half of an insertion, `ChangeSet.empty(S).insertAll(rows)`, as the first write of an
 * installation holding no row stores it, closed relations aside, with no SQL sent.
 *
 * The schema's law model is compiled once, the one every reader of the schema value reads (program/schema.ts
 * builtLawModel), and nothing else until a call writes rows: each call compiles, where a call first writes them, the
 * insert of the families its rows write (`writtenFamilies`: the relations it states rows of, each with every relation a
 * write of it writes, its families' owners and members (schema/reach.ts writesOf), and the clock each instant it stamps
 * by reference is stamped from, which its insert stamps beside), as an insertAll of each of their top-level relations,
 * each member an array, by the host half of the compile every write takes: its front end over the model
 * (write/frontend/compile.ts compileChangeSet) and its binding (write/program/served.ts hostBindingOf), under its
 * rosters' declared-order codes (ir/codes.ts firstCodebook), no statement built, kept for every later call that writes
 * the same families. A family no call writes compiles nothing, so a call's compile is the insert of what it previews,
 * whatever else the schema holds. Each preview is that write's binding of the call's rows (runtime/write/bind.ts
 * bindRows), the one every application of the write runs before any SQL, under the transport the caller names; its rows
 * are the rows the bound write inserts (BoundRows `inserted`). Rows of no other family are any write's of them: none.
 * An insert whose host half refuses as it compiles refuses each call that writes its families (Uncompiled).
 *
 * A code is a storage detail of one installation: a preview's rows hold host values, a closed id its handle, so the
 * codes it binds under name nothing it gives, and a roster's declared order is its codes' order for every comparison
 * the fill makes (codes.ts declaredOrder). In an installation holding no row, a group a fresh fill draws holds no stored
 * member, so every family value the host draws is the one the write stores; what PostgreSQL alone would give a row is
 * none of a preview's: a generated field is the row's evaluation's (rowEvaluator), and a counted member whose owner the
 * call does not insert is refused (OwnerAbsent),
 * since its family's statement would draw it past a stored owner no such installation holds.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { lawDescription } from "#compiler/analysis/theory/description.ts"
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { once } from "#compiler/core/lazy.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { type FieldWriting, columnKeyOf } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { parseBuiltSchema } from "#compiler/program/input.ts"
import { type CompiledSchema, compiledSchema } from "#compiler/program/schema.ts"
import { namedGenerated, namedLaw, recordedGenerated } from "#compiler/runtime/law-entry.ts"
import { bindRows, type HostBinding, type InsertedRow } from "#compiler/runtime/write/bind.ts"
import type { CountedFamily } from "#compiler/runtime/write/binding.ts"
import type { ClosedTable } from "#compiler/runtime/write/fill.ts"
import type { MemberFacts } from "#compiler/runtime/write/normalize.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import { fieldEntry } from "#compiler/schema/declared-entries.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { writesOf } from "#compiler/schema/reach.ts"
import { insertableNamesOf, writableNamesOf } from "#compiler/schema/world.ts"
import type {
	InsertPreview,
	PreviewRefusal,
	PreviewRows
} from "#compiler/types/changeset/preview.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { changeSetOver, insertAllSlots, parseChangeSet } from "#compiler/write/changeset/value.ts"
import { compileChangeSet, type WriteFrontend } from "#compiler/write/frontend/compile.ts"
import { hostBindingOf } from "#compiler/write/program/served.ts"

/**
 * How a written relation's field the preview states is filled (ir/law.ts FieldWriting): every way but PostgreSQL's
 * generation from the row, whose value is the row's evaluation's (rowEvaluator), and the database's clock, which
 * stamps an instant as its statement runs, so no write knows it before any SQL.
 */
type PreviewWriting =
	| { readonly kind: "caller" | "drawn" }
	| Extract<FieldWriting, { readonly kind: "accumulated" }>

/**
 * A field of a written relation as a preview reads it: its name, its position among its relation's columns, at which an
 * inserted row's cells hold its value (runtime/write/cells.ts Cells), and how the write fills it (PreviewWriting).
 */
interface PreviewField {
	readonly name: string
	readonly at: number
	readonly writing: PreviewWriting
}

/** A field's writing as a preview states it (PreviewWriting), none for a generated field, an instant or a place, which
 * the database computes or stamps. */
const previewWriting = (writing: FieldWriting): PreviewWriting | undefined => {
	switch (writing.kind) {
		case "caller":
		case "drawn":
			return { kind: writing.kind }
		case "accumulated":
			return writing
		case "generated":
		case "keyGenerated":
		case "instant":
		case "place":
			return undefined
	}
}

/** A row's fields, by name, as the preview gives them. */
type PreviewRow = Readonly<Record<string, unknown>>

/**
 * The members of insertAll over every top-level relation, in the ChangeSet's order, each by the relation its array is of
 * and the slot it travels in: what every call's record states (InsertAllRowsOf), read once a preview.
 */
interface EveryMember {
	readonly members: ReadonlyArray<{ readonly slot: string; readonly relation: string }>
	readonly relations: ReadonlySet<string>
}

/** A call's rows read off its record (`memberFactsOf`): each member's facts by its slot, and the relations whose
 * arrays hold a row, in the members' order, which the call writes. */
interface CallFacts {
	readonly facts: MemberFacts
	readonly written: ReadonlyArray<string>
}

/**
 * The call's rows as the write's members take them, read once off the caller's record (MemberFacts): under each
 * member's relation an array, its own data property, every key of the record one of those relations. Anything else is
 * a fact of another shape than the record insertAll takes (`factShape`): at the member's slot where its array is not
 * there, at the key where the record holds one no member takes, at the whole fact where the value is no plain record or
 * reading it throws.
 */
const memberFactsOf = (
	every: EveryMember,
	rows: unknown
): Result.Result<CallFacts, EncodingFailure> =>
	hostRead(
		() => encodeFailure("factShape", factPlace),
		() => {
			if (!isPlainRecord(rows)) {
				return Result.err(encodeFailure("factShape", factPlace))
			}
			for (const key of Reflect.ownKeys(rows)) {
				if (typeof key !== "string") {
					return Result.err(encodeFailure("factShape", factPlace))
				}
				if (!every.relations.has(key)) {
					return Result.err(encodeFailure("factShape", slotPlace(key)))
				}
			}
			const facts = new Map<string, Iterable<unknown>>()
			const written: Array<string> = []
			for (const member of every.members) {
				const held = Reflect.getOwnPropertyDescriptor(rows, member.relation)
				const value: unknown = held?.value
				if (held === undefined || !Object.hasOwn(held, "value") || !isList(value)) {
					return Result.err(encodeFailure("factShape", slotPlace(member.slot)))
				}
				facts.set(member.slot, value)
				if (value.length > 0) {
					written.push(member.relation)
				}
			}
			return Result.ok({ facts, written })
		}
	)

/**
 * The families a call that states rows of `stated` writes, as their insert compiles (see the header): every relation a
 * write of them writes, its families' owners and members (schema/reach.ts writesOf), and every clock an instant one of
 * them stamps by reference is stamped from, whose insert the write stamps it beside (write/frontend/instants.ts
 * refuseStampsApart), with every relation a write of each writes, until no relation adds another.
 */
const writtenFamilies = (model: LawModel, stated: ReadonlyArray<string>): ReadonlySet<string> => {
	const written = new Set<string>(stated)
	for (let size = 0; size !== written.size;) {
		size = written.size
		for (const relation of writesOf(model.owned, written)) {
			written.add(relation)
		}
		for (const [relation, roles] of model.theory.instants.roles) {
			if (!written.has(relation)) {
				continue
			}
			for (const role of roles.values()) {
				if (role.kind === "reference" && role.stamp !== undefined) {
					written.add(role.stamp.head.relation)
				}
			}
		}
	}
	return written
}

/**
 * The insert of a call's families as a preview binds its rows (`previewWrite`): its write's host half (bind.ts
 * HostBinding), and each relation it writes with its fields PostgreSQL does not generate, in declared order, each at
 * its position.
 */
export interface PreviewWrite {
	readonly host: HostBinding
	readonly fields: ReadonlyMap<string, ReadonlyArray<PreviewField>>
}

/** What compiling the insert of `insertable`, top-level relations of the schema each a member an array, reads. */
interface PreviewCompile {
	readonly schema: AnySchema
	readonly model: LawModel
	readonly codes: ReturnType<typeof firstCodebook>
	readonly closed: () => ClosedTable
	readonly patterns: PatternReads
}

/**
 * The insert of `insertable`, each a top-level relation and a member an array, compiled as a preview binds it: the host
 * half of the compile every write takes (see the header), its front end over the model and its binding, no statement
 * built, or the CompileError its front end refuses it by.
 */
const previewWrite = (
	compile: PreviewCompile,
	insertable: ReadonlyArray<string>
): Result.Result<PreviewWrite, CompileError> => {
	const parsed = parseChangeSet(
		changeSetOver
			.empty(compile.schema)
			.insertAll(Object.fromEntries(insertable.map((name) => [name, []] as const)))
	)
	if (parsed === undefined) {
		throw defect("insertAll's value, a ChangeSet")
	}
	const { model, codes } = compile
	return Result.map(
		compileChangeSet(model.checked, parsed.desc, {
			claims: { kind: "facts", present: new Set() },
			laws: model,
			derived: derivedAnalysis(model.checked),
			codes,
			clock: noClock,
			source: transactionClock
		}),
		(frontend) =>
			previewWriteOf(frontend, hostBindingOf(frontend, codes, compile.closed(), compile.patterns))
	)
}

/**
 * A write as a preview binds its rows (`PreviewWrite`): its host half, a preview's (`previewWrite`) or a served write's
 * loaded flight, and each relation its front end writes with its fields PostgreSQL does not generate, at their positions
 * among its host half's columns.
 */
export const previewWriteOf = (frontend: WriteFrontend, host: HostBinding): PreviewWrite => ({
	host,
	fields: new Map(
		frontend.written.map((relation) => {
			const columns = host.prepared.columns(relation.name)
			return [
				relation.name,
				relation.fields.flatMap((f): ReadonlyArray<PreviewField> => {
					const writing = previewWriting(f.writing)
					return writing === undefined
						? []
						: [{ name: f.name, at: columns.at(columnKeyOf(f.name)), writing }]
				})
			] as const
		})
	)
})

/**
 * The value an inserted row holds at a stored field PostgreSQL does not generate, as the write stores it: the host's, as its statements send it (BoundWrite `inserted`), which fill every one of them where no
 * family draws a row past a stored group.
 */
const storedValue = (
	relation: StoredRelationName,
	row: InsertedRow,
	field: PreviewField
): unknown => {
	switch (field.writing.kind) {
		case "caller":
		case "drawn":
		case "accumulated": {
			const value = row.values[field.at]
			if (value === undefined) {
				throw defect(
					`the field ${relation}.${field.name} the write's binding fills on a row it inserts`
				)
			}
			return value
		}
	}
}

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

/** A preview's answer to one call: every writable relation's rows by name, or its refusal. */
type PreviewAnswer = Result.Result<PreviewRowsByName, PreviewRefusal>

/**
 * The preview of `schema`'s insertions over its law model `model` (see the header), each call's rows bound by the write
 * `writeFor` gives for the relations it states rows of, in the members' order, under `transport`: a preview's own, the
 * insert of the families those rows write (`previewOver`), or any write over every relation it states rows of, a
 * served insertAll's among them.
 */
export const previewThrough = (
	schema: AnySchema,
	model: LawModel,
	transport: Transport,
	writeFor: (stated: ReadonlyArray<string>) => Result.Result<PreviewWrite, CompileError>
): ((rows: unknown) => PreviewAnswer) => {
	const members = insertAllSlots(insertableNamesOf(schema))
	const every: EveryMember = { members, relations: new Set(members.map((m) => m.relation)) }
	const names: ReadonlyArray<string> = writableNamesOf(schema)
	/** A counted family's law as lawsOf lists it (analysis/theory/description.ts lawDescription), with its entry. */
	const ownerAbsent = (
		family: CountedFamily
	): Extract<PreviewRefusal, { readonly _tag: "OwnerAbsent" }> => {
		const law = defined(
			model.theory.laws.find(
				(l) =>
					l.detail.kind === "family" &&
					l.detail.family.id.owner === family.id.owner &&
					l.detail.family.id.count === family.id.count
			),
			`the law of the counted family ${family.owner}.${family.count}`
		)
		const described = namedLaw(lawDescription(law))
		if (described.kind !== "family") {
			throw defect(`the law of the counted family ${family.owner}.${family.count}, a family's`)
		}
		return { _tag: "OwnerAbsent", law: described }
	}
	/** Every writable relation's rows of a call that writes none. */
	const none = once((): PreviewRowsByName =>
		Object.freeze(Object.fromEntries(names.map((name) => [name, Object.freeze([])] as const)))
	)
	return (rows): PreviewAnswer => {
		const call = memberFactsOf(every, rows)
		if (!call.ok) {
			return Result.err({ _tag: "InputRefused", failure: call.error })
		}
		if (call.value.written.length === 0) {
			return Result.ok(none())
		}
		const compiled = writeFor(call.value.written)
		if (!compiled.ok) {
			return Result.err({ _tag: "Uncompiled", error: compiled.error })
		}
		const { host, fields } = compiled.value
		const bound = bindRows(host, { members: call.value.facts, params: {}, transport })
		if (!bound.ok) {
			return Result.err({ _tag: "InputRefused", failure: bound.error })
		}
		const write = bound.value
		switch (write.kind) {
			case "invariant-rejected":
				return Result.err({
					_tag: "KeyConflict",
					law: namedLaw(write.described),
					witness: write.witness
				})
			case "generated-rejected":
				return Result.err({
					_tag: "GeneratedNull",
					law: namedGenerated(
						recordedGenerated(
							write.rejection.law,
							fieldEntry(
								model.owned.declared.generated,
								write.rejection.law.relation,
								write.rejection.law.field
							)
						)
					),
					witness: write.rejection.witness
				})
			case "bound":
				break
		}
		const inserted = write.inserted().flatMap((stratum) => [...stratum.rows])
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
				const values: Record<string, unknown> = {}
				for (const f of stored) {
					values[f.name] = storedValue(relation, row, f)
				}
				out.push(Object.freeze(values))
			}
		}
		return Result.ok(
			Object.freeze(
				Object.fromEntries([...byRelation].map(([name, of]) => [name, Object.freeze(of)] as const))
			)
		)
	}
}

/**
 * The inserts of a schema's families as its readers compile them (see the header): `writeOf(stated)` the insert of the
 * families a call that states rows of `stated` writes (`writtenFamilies`, `previewWrite`), or the CompileError it
 * refuses by, compiled where a reader first writes those families and kept for every later reader of the schema value,
 * a preview's call (`previewOver`) and a facts decoder's (program/decode.ts) alike.
 */
export interface FamilyInserts {
	readonly writeOf: (stated: ReadonlyArray<string>) => Result.Result<PreviewWrite, CompileError>
}

/**
 * The family inserts of `schema`, whose compiled state is `compiled`: made where a reader of the schema value first
 * writes its families and held in its compiled state (program/schema.ts CompiledSchema `inserts`), so every reader of
 * one schema value in a process, a preview's call (`previewOver`) and a facts decoder's (program/decode.ts) alike,
 * compiles its families' inserts once.
 */
export const familyInsertsOf = (schema: AnySchema, compiled: CompiledSchema): FamilyInserts =>
	compiled.inserts.read(() => familyInsertsMade(schema, compiled.model))

/** The family inserts of `schema`, whose law model is `model`: each set of families' insert compiled where a call first
 * writes it, and held for every later call. */
const familyInsertsMade = (schema: AnySchema, model: LawModel): FamilyInserts => {
	const insertable: ReadonlyArray<string> = insertableNamesOf(schema)
	const compile: PreviewCompile = {
		schema,
		model,
		codes: firstCodebook(rostersOf(model.owned)),
		closed: once(() => closedTableOf(model.checked)),
		patterns: model.checked.patterns
	}
	/** The insert of each set of families a call wrote, by the top-level relations it inserts, in the schema's order. */
	const writes = new TupleMap<ReadonlyArray<string>, Result.Result<PreviewWrite, CompileError>>()
	/** The top-level relations each call's stated relations make it insert (`writtenFamilies`), by those relations. */
	const inserts = new TupleMap<ReadonlyArray<string>, ReadonlyArray<string>>()
	const made: FamilyInserts = {
		writeOf: (stated) => {
			let inserted = inserts.get(stated)
			if (inserted === undefined) {
				const families = writtenFamilies(model, stated)
				inserted = insertable.filter((name) => families.has(name))
				inserts.set(stated, inserted)
			}
			const compiled = writes.get(inserted)
			if (compiled !== undefined) {
				return compiled
			}
			const write = previewWrite(compile, inserted)
			writes.set(inserted, write)
			return write
		}
	}
	return made
}

/**
 * insertPreview over `transport` for a caller whose schema is known only at run time (see the header): `schema`'s law
 * model compiled, or the schema's CompileError; each call reads its rows off the caller's record (`memberFactsOf`), and
 * binds them by the insert of the families it writes, compiled where a reader of the schema value first writes them
 * (`familyInsertsOf`), under `transport`, the message bound of the wire the write would go over, so the preview
 * refuses what the write would (InputRefused), and gives every writable relation's rows by name. insertPreviewOver is
 * this one under S's types.
 */
export const previewOver = (
	schema: AnySchema,
	transport: Transport
): Result.Result<(rows: unknown) => PreviewAnswer, CompileError> =>
	Result.map(
		Result.flatMap(parseBuiltSchema(schema, captureLoc("insertPreview", [])), compiledSchema),
		(compiled) =>
			previewThrough(schema, compiled.model, transport, familyInsertsOf(schema, compiled).writeOf)
	)

/**
 * insertPreview over `transport` (see the header), the shell's (packages/grizzle adapter/public/host.ts): `previewOver`
 * under S's types, its rows read as InsertAllRowsOf<S> and its rows by name given as PreviewRows<S> (`isPreviewRowsOf`),
 * each preview answered as `answer`, the shell's spelling of a caller's Result, makes it.
 */
export const insertPreviewOver = <S extends AnySchema>(
	schema: S,
	transport: Transport,
	answer: PublicResult
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
