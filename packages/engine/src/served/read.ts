import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Prepared, prepared } from "#compiler/core/prepared.ts"
import type { Delivered, Heading } from "#compiler/ir/rel.ts"
import type { DeclaredParamSlot, ProgramDelivery } from "#compiler/lower/conservative/types.ts"
import type { PartDivision, TaggedPart } from "#compiler/lower/parts.ts"
import type { ChoiceInput, RelationInput } from "#compiler/lower/shapes/take/index.ts"
import type { StatementForms } from "#compiler/runtime/lower/forms.ts"
import type { FusedLayout } from "#compiler/runtime/lower/fused.ts"
import type { StatementRole } from "#compiler/runtime/lower/tree.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"

/**
 * A compiled read as the runtime runs it: its statement with the text it sends, its parts in their tree, and its
 * delivered spine, data alone, which a served file carries and a read, a page and a write's read-back are rebuilt
 * from. Every projection here copies, member by member, exactly what the runtime reads of a compiled structure, its
 * AST, IR nodes and encoders left behind, and names each statement's text (core/prepared.ts); a compiled structure is
 * assignable to its served type over the spec it emitted (EmittedSpec), so the compile path serves it too.
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

/**
 * What the runtime reads of a statement's spec: the text it sends with the name it is prepared under
 * (core/prepared.ts), and the heading of its output columns.
 */
export interface ServedSpec {
	readonly text: Prepared<EmittedText>
	readonly heading: Heading
}

/** A statement's spec as the compiler emits it: its text, not yet named, and its output heading. */
export interface EmittedSpec {
	readonly sql: EmittedText
	readonly heading: Heading
}

/**
 * A statement's form as an execution sends it: its placeholders in number order, and the spec emitted from it, a
 * served one's by default.
 */
export interface ServedForm<Slot, Spec = ServedSpec> {
	readonly statement: { readonly params: ReadonlyArray<Slot> }
	readonly spec: Spec
}

/** A per-execution choice of a statement's form: an input above its threshold sends the large form. */
export interface ServedChoice<Source extends ChoiceInput> {
	readonly source: Source
	readonly threshold: number
}

/**
 * A delivered relation of a program as the runtime reads its rows (shapes/index.ts DeliveredPart), the lowered
 * statement's AST and IR left behind: its role (an attachment's with its parent key), the heading of the relation it
 * delivers, its fused attachments, and the position of its rows among the runs of the program's answer.
 */
export interface ServedPart {
	readonly role: StatementRole
	readonly heading: Heading
	readonly fused: ReadonlyArray<ServedFused>
	readonly answer: number
}

/**
 * The statement a program sends as the runtime runs it, with the spec emitted from it, a served one's by default: its
 * placeholders and its forms.
 */
export interface ServedSentStatement<Slot, Source extends ChoiceInput, Spec = ServedSpec> {
	readonly params: ReadonlyArray<Slot>
	readonly forms: StatementForms<ServedChoice<Source>, ServedForm<Slot, Spec>>
	readonly spec: Spec
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

/**
 * A program as the runtime runs it: the one statement it sends, how its rows divide into parts, and each part's
 * delivered relation, in their tree.
 */
export interface ServedProgram<Slot, Source extends ChoiceInput, Spec = ServedSpec> {
	readonly statement: ServedSentStatement<Slot, Source, Spec>
	readonly parts: PartDivision
	readonly roots: ServedRoots<ServedPart>
}

/**
 * A read's artifact as the runtime runs it: its program, every placeholder a declared parameter's and every choice a
 * relation parameter's count, and how its parts' rows are delivered; over the specs the compiler emitted
 * (EmittedSpec), the compiled artifact servedSource serves.
 */
export interface ServedSource<Spec = ServedSpec> extends ServedProgram<
	DeclaredParamSlot,
	RelationInput,
	Spec
> {
	readonly delivery: ProgramDelivery
}

/**
 * One read-back of a compiled ChangeSet as the runtime runs it: its name in the ChangeSet's reads, its query's
 * delivered spine, and its statements as they reach the server (`carried`).
 */
export interface ServedReadBack {
	readonly name: string
	readonly spine: ServedSpine
	readonly carried: ServedCarried
}

/**
 * How a read-back's statement reaches the server (write/program/artifact.ts ReadBackCarried): `sent`, its own statement
 * behind the writes, its program a read's served source; or `riding`, a part of the write statement at artifact
 * position `statement`, whose rows behind the part's tag `tag` are its statement's rows (TaggedPart `part`), its
 * program its parts as their rows are read, with no text (ServedRiddenSource).
 */
export type ServedCarried =
	| { readonly kind: "sent"; readonly source: ServedSource }
	| {
			readonly kind: "riding"
			readonly source: ServedRiddenSource
			readonly statement: number
			readonly tag: number
			readonly part: TaggedPart
	  }

/**
 * A riding read-back's program as the runtime reads its rows: how its statement's rows divide into parts, its parts in
 * their tree, and how their rows are delivered. The statement it rides sends its statement, so it has no text,
 * placeholder or form of its own.
 */
export interface ServedRiddenSource {
	readonly delivery: ProgramDelivery
	readonly parts: PartDivision
	readonly roots: ServedRoots<ServedPart>
}

/**
 * The delivered spine of a read, from its root: each delivered attachment by name, its child's head keys, and the
 * delivered attachments under it, which say which correlation columns a child carries (carried).
 */
export interface ServedSpine {
	readonly under: ReadonlyMap<string, ServedSpineAttachment>
}

/** A delivered attachment of a spine: its child's head keys, and the delivered attachments under it. */
export interface ServedSpineAttachment extends ServedSpine {
	readonly heads: ReadonlySet<string>
}

/**
 * Whether an attachment's delivered child carries the child column `column`: every child column but the correlation
 * columns no head key delivers. `scope` is where the attachment is on the delivered spine, none off it.
 *
 * An attachment delivers its child query's head: the checker adds a correlation column to the child for each parent
 * variable the child reads, delivered under a head key when one delivers that variable and under a fresh name clear of
 * every head key otherwise (check/checker.ts attach). A correlation column no head key delivers equals the parent's
 * value and is not part of the delivered child.
 */
export const carried = (
	attach: ServedAttach,
	scope: ServedSpine | undefined,
	column: string
): boolean =>
	!attach.correlation.some((c) => c.child === column) ||
	scope?.under.get(attach.name)?.heads.has(column) === true

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

/**
 * A statement's spec as the runtime reads it: the text it sends, named here (core/prepared.ts), and its output heading.
 */
const servedSpec = (spec: EmittedSpec): ServedSpec => ({
	text: prepared(spec.sql),
	heading: servedHeading(spec.heading)
})

/** A per-execution choice as the runtime reads it: its input and threshold. */
const servedChoice = <Source extends ChoiceInput>(
	choice: ServedChoice<Source>
): ServedChoice<Source> => ({ source: choice.source, threshold: choice.threshold })

/** A delivered relation as the runtime reads its rows (ServedPart). */
const servedPart = (part: ServedPart): ServedPart => ({
	role: servedRole(part.role),
	heading: servedHeading(part.heading),
	fused: part.fused.map(servedFused),
	answer: part.answer
})

/** A program's statement with its spec, each form served. */
const servedStatement = <Slot, Source extends ChoiceInput>(
	statement: ServedSentStatement<Slot, Source, EmittedSpec>
): ServedSentStatement<Slot, Source> => {
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
	return { params: statement.params, forms, spec: servedSpec(statement.spec) }
}

/** How a statement's rows divide into parts, as the runtime reads them. */
const servedDivision = (parts: PartDivision): PartDivision =>
	parts.kind === "one"
		? { kind: "one" }
		: { kind: "tagged", parts: mapNonEmpty(parts.parts, (p) => ({ kind: p.kind, width: p.width })) }

/** A program's parts in their tree, each as the runtime reads it. */
const servedParts = (roots: ServedRoots<ServedPart>): ServedRoots<ServedPart> =>
	mapNonEmpty(roots, (tree) => servedTree(tree, servedPart))

/** A program as the runtime runs it (ServedProgram), over the specs the compiler emitted. */
export const servedProgram = <Slot, Source extends ChoiceInput>(
	program: ServedProgram<Slot, Source, EmittedSpec>
): ServedProgram<Slot, Source> => ({
	statement: servedStatement(program.statement),
	parts: servedDivision(program.parts),
	roots: servedParts(program.roots)
})

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
export const servedSource = (run: ServedSource<EmittedSpec>): ServedSource => ({
	...servedProgram(run),
	delivery: run.delivery
})

/** A riding read-back's program as the runtime reads its rows (ServedRiddenSource). */
export const servedRiddenSource = (run: ServedRiddenSource): ServedRiddenSource => ({
	delivery: run.delivery,
	parts: servedDivision(run.parts),
	roots: servedParts(run.roots)
})
