import { everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type AbsentAnchor,
	type AlternativesArm,
	type AlternativesCheck,
	type AnchorPair,
	type CapacityBound,
	eventsInOrder,
	type ExactCarrier,
	familyAbsentAnchor,
	type FieldSelector,
	type ImageGuard,
	type KeyImage,
	type LawField,
	type LawWeight,
	type NamedDetailCodec,
	namedDetail,
	type Participant,
	type ResidualLaw,
	type RosterHandle,
	type RosterHandleOf
} from "#compiler/ir/law.ts"
import { indexOpclassText, type IndexRows } from "#compiler/ir/products.ts"
import type { ScalarType, SpanCarrier } from "#compiler/ir/scalar.ts"

/** A pairing of a side's field with the anchor key field it meets, by name. */
export interface PairRecord {
	readonly field: string
	readonly anchor: string
}

/** A literal selector, by its field's name. */
export interface SelectorRecord {
	readonly field: string
	readonly value: TypedLiteral
}

/** A side beside the anchor, by names: its relation and its pairs. */
export interface SideRecord {
	readonly relation: string
	readonly pairs: ReadonlyArray<PairRecord>
}

/** An arm of an alternatives law: its handle and its payload side. */
export interface ArmRecord extends SideRecord {
	readonly handle: string
}

/** A roster handle as the parent's units dispatch it. */
export type RosterRecord = RosterHandleOf<ArmRecord>

/** What one participant of an alternatives law re-checks. */
export type CheckRecord =
	| { readonly kind: "roster"; readonly handles: ReadonlyArray<RosterRecord> }
	| { readonly kind: "arms"; readonly arms: ReadonlyArray<ArmRecord> }

/** A capacity bound: a literal, as stated and typed, or a field of the target row with the carrier it meets in. */
export type BoundRecord =
	| { readonly kind: "literal"; readonly literal: TypedLiteral; readonly stated: bigint }
	| { readonly kind: "ref"; readonly field: string; readonly carrier: ExactCarrier }

/** How a capacity weighs each source fact, by its field's name. */
export type WeightRecord =
	| { readonly kind: "count" }
	| { readonly kind: "field" | "duration"; readonly field: string }

/** What each family checks beyond its anchor, by names: every member of its detail. An alternatives law's detail holds
 * what each of its participants re-checks, by relation. */
export type FamilyRecord =
	| {
			readonly family: "selectedSourceContainment"
			readonly source: SideRecord & { readonly selection: ReadonlyArray<SelectorRecord> }
	  }
	| {
			readonly family: "conditionalMirrors"
			readonly selection: ReadonlyArray<SelectorRecord>
			readonly child: SideRecord
	  }
	| {
			readonly family: "alternativesReverse"
			readonly discriminator: string
			readonly checks: ReadonlyArray<{ readonly relation: string; readonly check: CheckRecord }>
	  }
	| {
			readonly family: "scalarCapacity"
			readonly selection: ReadonlyArray<SelectorRecord>
			readonly source: SideRecord & { readonly selection: ReadonlyArray<SelectorRecord> }
			readonly weight: WeightRecord
			readonly aggregate: { readonly carrier: "int8" | "numeric"; readonly type: ScalarType }
			readonly bounds: ReadonlyArray<{ readonly side: "low" | "high"; readonly value: BoundRecord }>
	  }
	| {
			readonly family: "selectedSourceCoverage"
			readonly target: SideRecord & { readonly span: string; readonly carrier: SpanCarrier }
			readonly source: SideRecord & {
				readonly span: string
				readonly selection: ReadonlyArray<SelectorRecord>
			}
	  }

/** A row image, by names: the participant fields that give the anchor key, each with its family's pairing, and its
 * guard's selections. Its side is its event's. */
export interface ImageRecord {
	readonly key: ReadonlyArray<{ readonly field: string; readonly pair: PairRecord }>
	readonly guard:
		| { readonly kind: "always" }
		| {
				readonly kind: "selected"
				readonly selections: ReadonlyArray<ReadonlyArray<SelectorRecord>>
		  }
}

/** One event unit of a participant, by what it checks: an INSERT's or a DELETE's images, an UPDATE's fields. */
export type UnitRecord =
	| { readonly event: "INSERT" | "DELETE"; readonly images: ReadonlyArray<ImageRecord> }
	| { readonly event: "UPDATE"; readonly of: ReadonlyArray<string> }

/** A probe's index request, by names. */
export interface IndexRecord {
	readonly relation: string
	readonly keys: ReadonlyArray<{
		readonly expr: string
		readonly dir: "asc" | "desc"
		readonly opclass: string | undefined
	}>
	readonly method: string
	readonly use: string
	readonly rows: IndexRows
}

/**
 * A residual law as its digests read it: every member of the law but the identities its objects are named by, each
 * relation and field by its name. Two laws of one identity whose records are equal install the same units over the same
 * tables, check the same obligations and report the same DETAIL, so a migration between them changes no meaning
 * (deploy/diff/diff.ts witnessOnly).
 */
export interface ResidualRecord {
	readonly family: FamilyRecord
	readonly anchor: { readonly relation: string; readonly key: ReadonlyArray<string> }
	readonly absentAnchor: AbsentAnchor
	readonly participants: ReadonlyArray<{
		readonly relation: string
		readonly units: ReadonlyArray<UnitRecord>
	}>
	readonly indexes: ReadonlyArray<IndexRecord>
	readonly detail: NamedDetailCodec
}

const names = (fields: ReadonlyArray<LawField>): ReadonlyArray<string> => fields.map((f) => f.name)

const pair = (p: AnchorPair): PairRecord => ({ field: p.field.name, anchor: p.anchor.name })

const selectors = (selection: ReadonlyArray<FieldSelector>): ReadonlyArray<SelectorRecord> =>
	selection.map((s) => ({ field: s.field.name, value: s.value }))

const arm = (a: AlternativesArm): ArmRecord => ({
	handle: a.handle,
	relation: a.relation.name,
	pairs: a.pairs.map(pair)
})

const rosterHandle = (h: RosterHandle): RosterRecord => {
	switch (h.kind) {
		case "armed":
			return { kind: "armed", arm: arm(h.arm) }
		case "unarmed":
			return { kind: "unarmed", handle: h.handle }
	}
}

const check = (c: AlternativesCheck): CheckRecord => {
	switch (c.kind) {
		case "roster":
			return { kind: "roster", handles: c.handles.map(rosterHandle) }
		case "arms":
			return { kind: "arms", arms: c.arms.map(arm) }
	}
}

const bound = (b: CapacityBound): BoundRecord => {
	switch (b.kind) {
		case "literal":
			return { kind: "literal", literal: b.literal, stated: b.stated }
		case "ref":
			return { kind: "ref", field: b.field.name, carrier: b.carrier }
	}
}

const weight = (w: LawWeight): WeightRecord => {
	switch (w.kind) {
		case "count":
			return { kind: w.kind }
		case "field":
		case "duration":
			return { kind: w.kind, field: w.field.name }
	}
}

const familyRecord = (r: ResidualLaw): FamilyRecord => {
	switch (r.family) {
		case "selectedSourceContainment":
			return {
				family: r.family,
				source: {
					relation: r.source.relation.name,
					pairs: r.source.pairs.map(pair),
					selection: selectors(r.source.selection)
				}
			}
		case "conditionalMirrors":
			return {
				family: r.family,
				selection: selectors(r.selection),
				child: { relation: r.child.relation.name, pairs: r.child.pairs.map(pair) }
			}
		case "alternativesReverse":
			return {
				family: r.family,
				discriminator: r.discriminator.name,
				checks: r.participants.map((p) => ({ relation: p.relation.name, check: check(p.check) }))
			}
		case "scalarCapacity":
			return {
				family: r.family,
				selection: selectors(r.selection),
				source: {
					relation: r.source.relation.name,
					pairs: r.source.pairs.map(pair),
					selection: selectors(r.source.selection)
				},
				weight: weight(r.weight),
				aggregate: { carrier: r.aggregate.carrier, type: r.aggregate.type },
				bounds: r.bounds.map((b) => ({ side: b.side, value: bound(b.value) }))
			}
		case "selectedSourceCoverage":
			return {
				family: r.family,
				target: {
					relation: r.target.relation.name,
					pairs: r.target.pairs.map(pair),
					span: r.target.span.name,
					carrier: r.target.carrier
				},
				source: {
					relation: r.source.relation.name,
					pairs: r.source.pairs.map(pair),
					span: r.source.span.name,
					selection: selectors(r.source.selection)
				}
			}
	}
}

const guard = (g: ImageGuard): ImageRecord["guard"] => {
	switch (g.kind) {
		case "always":
			return { kind: "always" }
		case "selected":
			return { kind: "selected", selections: g.selections.map(selectors) }
	}
}

const image = (i: KeyImage): ImageRecord => ({
	key: i.key.map((c) => ({ field: c.field.name, pair: pair(c.pair) })),
	guard: guard(i.guard)
})

const units = (p: Participant): ReadonlyArray<UnitRecord> =>
	eventsInOrder(p.events, {
		insert: (unit): UnitRecord => ({ event: "INSERT", images: unit.on.map(image) }),
		delete: (unit): UnitRecord => ({ event: "DELETE", images: unit.on.map(image) }),
		update: (unit): UnitRecord => ({ event: "UPDATE", of: names(unit.on.of) })
	})

/** A residual law's record (`ResidualRecord`). */
export const residualRecord = (r: ResidualLaw): ResidualRecord => ({
	family: familyRecord(r),
	anchor: { relation: r.anchor.relation.name, key: names(r.anchor.key) },
	absentAnchor: familyAbsentAnchor[r.family],
	participants: r.participants.map((p) => ({ relation: p.relation.name, units: units(p) })),
	indexes: r.indexes.map((i) => ({
		relation: i.relation,
		keys: i.keys.map((k) => ({ expr: k.expr, dir: k.dir, opclass: indexOpclassText(k.opclass) })),
		method: i.method,
		use: i.use,
		rows: i.rows
	})),
	detail: namedDetail(r.detail)
})

/** The record without its UPDATE units: what declaring or removing `mutable` alone leaves unchanged. */
const withoutUpdates = (record: ResidualRecord): ResidualRecord => ({
	...record,
	participants: record.participants.map((p) => ({
		relation: p.relation,
		units: p.units.filter((u) => u.event !== "UPDATE")
	}))
})

/** The digest of a residual law's record. */
const recordDigest = (record: ResidualRecord): string => {
	const result = digest("residual-law", record, everyProperty)
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
}

/** A residual law's digests: of its whole record, and of its record without its UPDATE units. */
export const residualDigests = (
	r: ResidualLaw
): { readonly digest: string; readonly withoutUpdates: string } => {
	const record = residualRecord(r)
	return { digest: recordDigest(record), withoutUpdates: recordDigest(withoutUpdates(record)) }
}
