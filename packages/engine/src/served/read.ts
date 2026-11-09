import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Delivered, Heading } from "#compiler/ir/rel.ts"
import type {
	DeclaredParamSlot,
	ProgramDelivery,
	StatementRole
} from "#compiler/lower/conservative/types.ts"
import type { FusedLayout } from "#compiler/lower/shapes/attach/decode.ts"
import type { Arrival, StatementForms } from "#compiler/lower/shapes/index.ts"
import type { ChoiceInput, RelationInput } from "#compiler/lower/shapes/take/index.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"

/**
 * A compiled read as the runtime runs it: its statements in their tree, each with the text it sends, and its delivered
 * spine, data alone, which a served file carries and a read, a page and a write's read-back are rebuilt from. Every
 * projection here copies, member by member, exactly what the runtime reads of a compiled structure, its AST, IR nodes
 * and encoders left behind; a compiled structure is assignable to its served type, so the compile path serves it too.
 *
 * What the runtime reads of an attachment, the Attach node of the compiled program it holds no more: its name, the
 * child columns its correlation equates with the parent's, and the delivery the analysis judged.
 */
export interface ServedAttach {
	readonly name: string
	readonly correlation: ReadonlyArray<{ readonly child: string }>
	readonly judged: Delivered
}

/** An attachment fused into its parent's statement, as the runtime splits its column into children. */
export interface ServedFused {
	readonly name: string
	readonly layout: FusedLayout
	readonly attach: ServedAttach
}

/** What the runtime reads of a statement's spec: the text it sends, and the heading of its output columns. */
export interface ServedSpec {
	readonly sql: EmittedText
	readonly heading: Heading
}

/** A statement's form as an execution sends it: its placeholders in number order, and the spec emitted from it. */
export interface ServedForm<Slot> {
	readonly statement: { readonly params: ReadonlyArray<Slot> }
	readonly spec: ServedSpec
}

/** A per-execution choice of a statement's form: an input above its threshold sends the large form. */
export interface ServedChoice<Source extends ChoiceInput> {
	readonly source: Source
	readonly threshold: number
}

/**
 * A statement as the runtime runs it, the lowered statement's AST and IR left behind: its role (an attachment's with
 * its parent key), the heading of the relation it delivers, its fused attachments, its placeholders, its forms and
 * how the runtime has its rows.
 */
export interface ServedRunStatement<Slot, Source extends ChoiceInput> {
	readonly role: StatementRole
	readonly heading: Heading
	readonly fused: ReadonlyArray<ServedFused>
	readonly params: ReadonlyArray<Slot>
	readonly forms: StatementForms<ServedChoice<Source>, ServedForm<Slot>>
	readonly arrival: Arrival
}

/** A statement with the spec emitted from it. */
export interface ServedSpecified<Slot, Source extends ChoiceInput> {
	readonly statement: ServedRunStatement<Slot, Source>
	readonly spec: ServedSpec
}

/** A statement of a program and the attachment statements stitched onto its rows, in emission order. */
export interface ServedTree<S> {
	readonly statement: S
	readonly attachments: ReadonlyArray<ServedAttached<S>>
}

/** An attachment statement under its parent's rows. */
export interface ServedAttached<S> extends ServedTree<S> {
	readonly attach: ServedAttach
}

/** A program's delivered statements, its main statement or one per heading group, in group order. */
export type ServedRoots<S> = NonEmptyReadonlyArray<ServedTree<S>>

/** A read statement: every placeholder a declared parameter's, every choice a relation parameter's count. */
export type ServedReadStatement = ServedSpecified<DeclaredParamSlot, RelationInput>

/** A read's artifact as the runtime runs it: its statements in their tree, and how their rows are delivered. */
export interface ServedSource {
	readonly delivery: ProgramDelivery
	readonly roots: ServedRoots<ServedReadStatement>
}

/**
 * The delivered spine of a read, from its root: each delivered attachment by name, its child's head keys, and the
 * delivered attachments under it, which say which correlation columns a child carries (adapter reader/analysis.ts).
 */
export interface ServedSpine {
	readonly under: ReadonlyMap<string, ServedSpineAttachment>
}

export interface ServedSpineAttachment extends ServedSpine {
	readonly heads: ReadonlySet<string>
}

/** A heading as the runtime reads it: each column's name and type. */
export const servedHeading = (heading: Heading): Heading =>
	heading.map((column) => ({ name: column.name, type: column.type }))

/** An attachment as the runtime reads it: its name, its correlation's child columns and the delivery it judged. */
const servedAttach = (attach: ServedAttach): ServedAttach => ({
	name: attach.name,
	correlation: attach.correlation.map((c) => ({ child: c.child })),
	judged: attach.judged
})

const servedFused = (fused: ServedFused): ServedFused => ({
	name: fused.name,
	layout: {
		columns: fused.layout.columns.map((c) => ({
			column: { name: c.column.name, type: c.column.type },
			source: c.source
		}))
	},
	attach: servedAttach(fused.attach)
})

const servedRole = (role: StatementRole): StatementRole => {
	switch (role.kind) {
		case "main":
			return { kind: "main" }
		case "headingGroup":
			return { kind: "headingGroup", group: role.group }
		case "attachment":
			return {
				kind: "attachment",
				parentKey: role.parentKey.map((k) => ({ name: k.name, type: k.type, at: k.at }))
			}
	}
}

/** A statement's spec as the runtime reads it: the text it sends and its output heading. */
export const servedSpec = (spec: ServedSpec): ServedSpec => ({
	sql: spec.sql,
	heading: servedHeading(spec.heading)
})

/** A per-execution choice as the runtime reads it: its input and threshold. */
export const servedChoice = <Source extends ChoiceInput>(
	choice: ServedChoice<Source>
): ServedChoice<Source> => ({ source: choice.source, threshold: choice.threshold })

/** A statement as the runtime runs it (ServedRunStatement), its forms `forms` as the caller served them. */
export const servedRunStatement = <Slot, Source extends ChoiceInput>(
	statement: Omit<ServedRunStatement<Slot, Source>, "forms">,
	forms: ServedRunStatement<Slot, Source>["forms"]
): ServedRunStatement<Slot, Source> => ({
	role: servedRole(statement.role),
	heading: servedHeading(statement.heading),
	fused: statement.fused.map(servedFused),
	params: statement.params,
	forms,
	arrival: statement.arrival
})

/** A statement with its spec, each form served. */
const servedSpecified = <Slot, Source extends ChoiceInput>(
	specified: ServedSpecified<Slot, Source>
): ServedSpecified<Slot, Source> => {
	const { statement } = specified
	const forms: StatementForms<ServedChoice<Source>, ServedForm<Slot>> = statement.forms.kind ===
	"one"
		? { kind: "one" }
		: {
				kind: "chosen",
				choices: mapNonEmpty(statement.forms.choices, servedChoice),
				large: {
					statement: { params: statement.forms.large.statement.params },
					spec: servedSpec(statement.forms.large.spec)
				}
			}
	return { statement: servedRunStatement(statement, forms), spec: servedSpec(specified.spec) }
}

/** A statement tree, each statement served by `serve` and each attachment as the runtime reads it. */
export const servedTree = <A, B>(
	tree: ServedTree<A>,
	serve: (statement: A) => B
): ServedTree<B> => ({
	statement: serve(tree.statement),
	attachments: tree.attachments.map((attached): ServedAttached<B> => ({
		...servedTree(attached, serve),
		attach: servedAttach(attached.attach)
	}))
})

/** A read's artifact as the runtime runs it (ServedSource): a template's `run`, or a read-back's, served. */
export const servedSource = (run: ServedSource): ServedSource => ({
	delivery: run.delivery,
	roots: mapNonEmpty(run.roots, (tree) => servedTree(tree, servedSpecified))
})
