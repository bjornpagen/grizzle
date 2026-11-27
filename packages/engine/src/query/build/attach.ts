import {
	attachment,
	type Delivered,
	type Delivery,
	merge,
	type RecordField,
	type RowDecoder
} from "#compiler/core/decoder.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { AttachDesc } from "#compiler/ir/desc.ts"
import { type Heading, hasName, headingField } from "#compiler/query/build/heading.ts"
import {
	type AttachScope,
	newAttachScope,
	requireLevel,
	withAttach
} from "#compiler/query/build/scope.ts"
import { type QueryState, queryState } from "#compiler/query/build/state.ts"
import { fieldTerm, type UntypedTerm, untypedTerm } from "#compiler/query/build/terms.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Level } from "#compiler/schema/level.ts"
import { malformed, requireName } from "#compiler/schema/protocol.ts"
import { mint, named, record } from "#compiler/schema/record.ts"
import type { Carrier, Carriers, Minted, Term } from "#compiler/types/core/phantom.ts"
import type {
	AttachmentName,
	Decoders,
	OneName,
	ReadBack,
	WithChild
} from "#compiler/types/query/query.ts"

/** The attachment name: a new field of the parent's heading. */
export const attachmentName = (name: unknown, parent: Heading, label: string): string => {
	const n = requireName(name, label, "an attachment name")
	if (hasName(parent, n)) {
		throw malformed(
			label,
			`a new field name for the attachment; ${JSON.stringify(n)} is already in the heading`
		)
	}
	return n
}

/** The delivery names, each the delivery it names. */
const deliveryNames: ReadonlyMap<unknown, Delivery> = new Map<unknown, Delivery>([
	["array", "array"],
	["option", "option"],
	["one", "one"]
])

/** The delivery a caller states, parsed: a delivery name; anything else a JavaScript caller passes is refused. */
export const statedDelivery = (delivery: unknown, label: string): Delivery => {
	const stated = deliveryNames.get(delivery)
	if (stated === undefined) {
		throw malformed(label, `a delivery: "array", "option" or "one"`)
	}
	return stated
}

/** The parent's records with the child's under `name`, in a delivery the analysis must prove. */
const withChild = <Head, const Name extends string, CH, D extends Delivery>(
	parent: RowDecoder<Head>,
	name: OneName<Name>,
	child: RowDecoder<CH>,
	delivery: D
): RowDecoder<WithChild<Head, Name, CH, D>> =>
	merge(
		parent,
		record(named<Name, RecordField<Delivered<CH>[D]>>(name, attachment(child, delivery)))
	)

/** How a read inside a write transaction reads each stated delivery (types/query ReadBack). */
const readBack: ReadBack = { array: "array", option: "option", one: "option" }

/**
 * The decoders of a parent with an attachment under `name`, in the stated delivery: under the snapshot reading the
 * child's records as an array, an Option or the one child (types/query WithChild), and under a read-back's the child's
 * read-back records as an array or an Option (ReadBack). The delivery's kind keys both.
 */
export const attachedDecoders = <
	Head,
	IHead,
	const Name extends string,
	CH,
	CI,
	K extends Delivery
>(
	parent: Decoders<Head, IHead>,
	name: AttachmentName<Name, Head>,
	child: Decoders<CH, CI>,
	delivery: K
): Decoders<WithChild<Head, Name, CH, K>, WithChild<IHead, Name, CI, ReadBack[K]>> => ({
	rows: withChild<Head, Name, CH, K>(parent.rows, name, child.rows, delivery),
	immediate: withChild<IHead, Name, CI, ReadBack[K]>(
		parent.immediate,
		name,
		child.immediate,
		readBack[delivery]
	)
})

/**
 * The parent variables of an attachment's child under `scope`: a term over each field of the parent's heading, minted
 * over its carrier, typed where the builder knows the field's type; a field the parent carries no column for, every
 * field of a described parent (state.ts QueryCarriers, whose carriers are the empty heading), an untyped term. Each
 * names its field by a reference to `scope` (ir/open.ts ParentRef). Their origins are the caller's phantom statement.
 */
export const parentVars = <Origins, C extends Carriers>(
	scope: AttachScope,
	parent: Heading,
	carriers: C
): Readonly<Record<string, UntypedTerm>> & Minted<C, Origins> => {
	const untyped: Record<string, UntypedTerm> = {}
	for (const field of parent.fields.keys()) {
		if (!Object.hasOwn(carriers, field)) {
			untyped[field] = untypedTerm({ kind: "parent", column: { scope, column: field } })
		}
	}
	const minted = mint<Origins, C>(
		carriers,
		<A, S extends SqlTag>(carrier: Carrier<A, S>, field: string): Term<A, unknown, unknown, S> =>
			fieldTerm(
				{ kind: "parent", column: { scope, column: field } },
				headingField(parent, field, "Query.attach"),
				carrier
			)
	)
	return { ...untyped, ...minted }
}

/**
 * Attachments.
 *
 * `attach(name, (parent) => child, delivery)` nests a child query per parent fact. The child correlates through the
 * parent's variables exactly as `bind` correlates through parameters: each parent variable is a term `{ kind:
 * "parent", column }` over a scalar field of the parent's heading, typed like that field, so the scalar catalogue and literal
 * operands compose with it. The child is a Query or an Ordered (whose delivered array follows its completed order);
 * whether it binds a parent variable is the checker's (AttachedParentUnbound).
 *
 * The delivery is stated: every child ("array"), at most one ("option") or exactly one ("one"). The parent's decoders
 * are built from it (attachedDecoders): its records
 * with the child's records under the attachment's name, in that delivery. The type level checks the stated delivery
 * against the child's evidence (types/evidence DeliveryClaim), and the decoder's binding against the delivery the
 * analysis proves (core/decoder.ts attachment), so a delivery neither proves is refused.
 *
 * A parent variable is visible to the rules of the attachment's own child, its top-level arms (rules, union arms and
 * recursive arms reachable through the child's stages), and nowhere else. An imported query, an interior stage or a
 * nested attachment that needs the value receives it through `Q.bind` or its own parent variables; reaching it by
 * capture would be indistinguishable in the Description from a variable of the inner scope, so it is refused (scope.ts):
 * a rule spells a parent variable by its bare column only while its attachment's child runs, and keeps that attachment
 * among its pending ones; an interior stage or an imported query refuses a pending rule; and the child, when it
 * returns, refuses any pending attachment but its own.
 *
 * The child is a query over a level of the parent's schema, written over `over`, as a rule's source is (scope.ts
 * requireLevel): a query over another schema is ForeignLevel, though the two share every relation it reads.
 *
 * Runs an attachment's child: `run` builds it under the attachment's scope, from the parent variables of that scope.
 * The child it built, a query or ordered value, is returned beside the attachment's Description.
 */
export const runAttach = <V>(
	name: string,
	run: (scope: AttachScope) => V,
	label: string,
	over: Level
): { readonly desc: AttachDesc; readonly child: V; readonly state: QueryState } => {
	const loc = captureLoc(label, [name])
	const scope = newAttachScope()
	const child = withAttach(scope, () => run(scope))
	const state = queryState(child)
	if (state === undefined) {
		throw malformed(
			label,
			"a child that is a query or an ordered query built with query(S), over the parent's variables"
		)
	}
	requireLevel(state.schema.over, over, label)
	for (const pending of state.pending) {
		if (pending !== scope) {
			throw malformed(
				label,
				pending.active
					? "a parent variable of this attachment only: an enclosing attachment's parent variable reaches a nested child through the intermediate child's head"
					: "a parent variable inside the attachment child that received it"
			)
		}
	}
	return { desc: { name, child: state.desc, loc }, child, state }
}
