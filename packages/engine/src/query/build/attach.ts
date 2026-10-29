import type { Option } from "effect"
import {
	attachment,
	type Decoded,
	type Delivered,
	type Delivery,
	merge,
	type Named,
	noChild,
	type RecordField,
	type Row,
	type RowDecoder,
	someChild
} from "#compiler/core/decoder.ts"
import * as Result from "#compiler/core/result.ts"
import type { AttachDesc } from "#compiler/ir/desc.ts"
import { type Heading, hasName, headingField } from "#compiler/query/build/heading.ts"
import {
	type AttachScope,
	buildLoc,
	isObjectRecord,
	newAttachScope,
	withAttach
} from "#compiler/query/build/scope.ts"
import { queryState } from "#compiler/query/build/state.ts"
import { fieldTerm, type UntypedTerm, untypedTerm } from "#compiler/query/build/terms.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import { isName, malformed, requireName } from "#compiler/schema/protocol.ts"
import { mint, named, record } from "#compiler/schema/record.ts"
import type { Carrier, Carriers, Minted, Term } from "#compiler/types/core/phantom.ts"
import type {
	Arm,
	ArmNone,
	ArmSome,
	AttachedHeads,
	AttachmentName,
	Decoders,
	DeliveryArg,
	DeliveryKind,
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

/**
 * arm(field, handle): the attachment is the arm of `handle` of an alternatives law, keyed by the parent's key, and
 * `field` the parent's head field that holds the parent's discriminator.
 */
export const arm = <const F extends string, const Hd extends string>(
	field: F,
	handle: Hd
): Arm<"arm", F, Hd> => {
	requireName(field, "arm", "the parent's head field that holds its discriminator")
	requireName(handle, "arm", "the handle whose arm the attachment is")
	return Object.freeze({ kind: "arm", field, handle })
}

const deliveryNames: ReadonlySet<unknown> = new Set<Delivery>(["array", "option", "one"])

/**
 * Refuses a delivery a JavaScript caller passes that is none: a delivery name, or an arm whose field is a scalar field
 * of the parent's heading.
 */
export const checkDelivery = (delivery: unknown, parent: Heading, label: string): void => {
	if (deliveryNames.has(delivery)) {
		return
	}
	if (
		!isObjectRecord(delivery) ||
		delivery["kind"] !== "arm" ||
		!isName(delivery["field"]) ||
		!isName(delivery["handle"])
	) {
		throw malformed(label, `a delivery: "array", "option", "one" or arm(field, handle)`)
	}
	if (!parent.fields.has(delivery["field"])) {
		throw malformed(
			label,
			`an arm whose field is a field of the parent's heading; ${JSON.stringify(delivery["field"])} is not one`
		)
	}
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

/**
 * The parent's records with the arm of handle `handle` under `name`, chosen by the parent's decoded `field`: where it
 * is another handle, the record holds that handle there and None; where it is `handle`, it holds `handle` and Some of
 * the child.
 */
const armed = <
	Head,
	const Name extends string,
	CH,
	F extends keyof Head & string,
	Hd extends string
>(
	parent: RowDecoder<Head>,
	name: OneName<Name>,
	child: RowDecoder<CH>,
	field: F,
	handle: Hd
): RowDecoder<ArmSome<Head, Name, CH, F, Hd> | ArmNone<Head, Name, CH, F, Hd>> => {
	type Chosen = Head & { readonly [K in F]: Hd } & Decoded<
			[Named<Name, RecordField<Option.Some<CH>>>]
		>
	type Other = Head & { readonly [K in F]: Exclude<Head[F], Hd> } & Decoded<
			[Named<Name, RecordField<Option.None<CH>>>]
		>
	const some = record(named<Name, RecordField<Option.Some<CH>>>(name, someChild(child)))
	const none = record(named<Name, RecordField<Option.None<CH>>>(name, noChild(child)))
	const isOther = (value: Head[F]): value is Exclude<Head[F], Hd> => value !== handle
	return {
		headings: merge(parent, some).headings,
		bind: (layout, options) =>
			Result.flatMap(parent.bind(layout, options), (readHead) =>
				Result.flatMap(some.bind(layout, options), (readSome) =>
					Result.map(none.bind(layout, options), (readNone) => (row: Row): Chosen | Other => {
						const head = readHead(row)
						const value = head[field]
						if (isOther(value)) {
							const other: Other = Object.freeze({ ...head, [field]: value, ...readNone(row) })
							return other
						}
						const chosen: Chosen = Object.freeze({ ...head, [field]: handle, ...readSome(row) })
						return chosen
					})
				)
			)
	}
}

/** How a read inside a write transaction reads each stated delivery (types/query ReadBack). */
const readBack: ReadBack = { array: "array", option: "option", one: "option", arm: "option" }

/**
 * The decoders of a parent with an attachment under `name`, in the stated delivery: under the snapshot reading the
 * child's records as an array, an Option, the one child or an arm (types/query AttachedHeads), and under a
 * read-back's the child's read-back records as an array or an Option (ReadBack). The delivery's kind keys both.
 */
export const attachedDecoders = <
	Head,
	IHead,
	const Name extends string,
	CH,
	CI,
	K extends DeliveryKind,
	F extends keyof Head & string,
	Hd extends string
>(
	parent: Decoders<Head, IHead>,
	name: AttachmentName<Name, Head>,
	child: Decoders<CH, CI>,
	delivery: DeliveryArg<K, F, Hd>
): Decoders<AttachedHeads<Head, Name, CH, F, Hd>[K], WithChild<IHead, Name, CI, ReadBack[K]>> => {
	const rows: {
		readonly [P in DeliveryKind]: (
			stated: DeliveryArg<P, F, Hd>
		) => RowDecoder<AttachedHeads<Head, Name, CH, F, Hd>[P]>
	} = {
		array: () => withChild<Head, Name, CH, "array">(parent.rows, name, child.rows, "array"),
		option: () => withChild<Head, Name, CH, "option">(parent.rows, name, child.rows, "option"),
		one: () => withChild<Head, Name, CH, "one">(parent.rows, name, child.rows, "one"),
		arm: (stated) =>
			armed<Head, Name, CH, F, Hd>(parent.rows, name, child.rows, stated.field, stated.handle)
	}
	const kind: K = typeof delivery === "string" ? delivery : delivery.kind
	return {
		rows: rows[kind](delivery),
		immediate: withChild<IHead, Name, CI, ReadBack[K]>(
			parent.immediate,
			name,
			child.immediate,
			readBack[kind]
		)
	}
}

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
 * "parent", column }` over a scalar field of the parent's heading, typed like that field, so Compute and literal
 * operands compose with it. The child is a Query or an Ordered (whose delivered array follows its completed order);
 * whether it binds a parent variable is the checker's (AttachedParentUnbound).
 *
 * The delivery is stated: every child ("array"), at most one ("option"), exactly one ("one"), or the arm of one handle
 * of an alternatives law, `arm(field, handle)`. The parent's decoders are built from it (attachedDecoders): its records
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
 * Runs an attachment's child: `run` builds it under the attachment's scope, from the parent variables of that scope.
 * The child it built, a query or ordered value, is returned beside the attachment's Description.
 */
export const runAttach = <V>(
	name: string,
	run: (scope: AttachScope) => V,
	label: string
): { readonly desc: AttachDesc; readonly child: V } => {
	const loc = buildLoc(label, [name])
	const scope = newAttachScope()
	const child = withAttach(scope, () => run(scope))
	const state = queryState(child)
	if (state === undefined) {
		throw malformed(
			label,
			"a child that is a query or an ordered query built with query(S), over the parent's variables"
		)
	}
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
	return { desc: { name, child: state.desc, loc }, child }
}
