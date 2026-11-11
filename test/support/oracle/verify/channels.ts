import { Array as Arr } from "effect"
import { cellKindOf, deliveryOf, resultWidth } from "#compiler/codec/delivery.ts"
import { appendAll, maxOf } from "#compiler/core/array.ts"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import { flight, type ProgramDelivery } from "#compiler/lower/conservative/types.ts"
import {
	deliveredHeading,
	keyColumns,
	type RowsRole,
	type StatementOutput,
	statementOutput,
	type StatementRoots,
	type StatementTree
} from "#compiler/runtime/lower/tree.ts"

import type {
	DeliveredPart,
	FusedStatement,
	SentStatement,
	StatementParts
} from "#compiler/lower/shapes/index.ts"
import {
	type FusedAttachment,
	type FusedLayout,
	fusedElement
} from "#compiler/runtime/lower/fused.ts"
import type { SelectBody, Target, TypeRef } from "#compiler/sql/ast.ts"
import { builtinType } from "#compiler/sql/build.ts"
import { type Lexed, lex } from "#compiler/sql/lexer.ts"
import { bodyPositionNames } from "#compiler/sql/naming.ts"
import { printStatement, printType } from "#compiler/sql/print.ts"
import { problem, type VerificationProblem } from "#test/support/oracle/verify/problems.ts"
import { rowsViolations } from "#test/support/oracle/verify/rows.ts"
import {
	auditStatementDetailed,
	auditTextViolations,
	type StatementAudit
} from "#test/support/oracle/verify/sql.ts"

/** The array of a column's type, as an input array's placeholder is cast; bit(n) has no array TypeRef, so none. */
const arrayOf = (type: TypeRef): TypeRef | undefined =>
	type.kind === "builtin" && type.name === "bit" ? undefined : { ...type, array: true }

/** A fused attachment's delivered heading: its child's (deliveredHeading). */
export const fusedHeading = (f: FusedAttachment): Heading =>
	deliveredHeading(Arr.map(f.layout.columns, (c) => c.column))

/**
 * A program as its channels are checked: the one statement it sends, in one of its forms, how its rows divide into
 * parts, its parts' delivered relations in their tree, and how the runtime delivers them.
 */
export interface ChannelProgram {
	readonly statement: SentStatement
	readonly parts: StatementParts
	readonly roots: StatementRoots<DeliveredPart>
	readonly delivery: ProgramDelivery
}

const sameType = (a: TypeRef | undefined, b: TypeRef): boolean =>
	a !== undefined && canonicalEquals(a, b, everyProperty)

/** The placeholder indices a text uses, read from its tokens, never from a pattern over the text. */
const placeholderIndices = (lexed: Lexed): ReadonlySet<number> | undefined => {
	if (lexed.error !== undefined) {
		return undefined
	}
	const out = new Set<number>()
	for (const t of lexed.tokens) {
		if (t.kind === "param") {
			out.add(t.index)
		}
	}
	return out
}

const statementSql = (
	s: SentStatement,
	audit: StatementAudit,
	where: string
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	for (const v of audit.violations) {
		out.push(problem("statementAudit", where, `${v.rule} at ${v.where}: ${v.detail}`))
	}
	for (const v of rowsViolations(s.ast)) {
		out.push(problem("statementRows", where, v))
	}
	if (printStatement(s.ast) !== s.sql.text) {
		out.push(problem("statementText", where, "the text the AST prints"))
	}
	for (const v of auditTextViolations(s.sql.text)) {
		out.push(problem("statementText", where, `${v.rule} at ${v.where}: ${v.detail}`))
	}
	const n = s.params.length
	if (audit.params.length !== n) {
		out.push(
			problem(
				"placeholders",
				where,
				`one placeholder type per parameter slot: ${n} slots and ${audit.params.length} audited types`
			)
		)
	}
	const used = placeholderIndices(lex(s.sql.text))
	if (used === undefined) {
		out.push(problem("placeholders", where, "text the lexer reads"))
	} else {
		for (const i of Arr.filter([...used], (at) => at < 1 || at > n)) {
			out.push(problem("placeholders", `${where} $${i}`, `a placeholder within $1..$${n}`))
		}
		for (const i of Arr.filter(
			Arr.map([...s.params.keys()], (k) => k + 1),
			(slot) => !used.has(slot)
		)) {
			out.push(problem("placeholders", `${where} $${i}`, "a parameter slot the text uses"))
		}
	}
	return out
}

/**
 * One parameter slot's problems against the placeholder type the statement emits for it.
 *
 * A declared scalar parameter is one placeholder cast to the slot's type.
 *
 * A relation parameter is one placeholder per array, each cast to its column's type made an array, or an input of no
 * column's count cast to bigint, under distinct column names.
 */
const slotProblem = (
	slot: FusedStatement["params"][number],
	emitted: TypeRef | undefined,
	at: string
): ReadonlyArray<VerificationProblem> => {
	switch (slot.kind) {
		case "scalar":
			return sameType(emitted, slot.sqlType)
				? []
				: [
						problem(
							"paramTypes",
							at,
							`the slot's cast ${printType(slot.sqlType)}, not ${emitted === undefined ? "none" : printType(emitted)}`
						)
					]
		case "relation": {
			const names = Arr.map(slot.columns, (c) => c.definition.name)
			const part = slot.part
			const column = part.kind === "column" ? slot.columns[part.index] : undefined
			const expected: TypeRef | undefined =
				part.kind === "count"
					? builtinType("bigint")
					: column === undefined
						? undefined
						: arrayOf(column.definition.type)
			return [
				...(expected !== undefined && sameType(emitted, expected)
					? []
					: [
							problem(
								"paramTypes",
								at,
								part.kind === "count"
									? "an input count placeholder cast to bigint"
									: "an input array placeholder cast to its column's type made an array"
							)
						]),
				...(new Set(names).size === names.length
					? []
					: [problem("paramCodec", at, "distinct column names for the input's arrays")])
			]
		}
	}
}

/** Each parameter slot's problems against the placeholder type its AST's audit reads for it. */
const slotProblems = (
	s: SentStatement,
	audit: StatementAudit,
	where: string
): ReadonlyArray<VerificationProblem> =>
	Arr.flatMap(s.params, (slot, j) => slotProblem(slot, audit.params[j], `${where} $${j + 1}`))

/** The outermost core's targets, when the body is one (a set operation's columns are its left arm's, unfused). */
const outerTargets = (body: SelectBody): ReadonlyArray<Target> | undefined =>
	body.kind === "core" ? body.targets : body.kind === "select" ? outerTargets(body.body) : undefined

/**
 * How a fused column is written: text[] of the one field its element carries, or of the existence marker for none, and
 * jsonb[] of to_jsonb objects for several.
 */
const fusedForm = (layout: FusedLayout): "array" | "jsonb" =>
	fusedElement(layout).length <= 1 ? "array" : "jsonb"

/**
 * A fused attachment's own structure: its column is written in its layout's form, its carried columns and its
 * correlation read parent columns it delivers, and its fields have distinct names.
 */
const fusedProblems = (
	f: FusedAttachment,
	parentHeading: ReadonlyArray<string>,
	target: Target | undefined,
	where: string
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	const at = `${where} fused ${f.name}`
	const form = fusedForm(f.layout)
	if (
		Arr.some(
			f.layout.columns,
			(c) => c.source.from === "parent" && !f.parentColumns.includes(c.source.parent)
		)
	) {
		out.push(
			problem("attachment", at, "each carried child column from a parent column it correlates on")
		)
	}
	if (Arr.some(f.parentColumns, (c) => !parentHeading.includes(c))) {
		out.push(problem("attachment", at, "a correlation on columns its parent delivers"))
	}
	if (target !== undefined) {
		const inner = target.expr.kind === "array" ? outerTargets(target.expr.query.body) : undefined
		const element = inner?.length === 1 ? inner[0]?.expr : undefined
		const jsonbType =
			element?.kind === "call" && element.fn.kind === "builtin" && element.fn.name === "to_jsonb"
		if (element === undefined || (form === "jsonb") !== jsonbType) {
			out.push(
				problem(
					"attachment",
					at,
					form === "jsonb"
						? "an ARRAY(SELECT to_jsonb(c) ...) column"
						: "an ARRAY(SELECT ...) column"
				)
			)
		}
	}
	const names = Arr.map(fusedHeading(f), (c) => c.name)
	if (new Set(names).size !== names.length) {
		out.push(problem("attachment", at, "distinct element field names"))
	}
	return out
}

/**
 * A delivered relation's fused attachment columns against its output: each named as no other output column is, and each
 * its own structure (fusedProblems), its column the target `targets` holds at its place when the relation's lowered
 * statement is at hand.
 */
const fusedColumnProblems = (
	output: StatementOutput<FusedAttachment>,
	fused: ReadonlyArray<FusedAttachment>,
	targets: ReadonlyArray<Target> | undefined,
	where: string
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	/** An attachment's parent key may repeat a name the child also binds; a fused column's name is its own. */
	const delivered = Arr.map(output.heading, (c) => c.name)
	const fusedNames = Arr.map(fused, (f) => f.name)
	if (
		Arr.some(fusedNames, (name) => delivered.includes(name)) ||
		new Set(fusedNames).size !== fusedNames.length
	) {
		out.push(
			problem("resultColumns", where, "a fused attachment column name no other output column has")
		)
	}
	for (const [j, f] of fused.entries()) {
		appendAll(out, fusedProblems(f, delivered, targets?.[output.fusedAt(j)], where))
	}
	return out
}

/**
 * A program's one part as lowered, before its executable form casts its outputs to texts: its outermost output columns
 * are its output's, and its fused attachments are columns of an outermost core.
 */
const resultProblems = (s: FusedStatement, where: string): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	const names = bodyPositionNames(s.ast.body)
	const output = statementOutput(s.role, s.heading, s.fused)
	const expected = output.names
	if (names.length !== expected.length) {
		out.push(
			problem(
				"resultColumns",
				where,
				`${expected.length} output columns for the heading and fused attachments, not ${names.length}`
			)
		)
	}
	for (const [i, name] of expected.entries()) {
		if (names[i] !== name) {
			out.push(problem("resultColumns", `${where} column ${i}`, `the output name ${name}`))
		}
	}
	const targets = outerTargets(s.ast.body)
	if (s.fused.length > 0 && targets === undefined) {
		out.push(
			problem(
				"attachment",
				where,
				"fused attachments only on a statement whose outermost body is a core"
			)
		)
	}
	appendAll(out, fusedColumnProblems(output, s.fused, targets, where))
	return out
}

/**
 * The cells of each row a delivered relation's part sends (codec/delivery.ts resultWidth): its output's columns, or,
 * where one is bytes, its chunked rows' numbers, columns and lengths, as the runtime reads them
 * (adapter/reader/execution.ts).
 */
const cellsOf = (part: DeliveredPart): number => {
	const output = statementOutput(part.role, part.heading, part.fused)
	return resultWidth(
		deliveryOf([
			...Arr.map(output.heading, (c) => cellKindOf(c.type)),
			...Arr.map(output.fused, () => "text" as const)
		])
	)
}

/**
 * How the statement's rows divide into its delivered relations' (lower/parts.ts): one part's statement sends exactly
 * its one relation's cells; a statement of tagged parts sends the tag and the widest part's cells, a numbered part's
 * row number after them, and each part is the rows of one relation or more, each of whose rows has the part's cells, and
 * each relation's rows are one part's.
 */
const partProblems = (
	program: ChannelProgram,
	where: string
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	const relations = flight(program.roots)
	const width = bodyPositionNames(program.statement.ast.body).length
	const parts = program.parts
	if (parts.kind === "one") {
		const [only, ...more] = relations
		if (more.length > 0 || only.answer !== 0) {
			out.push(problem("parts", where, "one delivered relation, whose rows are the statement's"))
		}
		if (width !== cellsOf(only)) {
			out.push(problem("parts", where, `${cellsOf(only)} output columns, not ${width}`))
		}
		return out
	}
	const sent = Arr.map(parts.parts, (p) => p.width + (p.kind === "numbered" ? 1 : 0))
	const cells = maxOf(sent, 0)
	if (width !== cells + 1) {
		out.push(problem("parts", where, `the tag and ${cells} cells, not ${width} output columns`))
	}
	for (const [tag, part] of parts.parts.entries()) {
		const at = `${where} part ${tag}`
		const delivering = Arr.filter(relations, (r) => r.answer === tag)
		if (delivering.length === 0) {
			out.push(problem("parts", at, "a delivered relation whose rows it is"))
		}
		if (Arr.some(delivering, (r) => cellsOf(r) !== part.width)) {
			out.push(problem("parts", at, `${part.width} cells, those of each relation it delivers`))
		}
	}
	for (const [i, r] of relations.entries()) {
		if (!Number.isInteger(r.answer) || r.answer < 0 || r.answer >= parts.parts.length) {
			out.push(
				problem("parts", `${where} relation ${i}`, "the rows of one of the statement's parts")
			)
		}
	}
	return out
}

/**
 * The attachment statement `s` under the rows of `parent`: the runtime finds each parent key column among the parent's
 * own columns (adapter/reader/execution.ts attachedOf).
 */
const attachmentProblems = (
	parent: DeliveredPart,
	s: DeliveredPart,
	where: string
): ReadonlyArray<VerificationProblem> => {
	const own = new Set(Arr.map(parent.heading, (c) => c.name))
	return Arr.every(keyColumns(s.role), (c) => own.has(c.name))
		? []
		: [
				problem(
					"attachment",
					where,
					"the parent key columns among its parent statement's own columns"
				)
			]
}

const programShape = (program: ChannelProgram): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	const statements = flight(program.roots)
	const mains = Arr.filter(statements, (s) => s.role.kind === "main").length
	const groups = Arr.flatMap(statements, (s) =>
		s.role.kind === "headingGroup" ? [{ group: s.role.group, heading: s.heading }] : []
	)
	const delivery = program.delivery
	switch (delivery.kind) {
		case "rows":
			if (mains !== 1 || groups.length > 0) {
				out.push(
					problem(
						"statementRoles",
						"the program",
						"exactly one main statement and no heading group"
					)
				)
			}
			return out
		case "headingGroups": {
			if (mains !== 0 || groups.length === 0) {
				out.push(
					problem("statementRoles", "the program", "heading-group statements and no main statement")
				)
			}
			const indices = Arr.map(groups, (g) => g.group)
			if (Arr.some(indices, (g, i) => g !== i)) {
				out.push(
					problem("merge", "the program", "heading groups numbered 0..n-1 in statement order")
				)
			}
			appendAll(
				out,
				Arr.flatMap(groups, (g, i) =>
					Arr.map(
						Arr.filter(
							delivery.discriminant,
							(column) => !Arr.some(g.heading, (c) => c.name === column)
						),
						(d) =>
							problem("merge", `heading group ${i}`, `the discriminant column ${d} in its heading`)
					)
				)
			)
			return out
		}
	}
}

/**
 * Codec and result-channel alignment, a property of the test kernel (verify/index.ts checkedLowering).
 *
 * "Codecs and result channels align." The one statement a lowered query program sends, in the form `program` holds, is
 * checked against its own AST and the channels the runtime binds and decodes through, and so is each delivered relation
 * of its parts:
 *
 * - the AST passes the structural statement audit, the text is exactly the AST's emission, and the text passes the
 *   text audit (sql.ts): never a keyword scan;
 * - the placeholders the text uses are exactly $1..$n for the n parameter slots, the audit's type for each placeholder
 *   is the slot's cast (a scalar's base or domain type, an input array's element type made an array, bigint for an input
 *   count), and every slot has an encoder (every
 *   placeholder carries its cast);
 * - its rows divide into its relations' as the runtime divides them (partProblems): one part's statement sends its
 *   relation's cells, and a statement of tagged parts the tag and the widest part's cells, each part one relation's
 *   rows or more of the same cells;
 * - a program of one part keeps that part as lowered, whose outermost output columns are its output
 *   (conservative/types.ts statementOutput: an attachment's parent key, then the delivered relation's columns, or the
 *   private unit column of a zero-column one, then each fused attachment's), position by position and by name;
 * - an attachment's parent, the relation whose tree holds it, has own columns that hold the parent key, which the
 *   runtime stitches each child to its parent by;
 * - an attachment fused into its parent is an output column after the heading, ARRAY(SELECT ...) of one
 *   field or ARRAY(SELECT to_jsonb(c) ...) of several where the part's lowered statement is kept, correlated on
 *   delivered parent columns, each element decodable;
 * - a program delivers one main relation, or one relation per heading group carrying the union's discriminant;
 * - the optimized and conservative artifacts decode to the same public result: the same rows relations and the same
 *   attachment tree, an attachment fused on one side matching a part of its own on the other.
 *
 * Every alignment problem of a lowered query program, each located at `label`, a part's position or a relation's.
 */
export const channelProblems = (
	program: ChannelProgram,
	label: string
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = [...programShape(program)]
	const sent = program.statement
	const audit = auditStatementDetailed(sent.ast)
	appendAll(out, statementSql(sent, audit, label))
	appendAll(out, slotProblems(sent, audit, label))
	appendAll(out, partProblems(program, label))
	if (program.parts.kind === "one") {
		const delivered = program.parts.delivered
		const where = `${label} part 0`
		appendAll(out, statementSql(delivered, auditStatementDetailed(delivered.ast), where))
		appendAll(out, resultProblems(delivered, where))
	}
	let position = 0
	const relation = (part: DeliveredPart): string => {
		const where = `${label} relation ${position++}`
		if (program.parts.kind === "tagged") {
			appendAll(
				out,
				fusedColumnProblems(
					statementOutput(part.role, part.heading, part.fused),
					part.fused,
					undefined,
					where
				)
			)
		}
		return where
	}
	const under = (tree: StatementTree<DeliveredPart>): void => {
		for (const a of tree.attachments) {
			appendAll(out, attachmentProblems(tree.statement, a.statement, relation(a.statement)))
			under(a)
		}
	}
	for (const tree of program.roots) {
		relation(tree.statement)
		under(tree)
	}
	return out
}

/**
 * The public result a program decodes, whatever SQL channels carry it: per delivered rows statement its role, group
 * and heading, and its attachment tree. An attachment is keyed by its Attach node and is the same whether
 * a pipelined statement over the delivered parent keys or a column fused into its parent carries it:
 * its name, the parent columns it is stitched on, its child's heading and its own attachments.
 */
interface AttachmentShape {
	readonly name: string
	readonly parentColumns: ReadonlyArray<string>
	readonly heading: Heading
	readonly attachments: ReadonlyMap<NodeId, AttachmentShape>
}

interface RowsShape {
	readonly role: RowsRole
	readonly heading: Heading
	readonly attachments: ReadonlyMap<NodeId, AttachmentShape>
}

const fusedShape = (f: FusedAttachment): AttachmentShape => ({
	name: f.name,
	parentColumns: f.parentColumns,
	heading: fusedHeading(f),
	attachments: new Map()
})

/** The attachments under the rows of the statement `tree` holds: its pipelined attachment statements, and its fused columns. */
const attachmentsOf = (
	tree: StatementTree<DeliveredPart>
): ReadonlyMap<NodeId, AttachmentShape> => {
	const out = new Map<NodeId, AttachmentShape>()
	for (const a of tree.attachments) {
		out.set(a.attach.id, {
			name: a.attach.name,
			parentColumns: Arr.map(keyColumns(a.statement.role), (c) => c.name),
			heading: deliveredHeading(a.statement.heading),
			attachments: attachmentsOf(a)
		})
	}
	for (const f of tree.statement.fused) {
		out.set(f.attach.id, fusedShape(f))
	}
	return out
}

const resultShape = (program: ChannelProgram): ReadonlyArray<RowsShape> =>
	Arr.flatMap(program.roots, (tree) => {
		const role = tree.statement.role
		return role.kind === "main" || role.kind === "headingGroup"
			? [{ role, heading: tree.statement.heading, attachments: attachmentsOf(tree) }]
			: []
	})

const sameRowsRole = (a: RowsRole, b: RowsRole): boolean =>
	a.kind === "main" ? b.kind === "main" : b.kind === "headingGroup" && a.group === b.group

const sameHeading = (a: Heading, b: Heading): boolean =>
	a.length === b.length &&
	Arr.every(a, (h, k) => h.name === b[k]?.name && sameScalarType(h.type, b[k].type))

const attachmentDifferences = (
	o: ReadonlyMap<NodeId, AttachmentShape>,
	c: ReadonlyMap<NodeId, AttachmentShape>,
	where: string
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	for (const id of c.keys()) {
		if (!o.has(id)) {
			out.push(
				problem("artifacts", `${where} attachment ${id}`, "the attachment in both artifacts")
			)
		}
	}
	for (const [id, a] of o) {
		const at = `${where} attachment ${id}`
		const b = c.get(id)
		if (b === undefined) {
			out.push(problem("artifacts", at, "the attachment in both artifacts"))
			continue
		}
		if (
			a.name !== b.name ||
			!canonicalEquals(a.parentColumns, b.parentColumns, everyProperty) ||
			!sameHeading(a.heading, b.heading)
		) {
			out.push(
				problem(
					"artifacts",
					at,
					"the same name, parent stitch columns and child heading in both artifacts, pipelined or fused"
				)
			)
		}
		appendAll(out, attachmentDifferences(a.attachments, b.attachments, at))
	}
	return out
}

const discriminant = (d: ProgramDelivery): ReadonlyArray<string> | undefined =>
	d.kind === "headingGroups" ? d.discriminant : undefined

/**
 * The optimized and conservative artifacts of one template decode to the same public result, so whichever one runs
 * delivers the same nested rows (a weaker execution context runs the conservative artifact; the R36 gate: both
 * lowerings deliver identical nested results). Their SQL channels may differ: an attachment
 * fused into its parent statement on one side matches a pipelined attachment statement on the other, and parameter
 * transports and statement texts are each artifact's own (each StatementSpec carries its own codecs).
 */
export const artifactProblems = (
	optimized: ChannelProgram,
	conservative: ChannelProgram
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	const o = resultShape(optimized)
	const c = resultShape(conservative)
	if (o.length !== c.length) {
		return [
			problem(
				"artifacts",
				"the template",
				`${c.length} delivering statements in both artifacts, not ${o.length}`
			)
		]
	}
	for (const [i, s] of o.entries()) {
		const t = c[i]
		const where = `delivering statement ${i}`
		if (t === undefined) {
			out.push(problem("artifacts", where, "the same role, group and heading in both artifacts"))
			continue
		}
		if (!sameRowsRole(s.role, t.role) || !sameHeading(s.heading, t.heading)) {
			out.push(problem("artifacts", where, "the same role, group and heading in both artifacts"))
		}
		appendAll(out, attachmentDifferences(s.attachments, t.attachments, where))
	}
	const od = discriminant(optimized.delivery)
	const cd = discriminant(conservative.delivery)
	const same =
		od === undefined || cd === undefined
			? od === undefined && cd === undefined
			: od.length === cd.length && Arr.every(od, (d, i) => d === cd[i])
	if (!same) {
		out.push(problem("artifacts", "the template", "the same heading-group merge in both artifacts"))
	}
	return out
}
