import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal, catchSignal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import {
	type CompileError,
	malformedArtifact,
	malformedDescription
} from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareNumbers, mapInput } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type CandidateEnds,
	type CandidatePath,
	type EndsPath,
	endsLabel,
	type FieldPath,
	type NestedFieldPath,
	pathEnds,
	rivalEnds,
	samePath
} from "#compiler/deploy/diff/plan.ts"
import {
	isDigit,
	isWords,
	type StatementToken,
	statementTokens,
	writtenAs
} from "#compiler/deploy/render/markers.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"

export const metaFileName = "meta.json"

/** How a drafted folder is named: by the name `--name` gives, or by one derived from the change. */
export type FolderNaming =
	| { readonly kind: "named"; readonly name: string }
	| { readonly kind: "derived" }

/** What a loss loses, by printed name: a relation with its rows, a field with its values by the relation that held it
 * in the previous snapshot, or the rows of the abandoned schemas a schema's first migration leaves behind, each with
 * its directory. */
export type MetaLosses =
	| { readonly kind: "relation"; readonly relation: string }
	| { readonly kind: "field"; readonly relation: string; readonly field: string }
	| {
			readonly kind: "schema"
			readonly schema: string
			readonly abandoned: NonEmptyReadonlyArray<{
				readonly schema: string
				readonly directory: string
			}>
	  }

/** What a field's rename is chosen only with: nothing, or the type's rename its path names. */
export type MetaRequires = { readonly kind: "nothing" } | EndsPath<"type">

/** What a root candidate's own rename offer renames that is no relation: a login, a type with its object, or a field of
 * a relation both snapshots hold with what it requires. */
export type MetaRootRenames =
	| EndsPath<"login">
	| {
			readonly kind: "type"
			readonly object: "TYPE" | "DOMAIN"
			readonly removed: string
			readonly added: string
	  }
	| {
			readonly kind: "field"
			readonly relation: string
			readonly removed: string
			readonly added: string
			readonly requires: MetaRequires
	  }

/** What another candidate's choice makes of a recorded statement: it replaced, or it deleted. */
export type MetaPlainOffer =
	| {
			readonly kind: "replace"
			readonly candidate: CandidatePath
			readonly statements: NonEmptyReadonlyArray<string>
	  }
	| { readonly kind: "delete"; readonly candidate: CandidatePath }

/** One step of a drafted file or alternative, every statement in its place, each as the file spells it from its first
 * token, a choice's offers those its place admits (`O`):
 * - `statement`: a drafted statement; at the top of a file the reviewer's to keep or edit, inside an alternative part
 *   of it;
 * - `choice`: the statement its offers decide, the offers, and what follows it whichever way it is decided (a
 *   placeholder column's DROP DEFAULT);
 * - `loss`: a statement that loses stored data, decided by being written in, with the candidates that carry the data
 *   instead;
 * - `confirm`: statements kept whole or removed whole. */
export type MetaStepOf<O> =
	| { readonly kind: "statement"; readonly statement: string }
	| {
			readonly kind: "choice"
			readonly keep: string
			readonly offers: NonEmptyReadonlyArray<O>
			readonly follows: ReadonlyArray<string>
	  }
	| {
			readonly kind: "loss"
			readonly loses: MetaLosses
			readonly statement: string
			readonly carriers: ReadonlyArray<CandidatePath>
	  }
	| { readonly kind: "confirm"; readonly statements: NonEmptyReadonlyArray<string> }

/** A step of an alternative that holds no rename of its own: a type's, a login's, a field's, a nested field's. */
export type MetaSealedStep = MetaStepOf<MetaPlainOffer>

/** A candidate's own rename offer, its one defining record: its head, then its alternative's steps:
 * - `rename`: a login's, a type's or a kept relation's field's;
 * - `nested rename`: a field's rename nested in the relation rename whose alternative holds it, its path that
 *   relation's and its two fields;
 * - `relation rename`: a relation's, whose alternative holds its nested fields' renames. */
export interface MetaRootRename {
	readonly kind: "rename"
	readonly renames: MetaRootRenames
	readonly head: string
	readonly alternative: ReadonlyArray<MetaSealedStep>
}

export interface MetaNestedRename {
	readonly kind: "nested rename"
	readonly removed: string
	readonly added: string
	readonly requires: MetaRequires
	readonly head: string
	readonly alternative: ReadonlyArray<MetaSealedStep>
}

export type MetaRelationStep = MetaStepOf<MetaNestedRename | MetaPlainOffer>

export interface MetaRelationRename {
	readonly kind: "relation rename"
	readonly removed: string
	readonly added: string
	readonly head: string
	readonly alternative: ReadonlyArray<MetaRelationStep>
}

export type MetaTopOffer = MetaRootRename | MetaRelationRename | MetaPlainOffer

/** A step at the top of a drafted file. */
export type MetaStep = MetaStepOf<MetaTopOffer>

/** A drafted file's steps, in draft order. */
export interface MetaFile {
	readonly name: string
	readonly steps: ReadonlyArray<MetaStep>
}

interface MetaFields {
	/** The declared schema name and its PostgreSQL schema. */
	readonly schemaName: string
	readonly schema: string
	readonly source: SchemaFingerprint
	readonly target: SchemaFingerprint
}

/** The meta of a folder the generator drafted, with its decision record: every drafted statement of every file in its
 * place in the draft, so each statement's owner is its position. */
export interface DraftedMeta extends MetaFields {
	readonly kind: "drafted"
	readonly files: ReadonlyArray<MetaFile>
}

/** The meta of a custom migration, for hand-written data steps: its source and target are one snapshot. */
export interface CustomMeta extends MetaFields {
	readonly kind: "custom"
}

export type MigrationMeta = DraftedMeta | CustomMeta

/** A recorded statement: its text as meta.json records it, and its tokens, read once (statementTokens). */
export interface Spelled {
	readonly text: string
	readonly tokens: ReadonlyArray<StatementToken>
}

const spell = (text: string): Spelled => ({ text, tokens: statementTokens(text) })

/** What every candidate of a record is: its label and ends, derived from its path; the file whose steps hold its rename
 * offer; and its head, the statement whose presence there decides it. */
interface ReadBase {
	readonly label: string
	readonly ends: CandidateEnds
	readonly file: string
	readonly head: Spelled
}

export interface ReadRelation extends ReadBase {
	readonly kind: "relation"
	readonly path: EndsPath<"relation">
	/** The fields' renames nested in its alternative. */
	readonly fields: ReadonlyArray<ReadNested>
}

export interface ReadType extends ReadBase {
	readonly kind: "type"
	readonly path: EndsPath<"type">
}

export interface ReadLogin extends ReadBase {
	readonly kind: "login"
	readonly path: EndsPath<"login">
}

export type ReadRequires =
	| { readonly kind: "nothing" }
	| { readonly kind: "type"; readonly candidate: ReadType }

export interface ReadField extends ReadBase {
	readonly kind: "field"
	readonly path: FieldPath
	readonly requires: ReadRequires
}

export interface ReadNested extends ReadBase {
	readonly kind: "nested field"
	readonly path: NestedFieldPath
	readonly requires: ReadRequires
}

/** A candidate decided from its own head: every one but a field's rename nested in a relation's. */
export type ReadRoot = ReadRelation | ReadType | ReadLogin | ReadField

/** A candidate as `grizzle check` decides it. */
export type ReadCandidate = ReadRoot | ReadNested

/** What another candidate's choice makes of a recorded statement, its candidate read. */
export type ReadPlainOffer =
	| {
			readonly kind: "replace"
			readonly candidate: ReadCandidate
			readonly statements: NonEmptyReadonlyArray<Spelled>
	  }
	| { readonly kind: "delete"; readonly candidate: ReadCandidate }

export interface ReadLoss {
	readonly kind: "loss"
	readonly loses: MetaLosses
	readonly statement: Spelled
	readonly carriers: ReadonlyArray<ReadCandidate>
}

/** A step of the record, every candidate it names read as the candidate, a choice's offers those its place admits. */
export type ReadStepOf<O> =
	| { readonly kind: "statement"; readonly statement: Spelled }
	| {
			readonly kind: "choice"
			readonly keep: Spelled
			readonly offers: NonEmptyReadonlyArray<O>
			readonly follows: ReadonlyArray<Spelled>
	  }
	| ReadLoss
	| { readonly kind: "confirm"; readonly statements: NonEmptyReadonlyArray<Spelled> }

export type ReadSealedStep = ReadStepOf<ReadPlainOffer>

/** A candidate's own rename offer, read: a root's that is no relation, a nested field's, a relation's. */
export interface ReadRootRename {
	readonly kind: "rename"
	readonly candidate: ReadType | ReadLogin | ReadField
	readonly alternative: ReadonlyArray<ReadSealedStep>
}

export interface ReadNestedRename {
	readonly kind: "rename"
	readonly candidate: ReadNested
	readonly alternative: ReadonlyArray<ReadSealedStep>
}

export type ReadRelationStep = ReadStepOf<ReadNestedRename | ReadPlainOffer>

export interface ReadRelationRename {
	readonly kind: "rename"
	readonly candidate: ReadRelation
	readonly alternative: ReadonlyArray<ReadRelationStep>
}

export type ReadTopStep = ReadStepOf<ReadRootRename | ReadRelationRename | ReadPlainOffer>

/** Any offer of the record, wherever it stands. */
export type ReadOffer = ReadRootRename | ReadRelationRename | ReadNestedRename | ReadPlainOffer

/** Any step of the record, wherever it stands. */
export type ReadStep = ReadTopStep | ReadRelationStep | ReadSealedStep

export interface ReadFile {
	readonly name: string
	readonly steps: ReadonlyArray<ReadTopStep>
}

interface RecordBody {
	readonly files: ReadonlyArray<ReadFile>
	/** The candidates decided from their own heads, in record order; a nested field is reached through its relation. */
	readonly candidates: ReadonlyArray<ReadRoot>
}

declare const decisionRecordBrand: unique symbol

/** A drafted folder's decisions, proved readable by its one constructor (decisionRecord). Where each rename offer may
 * stand is the meta form's type: a root's at the top of its file, a nested field's in its relation's alternative. The
 * constructor proves what no type of meta.json's text can carry: every path names exactly one rename offer (P1); and
 * every statement whose presence decides something, a head, a loss's statement or a confirmed statement, is written
 * unlike every other recorded statement that can stand in one review with it (P3). */
export type DecisionRecord = RecordBody & { readonly [decisionRecordBrand]: true }

const proved = nominal<RecordBody, DecisionRecord>()

/** A recorded statement where it stands, as a refusal names it. */
export interface RecordSite {
	readonly file: string
	readonly statement: string
	readonly at: string
}

/** Why a record is unreadable: two statements a review cannot tell apart (P3), or a path that names no rename offer or
 * two (P1). */
export type RecordFault =
	| { readonly kind: "indistinct"; readonly decided: RecordSite; readonly other: RecordSite }
	| { readonly kind: "unnamed"; readonly expected: string }

class Unreadable extends Error {
	readonly fault: RecordFault

	constructor(fault: RecordFault) {
		super()
		this.fault = fault
	}
}

const unnamed = (expected: string): never => {
	throw new Unreadable({ kind: "unnamed", expected })
}

/** The rule a record breaks, as a refusal says it. */
export const recordFaultText = (fault: RecordFault): string => {
	switch (fault.kind) {
		case "indistinct":
			return `${fault.decided.at} in ${fault.decided.file} and ${fault.other.at} in ${fault.other.file} are spelled alike (${fault.decided.statement}), so the reviewed SQL cannot tell the two decisions apart`
		case "unnamed":
			return fault.expected
	}
}

/** The read form of a recorded candidate, its label and ends derived from its path. */
const readBase = (path: CandidatePath, head: string, file: string): ReadBase => {
	const ends = pathEnds(path)
	return { label: endsLabel(ends), ends, file, head: spell(head) }
}

/** The offers of a list of steps, in order. */
const offersIn = <O>(steps: ReadonlyArray<MetaStepOf<O>>): ReadonlyArray<O> =>
	steps.flatMap((s) => (s.kind === "choice" ? s.offers : []))

/** A root rename's path. */
const rootPath = (r: MetaRootRenames): EndsPath<"login"> | EndsPath<"type"> | FieldPath => {
	switch (r.kind) {
		case "login":
			return { kind: "login", removed: r.removed, added: r.added }
		case "type":
			return { kind: "type", removed: r.removed, added: r.added }
		case "field":
			return { kind: "field", relation: r.relation, removed: r.removed, added: r.added }
	}
}

const relationPathOf = (o: MetaRelationRename): EndsPath<"relation"> => ({
	kind: "relation",
	removed: o.removed,
	added: o.added
})

const nestedPathOf = (parent: EndsPath<"relation">, o: MetaNestedRename): NestedFieldPath => ({
	kind: "nested field",
	parent,
	removed: o.removed,
	added: o.added
})

/** Every candidate a record offers, in record order: the roots, a relation's nested fields under it, each read where
 * its rename offer stands. The type renames are read first, as what a field's `requires` names. */
const rootsIn = (files: ReadonlyArray<MetaFile>): ReadonlyArray<ReadRoot> => {
	const types = files.flatMap((f) =>
		offersIn(f.steps).flatMap((o): ReadonlyArray<ReadType> => {
			if (o.kind !== "rename" || o.renames.kind !== "type") {
				return []
			}
			const path: EndsPath<"type"> = {
				kind: "type",
				removed: o.renames.removed,
				added: o.renames.added
			}
			return [{ kind: "type", path, ...readBase(path, o.head, f.name) }]
		})
	)
	const requiresOf = (r: MetaRequires): ReadRequires => {
		if (r.kind === "nothing") {
			return r
		}
		const candidate = types.find((t) => samePath(t.path, r))
		return candidate === undefined
			? unnamed("a field's `requires` naming a type rename the record offers")
			: { kind: "type", candidate }
	}
	/** A root rename that is no type's, read; a type's is read first. */
	const rootRead = (o: MetaRootRename, file: string): ReadonlyArray<ReadRoot> => {
		const r = o.renames
		switch (r.kind) {
			case "type":
				return []
			case "login": {
				const path: EndsPath<"login"> = { kind: "login", removed: r.removed, added: r.added }
				return [{ kind: "login", path, ...readBase(path, o.head, file) }]
			}
			case "field": {
				const path: FieldPath = {
					kind: "field",
					relation: r.relation,
					removed: r.removed,
					added: r.added
				}
				return [
					{
						kind: "field",
						path,
						requires: requiresOf(r.requires),
						...readBase(path, o.head, file)
					}
				]
			}
		}
	}
	const relationRead = (o: MetaRelationRename, file: string): ReadRelation => {
		const path = relationPathOf(o)
		const fields = offersIn(o.alternative).flatMap((n): ReadonlyArray<ReadNested> => {
			if (n.kind !== "nested rename") {
				return []
			}
			const nested = nestedPathOf(path, n)
			return [
				{
					kind: "nested field",
					path: nested,
					requires: requiresOf(n.requires),
					...readBase(nested, n.head, file)
				}
			]
		})
		return { kind: "relation", path, fields, ...readBase(path, o.head, file) }
	}
	const offerRead = (o: MetaTopOffer, file: string): ReadonlyArray<ReadRoot> => {
		switch (o.kind) {
			case "relation rename":
				return [relationRead(o, file)]
			case "rename":
				return rootRead(o, file)
			case "replace":
			case "delete":
				return []
		}
	}
	const others = files.flatMap((f) => offersIn(f.steps).flatMap((o) => offerRead(o, f.name)))
	return [...types, ...others]
}

/** Every candidate of a record, nested ones after their relation. */
const everyCandidate = (roots: ReadonlyArray<ReadRoot>): ReadonlyArray<ReadCandidate> =>
	roots.flatMap((r): ReadonlyArray<ReadCandidate> =>
		r.kind === "relation" ? [r, ...r.fields] : [r]
	)

/** A record step, every candidate it names read as the candidate its path names, a choice's offers read by `offer`. */
const readStep = <M, R>(
	s: MetaStepOf<M>,
	candidates: ReadonlyArray<ReadCandidate>,
	offer: (o: M) => R
): ReadStepOf<R> => {
	switch (s.kind) {
		case "statement":
			return { kind: "statement", statement: spell(s.statement) }
		case "loss":
			return {
				kind: "loss",
				loses: s.loses,
				statement: spell(s.statement),
				carriers: s.carriers.map((c) => named(candidates, c))
			}
		case "confirm":
			return { kind: "confirm", statements: mapNonEmpty(s.statements, (x) => spell(x)) }
		case "choice":
			return {
				kind: "choice",
				keep: spell(s.keep),
				follows: s.follows.map((x) => spell(x)),
				offers: mapNonEmpty(s.offers, offer)
			}
	}
}

/** The record's steps, each read (readStep). */
const readSteps = <M, R>(
	steps: ReadonlyArray<MetaStepOf<M>>,
	candidates: ReadonlyArray<ReadCandidate>,
	offer: (o: M) => R
): ReadonlyArray<ReadStepOf<R>> => steps.map((s) => readStep(s, candidates, offer))

/** The candidate a path names. */
const named = (candidates: ReadonlyArray<ReadCandidate>, path: CandidatePath): ReadCandidate =>
	candidates.find((c) => samePath(c.path, path)) ??
	unnamed("every path naming a candidate whose rename offer the record holds")

const plainOffer =
	(candidates: ReadonlyArray<ReadCandidate>) =>
	(o: MetaPlainOffer): ReadPlainOffer => {
		switch (o.kind) {
			case "replace":
				return {
					kind: "replace",
					candidate: named(candidates, o.candidate),
					statements: mapNonEmpty(o.statements, (x) => spell(x))
				}
			case "delete":
				return { kind: "delete", candidate: named(candidates, o.candidate) }
		}
	}

/** A file's steps read: a root's rename offer as its candidate, a relation's alternative with its nested fields'. */
const topSteps = (
	steps: ReadonlyArray<MetaStep>,
	roots: ReadonlyArray<ReadRoot>,
	candidates: ReadonlyArray<ReadCandidate>
): ReadonlyArray<ReadTopStep> => {
	const plain = plainOffer(candidates)
	const sealed = (alternative: ReadonlyArray<MetaSealedStep>): ReadonlyArray<ReadSealedStep> =>
		readSteps(alternative, candidates, plain)
	return readSteps(steps, candidates, (o): ReadRootRename | ReadRelationRename | ReadPlainOffer => {
		switch (o.kind) {
			case "relation rename": {
				const path = relationPathOf(o)
				const [found] = roots.flatMap((r) =>
					r.kind === "relation" && samePath(r.path, path) ? [r] : []
				)
				const relation = found ?? unnamed("a relation rename the record holds")
				const nested = (
					n: MetaNestedRename | MetaPlainOffer
				): ReadNestedRename | ReadPlainOffer => {
					if (n.kind !== "nested rename") {
						return plain(n)
					}
					const at = nestedPathOf(path, n)
					const candidate =
						relation.fields.find((x) => samePath(x.path, at)) ??
						unnamed("a nested field's rename the record holds")
					return { kind: "rename", candidate, alternative: sealed(n.alternative) }
				}
				return {
					kind: "rename",
					candidate: relation,
					alternative: readSteps(o.alternative, candidates, nested)
				}
			}
			case "rename": {
				const path = rootPath(o.renames)
				const [found] = roots.flatMap((r) =>
					r.kind !== "relation" && samePath(r.path, path) ? [r] : []
				)
				const candidate = found ?? unnamed("a root's rename the record holds")
				return { kind: "rename", candidate, alternative: sealed(o.alternative) }
			}
			case "replace":
			case "delete":
				return plain(o)
		}
	})
}
/** A literal of a review's decision: a candidate chosen or not. */
interface Literal {
	readonly candidate: ReadCandidate
	readonly chosen: boolean
}

/** A recorded statement where it stands: the decision literals under which a review holds it, as drafted (`standing`),
 * and, for one whose presence decides something, those under which a review reads it (`lookup`): a head is read
 * wherever its choice is, before its candidate is chosen. */
interface Site extends RecordSite {
	readonly spelled: Spelled
	readonly standing: ReadonlyArray<Literal>
	readonly lookup: ReadonlyArray<Literal> | undefined
}

/** The paths choosing a candidate chooses: its own, a nested field's relation's, and a field's required type's. */
const chosenWith = (c: ReadCandidate): ReadonlyArray<CandidatePath> => {
	const required = (r: ReadRequires): ReadonlyArray<CandidatePath> =>
		r.kind === "nothing" ? [] : [r.candidate.path]
	switch (c.kind) {
		case "relation":
		case "type":
		case "login":
			return [c.path]
		case "field":
			return [c.path, ...required(c.requires)]
		case "nested field":
			return [c.path, c.path.parent, ...required(c.requires)]
	}
}

/** Whether some review takes every literal: no candidate chosen and not chosen at once, and no two rivals chosen. */
const satisfiable = (literals: ReadonlyArray<Literal>): boolean => {
	const chosen = literals.flatMap((l) => (l.chosen ? chosenWith(l.candidate) : []))
	const unchosen = literals.flatMap((l) => (l.chosen ? [] : [l.candidate.path]))
	return (
		chosen.every((p) => !unchosen.some((q) => samePath(p, q))) &&
		chosen.every((p, i) =>
			chosen.slice(i + 1).every((q) => samePath(p, q) || !rivalEnds(pathEnds(p), pathEnds(q)))
		)
	)
}

/** Every recorded statement of a file where it stands (Site). */
const sitesIn = (file: ReadFile): ReadonlyArray<Site> => {
	const site = (
		spelled: Spelled,
		at: string,
		standing: ReadonlyArray<Literal>,
		lookup: ReadonlyArray<Literal> | undefined
	): Site => ({ file: file.name, statement: spelled.text, at, spelled, standing, lookup })
	const offerSites = (o: ReadOffer, scope: ReadonlyArray<Literal>): ReadonlyArray<Site> => {
		const taken = [...scope, { candidate: o.candidate, chosen: true }]
		const label = o.candidate.label
		switch (o.kind) {
			case "rename":
				return [
					site(o.candidate.head, `the head of ${label}`, taken, scope),
					...walk(o.alternative, taken, `inside ${label}`)
				]
			case "replace":
				return o.statements.map((x) => site(x, `a statement ${label} writes`, taken, undefined))
			case "delete":
				return []
		}
	}
	const stepSites = (
		s: ReadStep,
		scope: ReadonlyArray<Literal>,
		within: string
	): ReadonlyArray<Site> => {
		switch (s.kind) {
			case "statement":
				return [site(s.statement, `a statement ${within}`, scope, undefined)]
			case "loss":
				return [site(s.statement, `the statement of a data loss ${within}`, scope, scope)]
			case "confirm":
				return s.statements.map((x) => site(x, `a confirmed statement ${within}`, scope, scope))
			case "choice": {
				const kept = [
					...scope,
					...s.offers.map((o: ReadOffer): Literal => ({ candidate: o.candidate, chosen: false }))
				]
				return [
					site(s.keep, `the statement candidate renames decide ${within}`, kept, undefined),
					...s.follows.map((x) =>
						site(x, `a statement following a decided one ${within}`, scope, undefined)
					),
					...s.offers.flatMap((o: ReadOffer) => offerSites(o, scope))
				]
			}
		}
	}
	const walk = (
		steps: ReadonlyArray<ReadStep>,
		scope: ReadonlyArray<Literal>,
		within: string
	): ReadonlyArray<Site> => steps.flatMap((s) => stepSites(s, scope, within))
	return walk(file.steps, [], "at the top of the file")
}

/** P3: every statement whose presence decides something is written unlike every other recorded statement that can
 * stand in one review with it, either way round, a placeholder filled by any value; the first pair that is not. */
const indistinct = (files: ReadonlyArray<ReadFile>): RecordFault | undefined => {
	const sites = files.flatMap((f) => sitesIn(f))
	for (const p of sites) {
		const lookup = p.lookup
		if (lookup === undefined) {
			continue
		}
		for (const q of sites) {
			if (
				q !== p &&
				(writtenAs(p.spelled.tokens, q.spelled.tokens) ||
					writtenAs(q.spelled.tokens, p.spelled.tokens)) &&
				satisfiable([...lookup, ...q.standing])
			) {
				return {
					kind: "indistinct",
					decided: { file: p.file, statement: p.statement, at: p.at },
					other: { file: q.file, statement: q.statement, at: q.at }
				}
			}
		}
	}
	return undefined
}

/** The one constructor of a decision record, which `grizzle generate` builds its meta.json through and `grizzle check`
 * and `grizzle migrate` read it through: every statement's tokens read once, every path resolved to the one candidate
 * whose rename offer it names, and P1 and P3 (DecisionRecord) proved, or the fault that breaks them. */
export const decisionRecord = (
	files: ReadonlyArray<MetaFile>
): Result.Result<DecisionRecord, RecordFault> =>
	Result.mapError(
		catchSignal(Unreadable, (): DecisionRecord => {
			const roots = rootsIn(files)
			const candidates = everyCandidate(roots)
			for (const [i, c] of candidates.entries()) {
				if (candidates.slice(i + 1).some((d) => samePath(c.path, d.path))) {
					unnamed(`one rename offer per candidate; ${c.label} has two`)
				}
			}
			const read = files.map((f): ReadFile => ({
				name: f.name,
				steps: topSteps(f.steps, roots, candidates)
			}))
			const fault = indistinct(read)
			if (fault !== undefined) {
				throw new Unreadable(fault)
			}
			return proved({ files: read, candidates: roots })
		}),
		(signal) => signal.fault
	)

/** A committed folder's meta.json as readMeta reads it. */
export type ReadMeta =
	| (MetaFields & { readonly kind: "drafted"; readonly record: DecisionRecord })
	| CustomMeta

interface MigrationFile {
	readonly name: string
	readonly text: string
}

/** A migration folder `migrations/<schema>/<timestamp>_<name>/` and its meta.json.
 *
 * Each declared schema has its own directory `migrations/<schema>/`, holding its snapshot.json and its folders.
 * A folder holds the drafted `NN-<phase>.sql` files and `meta.json`, which records
 * the folder's source and target snapshot fingerprints: `grizzle migrate` refuses a folder whose source is not
 * the database's latest applied target before any statement runs, and records both in the ledger.
 * The CLI supplies the timestamp, since the compiler reads no clock: fourteen digits,
 * `YYYYMMDDHHMMSS` in UTC, so folders sort in creation order by name. meta.json also records the folder's kind:
 * drafted, or a custom migration, whose source and target are the same snapshot. A drafted folder records its decision
 * record in `files`: every drafted statement of every file in draft order, each choice with its offers and what
 * follows it, each candidate's rename offer with its head and its alternative's steps, each group of statements the
 * reviewer confirms as one, and each statement that loses stored data, with what it loses and the candidates that
 * carry it instead, every candidate named by its path. So `grizzle check` decides each candidate once from its head,
 * a field's rename nested in a relation's only where that rename is chosen, and reads back that every file follows the
 * decisions, that no two chosen candidates rename one name, that each group stands whole or is gone whole, that every
 * loss is decided, and that no statement of a branch the reviewer did not take is written in (`splitRenames`,
 * lossDecisions), comparing statements as PostgreSQL's scanner reads them (`writtenAs`). A custom migration drafts
 * nothing, so it has no record: grizzle does not read its hand-written statements. */
export interface MigrationFolder {
	/** `<timestamp>_<name>`. */
	readonly name: string
	readonly meta: MigrationMeta
	readonly metaText: string
	readonly files: ReadonlyArray<MigrationFile>
}

export interface DraftedFolder extends MigrationFolder {
	readonly meta: DraftedMeta
}

/** Whether every character of `text` is an ASCII digit. */
const allDigits = (text: string): boolean => {
	for (const ch of text) {
		if (!isDigit(ch)) {
			return false
		}
	}
	return true
}

const isTimestamp = (text: string): boolean => text.length === 14 && allDigits(text)
export const maxMigrationNameLength = 100

/** The folder name of a migration; the name is lowercase ASCII words joined by `_` or `-`. */
export const folderName = (
	timestamp: string,
	name: string
): Result.Result<string, CompileError> => {
	if (!isTimestamp(timestamp)) {
		return Result.err(
			malformedDescription(
				SourceLoc("migration folder", []),
				`a timestamp of fourteen digits YYYYMMDDHHMMSS, not ${JSON.stringify(timestamp)}`
			)
		)
	}
	if (!isWords(name) || name.length > maxMigrationNameLength) {
		return Result.err(
			malformedDescription(
				SourceLoc("migration folder", []),
				`a name of lowercase ASCII letters and digits joined by _ or -, at most ${maxMigrationNameLength} characters, not ${JSON.stringify(name)}`
			)
		)
	}
	return Result.ok(`${timestamp}_${name}`)
}

/** Whether a directory name is a migration folder's: `<14 digits>_<words>`. */
export const isFolderName = (name: string): boolean =>
	isTimestamp(name.slice(0, 14)) && name[14] === "_" && isWords(name.slice(15))

/** A drafted SQL file's ordinal: `NN-<phase>.sql`, or any `NN-<words>.sql` a reviewer adds, NN at least two digits and
 * positive. */
const fileOrdinal = (name: string): number | undefined => {
	if (!name.endsWith(".sql")) {
		return undefined
	}
	const stem = name.slice(0, -".sql".length)
	const dash = stem.indexOf("-")
	if (dash < 2) {
		return undefined
	}
	const digits = stem.slice(0, dash)
	if (!allDigits(digits) || !isWords(stem.slice(dash + 1))) {
		return undefined
	}
	const n = Number(digits)
	return n > 0 ? n : undefined
}

/**
 * The seal of a meta.json: the digest of every property of its meta, over the value JSON gave. It is total over any
 * value, so a read meta.json is checked by it before anything reads its meta (the shell's boundary/meta.ts).
 */
export const metaSeal = (meta: unknown): Result.Result<string, CompileError> =>
	digest("meta", meta, everyProperty)

/** The text of meta.json: `{ meta, seal }`, the meta sealed by its seal (metaSeal), so a meta.json edited or corrupted
 * outside grizzle is refused before its meta is read. */
export const writeMeta = (meta: MigrationMeta): Result.Result<string, CompileError> =>
	Result.flatMap(metaSeal(meta), (seal) => writeJsonText({ meta, seal }))

/** Reads a folder's meta: what its form alone does not say. The shell trusts meta.json's meta once its seal holds
 * (boundary/meta.ts), and hands the meta here. A custom migration's source and target are one
 * snapshot; a drafted folder's files read as its decision record (decisionRecord), a fault refused as a malformed
 * meta.json. */
export const readDecodedMeta = (meta: MigrationMeta): Result.Result<ReadMeta, CompileError> => {
	switch (meta.kind) {
		case "custom":
			return meta.source === meta.target
				? Result.ok(meta)
				: Result.err(
						malformedArtifact(
							"meta",
							[],
							"a custom migration whose source and target are one snapshot"
						)
					)
		case "drafted":
			return Result.map(
				Result.mapError(decisionRecord(meta.files), (fault) =>
					malformedArtifact("meta", ["files"], recordFaultText(fault))
				),
				(record) => ({
					kind: "drafted",
					schemaName: meta.schemaName,
					schema: meta.schema,
					source: meta.source,
					target: meta.target,
					record
				})
			)
	}
}

/** The files of a folder in apply order, each with its ordinal; two files with one ordinal, or a file that is not
 * `NN-*.sql`, is refused. */
export const orderFolderFiles = <F extends { readonly name: string }>(
	files: ReadonlyArray<F>
): Result.Result<ReadonlyArray<{ readonly file: F; readonly ordinal: number }>, CompileError> =>
	catchRefusal(() => {
		const out: Array<{ readonly file: F; readonly ordinal: number }> = []
		for (const file of files) {
			const name = file.name
			if (name === metaFileName) {
				continue
			}
			const parsed = fileOrdinal(name)
			if (parsed === undefined) {
				throw new Refusal(
					malformedArtifact(
						"folder",
						[],
						`files named NN-<phase>.sql beside meta.json; ${name} is not one`
					)
				)
			}
			const ordinal = parsed
			if (out.some((f) => f.ordinal === ordinal)) {
				throw new Refusal(
					malformedArtifact("folder", [], `one file per ordinal; ${ordinal} has two`)
				)
			}
			out.push({ file, ordinal })
		}
		return out.toSorted(mapInput(compareNumbers, (f: { readonly ordinal: number }) => f.ordinal))
	})
