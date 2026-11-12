/**
 * A served program's wire shape, read off its served form once (served/forms.ts ServedMember): its input from its
 * declared parameters, its array members' facts and a page's window; its rows from its decoder bound to the typed
 * layouts of its delivered parts; its key from its served key; a write's outcome from its read-backs; and the witnesses
 * its role's refusals may name. What generate writes into the served file (ServedWire) and the OpenAPI document, so the
 * server, the client and the document read one shape.
 *
 * Each leaf is a ServedLeaf: the codecs' WireScalar, and the scalar types its column holds, whose refinements the
 * document's schema states (live/openapi.ts); memberWire keeps the WireScalars alone.
 */
import { maxOf } from "#compiler/core/array.ts"
import { nominal } from "#compiler/core/brand.ts"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import {
	type AttachedForm,
	type ColumnForm,
	type DecoderForm,
	type Delivery,
	formHeadings
} from "#compiler/core/decoder.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { familyKey } from "#compiler/ir/law.ts"
import type { CallerParamDecl } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import type { InstantShape, ReadShape } from "#compiler/live/events.ts"
import {
	type MemberShape,
	type MemberWire,
	mapField,
	mapShape,
	type WireFacts,
	type WireField,
	type WireHeading,
	type WireInput,
	type WireLevel,
	type WireNamed,
	type WireParam,
	type WireRecord,
	type WireWitness
} from "#compiler/live/shape.ts"
import { encodeScalar, sameJson, type WireJson, type WireScalar } from "#compiler/live/wire.ts"
import type { InputData } from "#compiler/runtime/write/normalize.ts"
import type {
	ServedChange,
	ServedInstantRead,
	ServedMemberForm,
	ServedRoleForm,
	ServedVariants
} from "#compiler/served/forms.ts"
import {
	carried,
	type ServedAttach,
	type ServedPart,
	type ServedRoots,
	type ServedSpine,
	type ServedTree
} from "#compiler/served/read.ts"

/** A leaf of a member's shape as generate reads it: its codecs' scalar, and every scalar type its column holds. */
export interface ServedLeaf {
	readonly wire: WireScalar
	readonly types: NonEmptyReadonlyArray<ScalarType>
}

/** The wire spec of a scalar type: its carrier's, a contract's its base's, which it mirrors (ir/scalar.ts). */
export const wireScalarOf = (type: ScalarType): WireScalar => {
	switch (type.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
			return { carrier: type.carrier }
		case "numeric":
			return {
				carrier: "numeric",
				numeric:
					type.typmod === undefined
						? { kind: "bound", digits: type.bound.digits, scale: type.bound.scale }
						: { kind: "typmod", precision: type.typmod.precision, scale: type.typmod.scale }
			}
		case "exactInteger":
		case "exactMoney":
			return { carrier: type.carrier, digits: type.digits }
		case "code":
		case "bits":
			return { carrier: type.carrier, handles: type.roster.handles }
		case "range4":
		case "range8":
		case "rangeDate":
			return {
				carrier: type.carrier,
				width:
					type.span.width === undefined
						? { kind: "free" }
						: { kind: "fixed", units: type.span.width.toString() }
			}
		case "vector":
			return { carrier: "vector", dimensions: type.typmod.dims }
	}
}

/** A leaf of one scalar type. */
const leafOf = (type: ScalarType): ServedLeaf => ({ wire: wireScalarOf(type), types: [type] })

/** The wire refusal of a member `member` of role `role`: what its served form holds that the wire cannot spell. */
const refusedAt = (role: string, member: string, what: string): CompileError =>
	unsupported(SourceLoc(`served wire ${role}.${member}`, []), what)

/**
 * A delivered statement's layout, typed: each public column's type, and each attachment's child layouts with the
 * delivery the analysis proved (core/decoder.ts Layout, its positions replaced by types).
 */
interface TypedLayout {
	readonly columns: ReadonlyMap<string, ScalarType>
	readonly attachments: ReadonlyMap<
		string,
		{ readonly layouts: NonEmptyReadonlyArray<TypedLayout>; readonly proved: Delivery }
	>
}

/** Where a statement is in its program's tree (adapter reader/execution.ts Under): delivered, or under its parent. */
type Under =
	| { readonly kind: "root" }
	| {
			readonly kind: "attachment"
			readonly attach: ServedAttach
			readonly scope: ServedSpine | undefined
	  }

/**
 * The typed layout of the statement `tree` holds, placed `under`, in its scope on the delivered spine `scope`: the
 * columns its rows deliver (an attachment's own after its parent key, where its delivered child carries them), its
 * attachment statements' layouts, and each fused attachment's one layout of the columns it carries, as the runtime
 * lays a record out (adapter reader/execution.ts recordOf).
 */
const typedLayout = (
	tree: ServedTree<ServedPart>,
	under: Under,
	scope: ServedSpine | undefined
): TypedLayout => {
	const statement = tree.statement
	const columns = new Map(
		statement.heading
			.filter((column) => under.kind === "root" || carried(under.attach, under.scope, column.name))
			.map((column) => [column.name, column.type] as const)
	)
	const attachments = new Map<
		string,
		{ readonly layouts: NonEmptyReadonlyArray<TypedLayout>; readonly proved: Delivery }
	>()
	for (const child of tree.attachments) {
		attachments.set(child.attach.name, {
			layouts: [
				typedLayout(
					child,
					{ kind: "attachment", attach: child.attach, scope },
					scope?.under.get(child.attach.name)
				)
			],
			proved: child.attach.judged
		})
	}
	for (const fused of statement.fused) {
		attachments.set(fused.name, {
			layouts: [
				{
					columns: new Map(
						fused.layout.columns
							.filter(({ column }) => carried(fused.attach, scope, column.name))
							.map(({ column }) => [column.name, column.type] as const)
					),
					attachments: new Map()
				}
			],
			proved: fused.attach.judged
		})
	}
	return { columns, attachments }
}

/** The typed layouts of a program's delivered statements, one per heading group, on its delivered spine. */
const programLayouts = (
	roots: ServedRoots<ServedPart>,
	spine: ServedSpine
): NonEmptyReadonlyArray<TypedLayout> =>
	mapNonEmpty(roots, (tree) => typedLayout(tree, { kind: "root" }, spine))

/** What a decoder's walk reads as it binds: the member it binds for, whose refusals it names. */
interface Binding {
	readonly role: string
	readonly member: string
}

type Bound<A> = Result.Result<A, CompileError>

/** Each of `items` mapped by `f`, the first refusal kept. */
const each = <A, B>(items: ReadonlyArray<A>, f: (item: A) => Bound<B>): Bound<ReadonlyArray<B>> => {
	const out: Array<B> = []
	for (const item of items) {
		const mapped = f(item)
		if (!mapped.ok) {
			return mapped
		}
		out.push(mapped.value)
	}
	return Result.ok(out)
}

/** A value's JSON with no null in it: a head literal's spelling, which a scalar's encode never writes as null. */
const literalJson = (json: WireJson): Json => {
	if (json === null) {
		throw defect("a head literal spelled as null")
	}
	if (typeof json !== "object") {
		return json
	}
	return Array.isArray(json)
		? json.map(literalJson)
		: Object.fromEntries(Object.entries(json).map(([key, member]) => [key, literalJson(member)]))
}

/** A column field of `type`: its scalar, or head literals' values in its scalar's spelling. */
const columnField = (column: ColumnForm, type: ScalarType): WireField<ServedLeaf> => {
	const leaf = leafOf(type)
	if (column.kind !== "constant") {
		return { kind: "scalar", scalar: leaf }
	}
	return {
		kind: "constant",
		scalar: leaf,
		values: mapNonEmpty(column.values, (value) => literalJson(encodeScalar(leaf.wire, value)))
	}
}

/** The largest heading of `headings` every key of which the layout delivers (runtime/read/record.ts largestIn). */
const largestIn = (
	headings: ReadonlyArray<ReadonlyArray<string>>,
	layout: TypedLayout
): number | undefined => {
	const delivering = headings.filter((heading) =>
		heading.every((key) => layout.columns.has(key) || layout.attachments.has(key))
	)
	return delivering.length === 0
		? undefined
		: maxOf(
				delivering.map((h) => h.length),
				0
			)
}

/** A field that reads itself, under `key`, bound to its layout's attachment. */
const attachedField = (
	binding: Binding,
	key: string,
	field: AttachedForm,
	layout: TypedLayout
): Bound<WireField<ServedLeaf>> => {
	const at = layout.attachments.get(key)
	if (at === undefined) {
		return Result.err(
			refusedAt(binding.role, binding.member, `the attachment ${key} its decoder reads`)
		)
	}
	return Result.map(recordOf(binding, field.child, at.layouts), (child): WireField<ServedLeaf> => {
		switch (field.kind) {
			case "attachment":
				return { kind: "attachment", delivery: field.delivery, child }
			case "some":
				return { kind: "some", child }
			case "none":
				return { kind: "none", child }
		}
	})
}

/**
 * The fields of `form` bound to one layout, in the order its record fills them (runtime/read/record.ts fillsOf): a
 * record's own, a merge's first's then its second's, the arm of a union that owns the largest heading the layout
 * delivers, and an alternatives arm's parent's fields then its own.
 */
const fieldsOf = (
	binding: Binding,
	form: DecoderForm,
	layout: TypedLayout
): Bound<ReadonlyArray<WireNamed<ServedLeaf>>> => {
	switch (form.kind) {
		case "record":
			return each(form.fields, ([key, field]): Bound<WireNamed<ServedLeaf>> => {
				if (field.kind !== "column") {
					return Result.map(attachedField(binding, key, field, layout), (f) => ({
						name: key,
						field: f
					}))
				}
				const type = layout.columns.get(key)
				return type === undefined
					? Result.err(
							refusedAt(binding.role, binding.member, `the column ${key} its decoder reads`)
						)
					: Result.ok({ name: key, field: columnField(field.column, type) })
			})
		case "merge":
			return Result.flatMap(fieldsOf(binding, form.first, layout), (first) =>
				Result.map(fieldsOf(binding, form.second, layout), (second) => [...first, ...second])
			)
		case "oneOf": {
			const inFirst = largestIn(formHeadings(form.first), layout)
			const inSecond = largestIn(formHeadings(form.second), layout)
			return inFirst !== undefined && (inSecond === undefined || inFirst > inSecond)
				? fieldsOf(binding, form.first, layout)
				: fieldsOf(binding, form.second, layout)
		}
		case "arm":
			return Result.flatMap(fieldsOf(binding, form.parent, layout), (parent) => {
				const at = layout.attachments.get(form.name)
				if (at === undefined) {
					return Result.err(
						refusedAt(
							binding.role,
							binding.member,
							`the alternatives arm ${form.name} its decoder reads`
						)
					)
				}
				return Result.map(recordOf(binding, form.child, at.layouts), (child) => [
					...parent,
					{
						name: form.name,
						field: { kind: "arm", field: form.field, handle: form.handle, child }
					}
				])
			})
		case "refused":
			return Result.err(
				refusedAt(
					binding.role,
					binding.member,
					"a query whose rows a decoder reads, which no wire spells otherwise"
				)
			)
	}
}

/** Whether two fields are one on the wire: one kind, one scalar spelling, one delivery and one child. */
const sameField = (a: WireField<ServedLeaf>, b: WireField<ServedLeaf>): boolean =>
	sameJson(
		mapField(a, (leaf) => leaf.wire),
		mapField(b, (leaf) => leaf.wire)
	)

/** Two leaves of one spelling joined: the first's spelling, holding every type either holds. */
const joinedLeaf = (a: ServedLeaf, b: ServedLeaf): ServedLeaf => {
	const [first, ...rest] = a.types
	const more = b.types.filter((t) => !a.types.some((u) => sameScalarType(t, u)))
	return { wire: a.wire, types: [first, ...rest, ...more] }
}

/**
 * Two fields of one name and one spelling joined (sameField): a column's leaves joined, so a column two heading groups
 * deliver as types of one carrier spells either's values, and head literals' values joined; any other field is one.
 */
const joinedField = (a: WireField<ServedLeaf>, b: WireField<ServedLeaf>): WireField<ServedLeaf> => {
	if (a.kind === "scalar" && (b.kind === "scalar" || b.kind === "constant")) {
		return { kind: "scalar", scalar: joinedLeaf(a.scalar, b.scalar) }
	}
	if (a.kind === "constant" && b.kind === "scalar") {
		return { kind: "scalar", scalar: joinedLeaf(a.scalar, b.scalar) }
	}
	if (a.kind === "constant" && b.kind === "constant") {
		const [first, ...rest] = a.values
		const more = b.values.filter((v) => !a.values.some((u) => sameJson(u, v)))
		return {
			kind: "constant",
			scalar: joinedLeaf(a.scalar, b.scalar),
			values: [first, ...rest, ...more]
		}
	}
	return a
}

/**
 * The record a decoder form delivers over its layouts (core/decoder.ts DecoderForm): each layout's heading, those of one
 * key set merged, field by field, where they spell their fields alike, and refused where they do not.
 */
const recordOf = (
	binding: Binding,
	form: DecoderForm,
	layouts: NonEmptyReadonlyArray<TypedLayout>
): Bound<WireRecord<ServedLeaf>> =>
	Result.flatMap(
		each(layouts, (layout) => fieldsOf(binding, form, layout)),
		(headings) => {
			const merged: Array<ReadonlyArray<WireNamed<ServedLeaf>>> = []
			for (const heading of headings) {
				const names = heading.map((named) => named.name)
				const at = merged.findIndex(
					(known) =>
						known.length === names.length && known.every((named) => names.includes(named.name))
				)
				const known = merged[at]
				if (known === undefined) {
					merged.push(heading)
					continue
				}
				const joined: Array<WireNamed<ServedLeaf>> = []
				for (const named of known) {
					const other = heading.find((h) => h.name === named.name)
					if (other === undefined || !sameField(named.field, other.field)) {
						return Result.err(
							refusedAt(
								binding.role,
								binding.member,
								`one spelling of the field ${named.name} in every heading group`
							)
						)
					}
					joined.push({ name: named.name, field: joinedField(named.field, other.field) })
				}
				merged[at] = joined
			}
			const [first, ...rest] = merged
			return first === undefined
				? Result.err(refusedAt(binding.role, binding.member, "a delivered heading"))
				: Result.ok([first, ...rest])
		}
	)

/** A heading's columns as scalar fields: a parameter relation's or a fact's, which hold scalars alone. */
const scalarHeading = (heading: Heading): WireHeading<ServedLeaf> =>
	heading.map((column) => ({
		name: column.name,
		field: { kind: "scalar", scalar: leafOf(column.type) }
	}))

/** The instant shape of a read at its call's instant alone, by its keyed shape (live/events.ts InstantShape). */
const instantShapes: { readonly [S in ReadShape]: InstantShape } = {
	set: "instantSet",
	list: "instantList"
}

/** A program's declared parameters a call supplies on the wire. */
const paramsOf = (params: ReadonlyArray<CallerParamDecl>): ReadonlyArray<WireParam<ServedLeaf>> =>
	params.map((p) => ({
		name: p.name,
		param:
			p.kind === "scalar"
				? { kind: "scalar", scalar: leafOf(p.type) }
				: { kind: "relation", heading: scalarHeading(p.heading) }
	}))

/** A read's key columns, its key fields' own, read off its record: each a scalar or head literals' field of every heading. */
const keyOf = (
	binding: Binding,
	record: WireRecord<ServedLeaf>,
	fields: ReadonlyArray<string>
): Bound<ReadonlyArray<WireField<ServedLeaf>>> =>
	each(fields, (name) => {
		const refusal = Result.err(
			refusedAt(binding.role, binding.member, `the key field ${name}, a scalar of every heading`)
		)
		let column: WireField<ServedLeaf> | undefined
		for (const heading of record) {
			const field = heading.find((named) => named.name === name)?.field
			if (field === undefined || (field.kind !== "scalar" && field.kind !== "constant")) {
				return refusal
			}
			if (column !== undefined && !sameField(column, field)) {
				return refusal
			}
			column = column === undefined ? field : joinedField(column, field)
		}
		return column === undefined ? refusal : Result.ok(column)
	})

/** A read's record, over its program's typed layouts. */
const readRecord = (binding: Binding, read: ServedInstantRead): Bound<WireRecord<ServedLeaf>> =>
	recordOf(binding, read.decoder, programLayouts(read.source.roots, read.spine))

/** The input a member's slot's facts are admitted by (runtime/write/normalize.ts InputData): the one naming the slot. */
const inputOfSlot = (change: ServedChange, slot: string): InputData | undefined =>
	change.program.binding.groups
		.flatMap((group) => group.inputs)
		.find((input) => input.members.includes(slot))

/**
 * The fact of a member's input, as its levels: a single input's admitted heading; a classed input's complete and
 * generated headings, a fact of either; or a nested input's levels, the fact's own first, each with the families its
 * relation owns, a family's count field holding its members, facts of the member relation's level.
 */
const factOf = (
	binding: Binding,
	input: InputData
): Bound<NonEmptyReadonlyArray<WireLevel<ServedLeaf>>> => {
	switch (input.kind) {
		case "single":
			return Result.ok([{ headings: [scalarHeading(input.admitted)], families: [] }])
		case "classed":
			return Result.ok([
				{
					headings: [scalarHeading(input.complete.heading), scalarHeading(input.generated.heading)],
					families: []
				}
			])
		case "nested": {
			const nesting = input.nesting
			const levels = nesting.levels
			const top = levels.findIndex((level) => level.at.kind === "top")
			if (top < 0) {
				return Result.err(refusedAt(binding.role, binding.member, "a nested fact's own level"))
			}
			const ordered = [top, ...levels.keys()].filter((index, at, all) => all.indexOf(index) === at)
			const position = new Map(ordered.map((index, at) => [index, at] as const))
			return Result.flatMap(
				each(ordered, (index): Bound<WireLevel<ServedLeaf>> => {
					const level = levels[index]
					if (level === undefined) {
						return Result.err(refusedAt(binding.role, binding.member, "a nested fact's level"))
					}
					return Result.map(
						each(
							nesting.sequences.filter((family) => family.owner === level.relation),
							(family) => {
								const member = levels.findIndex(
									(l) =>
										l.relation === family.member &&
										l.at.kind !== "top" &&
										familyKey(l.at.family.id) === familyKey(family.id)
								)
								const at = position.get(member)
								return at === undefined
									? Result.err(
											refusedAt(binding.role, binding.member, `the level of ${family.member}`)
										)
									: Result.ok({ count: family.count, level: at })
							}
						),
						(families) => ({ headings: [scalarHeading(level.heading)], families })
					)
				}),
				(built) => {
					const [first, ...rest] = built
					return first === undefined
						? Result.err(refusedAt(binding.role, binding.member, "a nested fact's own level"))
						: Result.ok([first, ...rest])
				}
			)
		}
	}
}

/** A change's input: its declared parameters, and each array member's facts, in its members' order. */
const changeInput = (binding: Binding, change: ServedChange): Bound<WireInput<ServedLeaf>> =>
	Result.map(
		each(change.members, (member): Bound<WireFacts<ServedLeaf>> => {
			const input = inputOfSlot(change, member.slot)
			if (input === undefined) {
				return Result.err(
					refusedAt(binding.role, binding.member, `the input of the member slot ${member.slot}`)
				)
			}
			return Result.map(factOf(binding, input), (levels) => ({
				op: member.op,
				relation: member.relation,
				levels
			}))
		}),
		(facts) => ({ kind: "call", params: paramsOf(change.program.params), facts })
	)

/** A change's read-backs' record: one attachment per read-back, delivering every row its program delivers. */
const readsOf = (binding: Binding, change: ServedChange): Bound<WireRecord<ServedLeaf>> => {
	const layout: TypedLayout = {
		columns: new Map(),
		attachments: new Map(
			change.readBacks.map(
				(readBack) =>
					[
						readBack.name,
						{
							layouts: programLayouts(readBack.carried.source.roots, readBack.spine),
							proved: "array"
						}
					] as const
			)
		)
	}
	return recordOf(binding, change.decoder, [layout])
}

/** The leaves of a ChangeSet's variants, in order. */
const changesOf = (variants: ServedVariants): NonEmptyReadonlyArray<ServedChange> => {
	if (variants.kind === "change") {
		return [variants.change]
	}
	const [first, ...rest] = changesOf(variants.holding)
	return [first, ...rest, ...changesOf(variants.lacking)]
}

/** A change's wire: its input and outcome over one of its variants' compiles. */
const changeShape = (
	binding: Binding,
	change: ServedChange,
	witness: ReadonlyArray<WireWitness<ServedLeaf>>
): Bound<MemberShape<ServedLeaf>> =>
	Result.flatMap(changeInput(binding, change), (input) =>
		Result.map(readsOf(binding, change), (reads): MemberShape<ServedLeaf> => ({
			shape: "write",
			input,
			outcome: {
				kind: "change",
				relations: change.program.written.map((written) => written.relation),
				reads
			},
			witness
		}))
	)

/** A member shape's codecs' form, as JSON: its leaves' WireScalars alone. */
const shapeWire = (shape: MemberShape<ServedLeaf>): MemberWire =>
	mapShape(shape, (leaf) => leaf.wire)

/** What a member's wire reads of its role: its name, and its refusals, whose relations its witnesses name. */
export type WireRole = Pick<ServedRoleForm, "name" | "refusals">

/** The relations a refusal's witness may name for a role (adapter witness/index.ts statedWitness), typed by heading. */
const witnessOf = (role: WireRole): ReadonlyArray<WireWitness<ServedLeaf>> =>
	[...role.refusals.relations].map(([relation, heading]) => {
		const entry = role.refusals.entries.get(relation)
		if (entry === undefined) {
			return { relation, fields: scalarHeading(heading) }
		}
		const typeOf = new Map(heading.map((column) => [column.name, column.type] as const))
		return {
			relation: entry.entry,
			fields: [...entry.head].flatMap(([head, field]) => {
				const type = typeOf.get(field)
				return type === undefined
					? []
					: [{ name: head, field: { kind: "scalar" as const, scalar: leafOf(type) } }]
			})
		}
	})

/**
 * The wire shape of a member of `role` (see the module's header): refused, a CompileError naming the member, where its
 * served form holds what no wire spells: a decoder no layout binds, or a key field no heading holds as a scalar.
 */
export const memberShape = (
	member: ServedMemberForm,
	role: WireRole
): Bound<MemberShape<ServedLeaf>> => {
	const binding: Binding = { role: role.name, member: member.name }
	const witness = witnessOf(role)
	switch (member.kind) {
		case "read":
		case "key":
		case "paged": {
			const read = member.read
			return Result.flatMap(readRecord(binding, read), (record) =>
				Result.map(keyOf(binding, record, read.key.fields), (key): MemberShape<ServedLeaf> => ({
					shape: read.key.kind,
					fields: read.key.fields,
					input:
						member.kind === "paged"
							? { kind: "window", params: paramsOf(read.params), key }
							: { kind: "call", params: paramsOf(read.params), facts: [] },
					record,
					key,
					witness
				}))
			)
		}
		case "instant": {
			const read = member.read
			return Result.flatMap(readRecord(binding, read), (record) =>
				Result.map(keyOf(binding, record, read.key.fields), (key): MemberShape<ServedLeaf> => ({
					shape: instantShapes[read.key.kind],
					fields: read.key.fields,
					input: { kind: "call", params: paramsOf(read.params), facts: [] },
					record,
					key,
					witness
				}))
			)
		}
		case "change": {
			const [first, ...rest] = changesOf(member.variants)
			return Result.flatMap(changeShape(binding, first, witness), (shape) =>
				Result.flatMap(
					each(rest, (change) => changeShape(binding, change, witness)),
					(others) =>
						others.every((other) => sameJson(shapeWire(other), shapeWire(shape)))
							? Result.ok(shape)
							: Result.err(
									refusedAt(
										binding.role,
										binding.member,
										"one input and one outcome in every compile of its fill contexts"
									)
								)
				)
			)
		}
		case "refresh":
			return Result.ok({
				shape: "write",
				input: { kind: "call", params: [], facts: [] },
				outcome: { kind: "refresh" },
				witness
			})
	}
}

declare const wireDigestBrand: unique symbol

/** The SHA-256 of a member's canonical wire text, lowercase hex: what a client names the wire it was built for by. */
export type WireDigest = string & { readonly [wireDigestBrand]: true }

const wireDigest = nominal<string, WireDigest>()

/** A served member's wire, as the served file and the document carry it: its shape, and the digest of its text. */
export interface ServedWire {
	readonly digest: WireDigest
	readonly member: MemberWire
}

/** A member's wire, its leaves its codecs' scalars, with its digest (ServedWire), or the refusal of its shape. */
export const memberWire = (member: ServedMemberForm, role: WireRole): Bound<ServedWire> =>
	Result.flatMap(memberShape(member, role), (shape) => {
		const wire = shapeWire(shape)
		return Result.map(writeCanonicalJson(wire), (text) => ({
			digest: wireDigest(sha256Hex(text)),
			member: wire
		}))
	})
