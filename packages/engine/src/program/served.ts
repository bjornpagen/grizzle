import { requireGet } from "#compiler/analysis/logical/get.ts"
import type { CursorGeneration } from "#compiler/codec/cursor/identity.ts"
import type { DecoderForm, RowDecoder } from "#compiler/core/decoder.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { PageFill } from "#compiler/ir/products.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { type PageStatementSlot } from "#compiler/lower/conservative/types.ts"
import type { FusedStatement } from "#compiler/lower/shapes/index.ts"
import type {
	PageProbeProgram,
	PageProgram,
	PageRequestProgram,
	PageStatement,
	PageTemplate
} from "#compiler/lower/shapes/page/compile.ts"
import type { PageVariant, ProbeKind } from "#compiler/lower/shapes/page/seek.ts"
import { pageStatementSlotOf, statementSpec } from "#compiler/lower/template.ts"
import { loginStartupOptions } from "#compiler/physical/ddl/roles.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { traverseTree } from "#compiler/runtime/lower/tree.ts"
import type {
	ServedPage,
	ServedPageProbe,
	ServedPageRequest,
	ServedPageStatement,
	ServedRead,
	ServedRoleForm,
	ServedSession,
	ServedVariants
} from "#compiler/served/forms.ts"
import {
	type ServedRoots,
	type ServedSpec,
	servedChoice,
	servedHeading,
	servedRunStatement,
	servedSource,
	servedSpec,
	servedTree
} from "#compiler/served/read.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"

/**
 * A query compiled for a role's rows, served (served/forms.ts ServedRead): its declared parameters, its artifact and
 * delivered spine (served/read.ts), its records' decoder, and whether get may read it, its template's analyzed root
 * proved at most one row per parameter binding (analysis/logical/get.ts requireGet).
 */
export const servedRead = (
	template: QueryTemplate,
	desc: QueryDesc,
	decoder: RowDecoder<unknown>
): ServedRead => ({
	params: template.params,
	source: servedSource(template.run),
	spine: servedSpine(desc),
	decoder: decoder.form,
	getEligible: requireGet(template.analyzed.roots[0], SourceLoc("reader.get", [])).ok
})

/** A page statement's spec, emitted now under the codes `codes`: a page's statements carry none of their own. */
const pageSpec = <F extends PageFill>(
	statement: FusedStatement<PageStatementSlot<F>>,
	codes: Codebook
): Result.Result<ServedSpec, CompileError> =>
	Result.map(statementSpec(statement, pageStatementSlotOf(codes)), servedSpec)

/** A page statement as the runtime runs it: its spec, and its large form's, emitted under the codes `codes`. */
const servedPageStatement = <F extends PageFill>(
	statement: PageStatement<F>,
	codes: Codebook
): Result.Result<ServedPageStatement<F>, CompileError> =>
	Result.flatMap(pageSpec(statement, codes), (spec) => {
		const forms = statement.forms
		if (forms.kind === "one") {
			return Result.ok({ statement: servedRunStatement(statement, { kind: "one" }), spec })
		}
		return Result.map(pageSpec(forms.large, codes), (large) => ({
			statement: servedRunStatement(statement, {
				kind: "chosen",
				choices: mapNonEmpty(forms.choices, servedChoice),
				large: { statement: { params: forms.large.params }, spec: large }
			}),
			spec
		}))
	})

/** A page program's statements, each served (servedPageStatement), in their tree; or the first that emits no spec. */
const servedPageRoots = <F extends PageFill>(
	program: PageProgram<F>,
	codes: Codebook
): Result.Result<ServedRoots<ServedPageStatement<F>>, CompileError> =>
	Result.map(
		traverseTree(program.roots, (statement) => servedPageStatement(statement, codes)),
		(roots) => mapNonEmpty(roots, (tree) => servedTree(tree, (statement) => statement))
	)

/** A request variant of a page, served: its flags and delivery as compiled, its statements served. */
const servedRequest = <V extends PageVariant>(
	program: PageRequestProgram<V>,
	codes: Codebook
): Result.Result<ServedPageRequest<V>, CompileError> =>
	Result.map(servedPageRoots(program, codes), (roots) => ({ ...program, roots }))

/** A probe of a page, served: its kind, its statement served, and its one Boolean column. */
const servedProbe = <K extends ProbeKind>(
	program: PageProbeProgram<K>,
	codes: Codebook
): Result.Result<ServedPageProbe<K>, CompileError> =>
	Result.map(servedPageStatement(program.statement, codes), (statement) => ({
		kind: program.kind,
		statement,
		column: { name: program.column.name, type: program.column.type }
	}))

/**
 * An ordered query's page, served (served/forms.ts ServedPage): its order, comparators and heading, each request's and
 * probe's statements with their specs emitted now under the installation's codes `codes`, and its cursor's identity,
 * the query's semantic fingerprint `query` and its schema's generation `generation`. A statement whose spec does not
 * emit is its CompileError.
 */
export const servedPage = (
	page: PageTemplate,
	codes: Codebook,
	query: string,
	generation: CursorGeneration
): Result.Result<ServedPage, CompileError> => {
	const { requests, probes } = page.artifact
	const first = servedRequest(requests.first, codes)
	const after = servedRequest(requests.after, codes)
	const last = servedRequest(requests.last, codes)
	const before = servedRequest(requests.before, codes)
	const atOrBefore = servedProbe(probes.atOrBefore, codes)
	const atOrAfter = servedProbe(probes.atOrAfter, codes)
	if (!first.ok) {
		return first
	}
	if (!after.ok) {
		return after
	}
	if (!last.ok) {
		return last
	}
	if (!before.ok) {
		return before
	}
	if (!atOrBefore.ok) {
		return atOrBefore
	}
	if (!atOrAfter.ok) {
		return atOrAfter
	}
	return Result.ok({
		order: page.order,
		comparators: page.comparators.map((c) => ({
			field: c.field,
			direction: c.direction,
			type: c.type
		})),
		heading: servedHeading(page.heading),
		requests: { first: first.value, after: after.value, last: last.value, before: before.value },
		probes: { atOrBefore: atOrBefore.value, atOrAfter: atOrAfter.value },
		query,
		generation
	})
}

/**
 * The texts every session of a login sends that its file carries, emitted now (served/forms.ts ServedSession): the
 * startup options pinning its role's defaults (physical/ddl/roles.ts loginStartupOptions), each transaction's BEGIN,
 * read only or read write, and its COMMIT and ROLLBACK.
 */
export const servedSession: ServedSession = {
	startup: loginStartupOptions,
	begin: {
		readOnly: emitText({ kind: "begin", readOnly: true }, emptyNameMap).text,
		readWrite: emitText({ kind: "begin", readOnly: false }, emptyNameMap).text
	},
	commit: emitText({ kind: "commit" }, emptyNameMap).text,
	rollback: emitText({ kind: "rollback" }, emptyNameMap).text
}

/** The rosters a decoder form's columns read: a closed id's and a set's. */
const decoderRosters = (form: DecoderForm, out: Set<string>): void => {
	switch (form.kind) {
		case "record":
			for (const [, field] of form.fields) {
				if (field.kind === "column") {
					if (field.column.kind === "code" || field.column.kind === "bits") {
						out.add(field.column.roster)
					}
				} else {
					decoderRosters(field.child, out)
				}
			}
			return
		case "merge":
		case "oneOf":
			decoderRosters(form.first, out)
			decoderRosters(form.second, out)
			return
		case "arm":
			decoderRosters(form.parent, out)
			decoderRosters(form.child, out)
			return
		case "refused":
			return
	}
}

/** Every Roster a served value holds, a type's among them, each container read once however many hold it. */
const heldRosters = (value: unknown, out: Set<string>, seen: Set<object>): void => {
	if (typeof value !== "object" || value === null || seen.has(value)) {
		return
	}
	seen.add(value)
	if (value instanceof Roster) {
		out.add(value.closed)
		return
	}
	if (value instanceof Map) {
		for (const [k, v] of value) {
			heldRosters(k, out, seen)
			heldRosters(v, out, seen)
		}
		return
	}
	if (value instanceof Set || isList(value)) {
		for (const v of value) {
			heldRosters(v, out, seen)
		}
		return
	}
	for (const v of Object.values(value)) {
		heldRosters(v, out, seen)
	}
}

/**
 * The rosters a login's served roles read, by declared name: every Roster their forms hold (a closed id's or a set's
 * type), every closed id's and set's column their decoders read, and every roster a classifier names a domain of: the
 * rosters whose codes the file carries (served/forms.ts ServedFile rosters).
 */
export const servedRosters = (roles: ReadonlyArray<ServedRoleForm>): ReadonlySet<string> => {
	const out = new Set<string>()
	const seen = new Set<object>()
	for (const role of roles) {
		heldRosters(role, out, seen)
		for (const domain of role.refusals.laws.rosterDomains) {
			out.add(domain.roster)
		}
		for (const member of role.members) {
			switch (member.kind) {
				case "change":
					variantRosters(member.variants, out)
					break
				case "refresh":
					break
				case "read":
				case "paged":
				case "key":
					decoderRosters(member.read.decoder, out)
					break
			}
		}
	}
	return out
}

/** The rosters each change of a ChangeSet's variants reads in its reads decoder. */
const variantRosters = (variants: ServedVariants, out: Set<string>): void => {
	if (variants.kind === "change") {
		decoderRosters(variants.change.decoder, out)
		return
	}
	variantRosters(variants.holding, out)
	variantRosters(variants.lacking, out)
}
