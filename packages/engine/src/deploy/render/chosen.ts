import { firstIndex } from "#compiler/core/array.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { rivalEnds } from "#compiler/deploy/diff/plan.ts"
import type {
	DecisionRecord,
	MetaLosses,
	ReadCandidate,
	ReadFile,
	ReadLoss,
	ReadOffer,
	ReadStep,
	Spelled
} from "#compiler/deploy/render/folder.ts"
import {
	hasPlaceholder,
	type StatementToken,
	splitStatements,
	statementTokens,
	writtenAs
} from "#compiler/deploy/render/markers.ts"

/** A decision check refuses: a candidate chosen at one statement it decides and kept at another, a statement it decides
 * written otherwise than drafted, a group the reviewer confirms as one kept in part, a loss decided both ways, or a
 * statement of a branch the review did not take written in (`split`); a candidate chosen without one it requires, or a
 * statement written inside a rename that is not chosen (`orphan`); or two chosen candidates that take one removed name
 * away or give one added name twice (`twice`), whose second rename fails once the first ran. */
export interface SplitRename {
	readonly kind: "split" | "orphan" | "twice"
	readonly file: string
	/** What is wrong, naming the candidate and the statement. */
	readonly detail: string
}

/** A folder's file as a review holds it. */
interface FolderFile {
	readonly name: string
	readonly text: string
}

/** A statement a review holds, as PostgreSQL's scanner reads it. */
type HeldStatement = ReadonlyArray<StatementToken>

/** A recorded file as a review holds it: its record, and the statements of the folder's file of its name, read once;
 * a reviewer who deletes a drafted file whole holds none of its statements. */
interface Reviewed {
	readonly file: ReadFile
	readonly held: ReadonlyArray<HeldStatement>
}

const reviewedIn = (
	record: DecisionRecord,
	files: ReadonlyArray<FolderFile>
): ReadonlyArray<Reviewed> =>
	record.files.map((file) => {
		const reviewed = files.find((f) => f.name === file.name)
		return {
			file,
			held:
				reviewed === undefined ? [] : splitStatements(reviewed.text).map((x) => statementTokens(x))
		}
	})

/** Whether a review holds a statement written as the recorded one. */
const holds = (held: ReadonlyArray<HeldStatement>, statement: Spelled): boolean =>
	held.some((h) => writtenAs(statement.tokens, h))

/** The candidates a review chooses: each root whose file holds its head, and each field's rename nested in a chosen
 * relation's rename whose file holds its head, read in the file whose steps hold its rename offer. Sound by the
 * record's proof (DecisionRecord P3): no statement that can stand beside a head is written as it. */
const decided = (reviewed: ReadonlyArray<Reviewed>): ReadonlySet<ReadCandidate> => {
	const chosenAt = (
		steps: ReadonlyArray<ReadStep>,
		held: ReadonlyArray<HeldStatement>
	): ReadonlyArray<ReadCandidate> =>
		steps.flatMap((s) =>
			s.kind === "choice"
				? s.offers.flatMap((o: ReadOffer): ReadonlyArray<ReadCandidate> => {
						if (o.kind !== "rename" || !holds(held, o.candidate.head)) {
							return []
						}
						return o.candidate.kind === "relation"
							? [o.candidate, ...chosenAt(o.alternative, held)]
							: [o.candidate]
					})
				: []
		)
	return new Set(reviewed.flatMap((r) => chosenAt(r.file.steps, r.held)))
}

/** The candidates a reviewed folder chooses (decided). */
export const chosenIn = (
	record: DecisionRecord,
	files: ReadonlyArray<FolderFile>
): ReadonlySet<ReadCandidate> => decided(reviewedIn(record, files))

/** What a loss loses, as a refusal names it. */
export const lossText = (loses: MetaLosses): string => {
	switch (loses.kind) {
		case "relation":
			return `the relation ${loses.relation} with its rows`
		case "field":
			return `the field ${loses.relation}.${loses.field} with its values`
		case "schema":
			return `the rows of ${loses.abandoned.map((a) => `the schema ${a.schema} (${a.directory})`).join(" and ")}, which the configuration no longer lists, left behind as ${loses.schema} starts empty`
	}
}

/** How the reviewer decided a loss the decision reaches, read from its file: its statement written in, so the data is
 * lost; left out with a candidate that carries the data chosen, so it is carried; left out with none, unresolved; or
 * written in while a carrier is chosen, decided both ways. A loss inside a rename that is not chosen is no decision:
 * its statement is a branch the review did not take (splitRenames). */
export type LossDecided =
	| { readonly kind: "lost"; readonly file: string; readonly loss: ReadLoss }
	| {
			readonly kind: "carried"
			readonly file: string
			readonly loss: ReadLoss
			readonly by: NonEmptyReadonlyArray<ReadCandidate>
	  }
	| { readonly kind: "unresolved"; readonly file: string; readonly loss: ReadLoss }
	| {
			readonly kind: "both"
			readonly file: string
			readonly loss: ReadLoss
			readonly by: NonEmptyReadonlyArray<ReadCandidate>
	  }

/** The candidates' labels, as a refusal lists them. */
const labels = (candidates: ReadonlyArray<ReadCandidate>): string =>
	candidates.map((c) => c.label).join("; ")

/** Why a recorded statement is one a review of its decision leaves out: the statement a choice keeps while `by` is
 * chosen; a statement an offer writes whose candidate `of` is not chosen; or a statement inside the rename `of`, which
 * is not chosen. */
type Exclusion =
	| { readonly kind: "kept"; readonly by: ReadCandidate }
	| { readonly kind: "untaken"; readonly of: ReadCandidate }
	| { readonly kind: "under"; readonly of: ReadCandidate }

/** Where a step stands under the decision: in it, at the top of its file or inside the chosen rename `within`; or left
 * out, for `why`. */
type Scope =
	| { readonly kind: "in"; readonly within: ReadCandidate | undefined }
	| { readonly kind: "out"; readonly why: Exclusion }

const topScope: Scope = { kind: "in", within: undefined }

/** A recorded statement the decision requires, with what is wrong when the file does not hold it. */
interface Required {
	readonly statement: Spelled
	readonly missing: string
}

/** One file's recorded statements sorted by the decision: what it requires; what it frees, the reviewer's to keep or
 * edit; what a review of it holds by its own decision, a loss written in or a confirmed statement; what it excludes;
 * the losses it reaches, decided; and what is decided in two ways at once. */
interface Sorted {
	readonly required: Array<Required>
	readonly free: Array<Spelled>
	readonly present: Array<Spelled>
	readonly excluded: Array<{ readonly statement: Spelled; readonly why: Exclusion }>
	readonly losses: Array<LossDecided>
	readonly splits: Array<SplitRename>
}

/** The statements an offer writes at the statement its choice decides: a rename's head, a replacement's statements. */
const offerWrites = (o: ReadOffer): ReadonlyArray<Spelled> => {
	switch (o.kind) {
		case "rename":
			return [o.candidate.head]
		case "replace":
			return o.statements
		case "delete":
			return []
	}
}

/** Whether two offers decide a statement one way: both delete it, or both replace it with the same statements. */
const sameDecision = (a: ReadOffer, b: ReadOffer): boolean => {
	if (a.kind === "delete" || b.kind === "delete") {
		return a.kind === b.kind
	}
	if (a.kind === "rename" || b.kind === "rename") {
		return false
	}
	return (
		a.statements.length === b.statements.length &&
		a.statements.every((x, i) => {
			const y = b.statements[i]
			return y !== undefined && writtenAs(x.tokens, y.tokens) && writtenAs(y.tokens, x.tokens)
		})
	)
}

/** A file's recorded statements sorted by the decision `chosen` (Sorted). */
const sortFile = (reviewed: Reviewed, chosen: ReadonlySet<ReadCandidate>): Sorted => {
	const { name, steps } = reviewed.file
	const sorted: Sorted = {
		required: [],
		free: [],
		present: [],
		excluded: [],
		losses: [],
		splits: []
	}
	const split = (detail: string): void => {
		sorted.splits.push({ kind: "split", file: name, detail })
	}
	const exclude = (statements: ReadonlyArray<Spelled>, why: Exclusion): void => {
		for (const statement of statements) {
			sorted.excluded.push({ statement, why })
		}
	}
	/** Every statement of an offer left out, for `why`: a rename's head and every step of its alternative. */
	const excludeOffer = (o: ReadOffer, why: Exclusion): void => {
		exclude(offerWrites(o), why)
		if (o.kind === "rename") {
			walk(o.alternative, { kind: "out", why })
		}
	}
	const walk = (list: ReadonlyArray<ReadStep>, scope: Scope): void => {
		for (const s of list) {
			if (scope.kind === "out") {
				switch (s.kind) {
					case "statement":
					case "loss":
						exclude([s.statement], scope.why)
						break
					case "confirm":
						exclude(s.statements, scope.why)
						break
					case "choice":
						exclude([s.keep, ...s.follows], scope.why)
						for (const o of s.offers) {
							excludeOffer(o, scope.why)
						}
						break
				}
				continue
			}
			const within = scope.within
			switch (s.kind) {
				case "statement":
					if (within === undefined) {
						sorted.free.push(s.statement)
					} else {
						sorted.required.push({
							statement: s.statement,
							missing: `${within.label} is chosen, but a statement of its alternative is not written as drafted: ${s.statement.text}`
						})
					}
					break
				case "loss": {
					const written = holds(reviewed.held, s.statement)
					const by = s.carriers.filter((c) => chosen.has(c))
					if (written) {
						sorted.present.push(s.statement)
					}
					if (isNonEmpty(by)) {
						sorted.losses.push(
							written
								? { kind: "both", file: name, loss: s, by }
								: { kind: "carried", file: name, loss: s, by }
						)
					} else {
						sorted.losses.push(
							written
								? { kind: "lost", file: name, loss: s }
								: { kind: "unresolved", file: name, loss: s }
						)
					}
					break
				}
				case "confirm": {
					const kept = s.statements.filter((x) => holds(reviewed.held, x))
					for (const x of kept) {
						sorted.present.push(x)
					}
					if (kept.length > 0 && kept.length < s.statements.length) {
						split(
							`${kept.length} of the ${s.statements.length} statements confirmed as one decision are kept as drafted, and the others are not: ${s.statements[0].text}`
						)
					}
					break
				}
				case "choice": {
					for (const x of s.follows) {
						sorted.free.push(x)
					}
					const taken = s.offers.filter((o: ReadOffer) => chosen.has(o.candidate))
					if (!isNonEmpty(taken)) {
						sorted.required.push({
							statement: s.keep,
							missing: `a statement ${labels(s.offers.map((o: ReadOffer) => o.candidate))} decides is neither kept as drafted nor replaced by a chosen candidate: ${s.keep.text}`
						})
						for (const o of s.offers) {
							excludeOffer(
								o,
								o.kind === "rename"
									? { kind: "under", of: o.candidate }
									: { kind: "untaken", of: o.candidate }
							)
						}
						break
					}
					const [one, ...others] = taken
					exclude([s.keep], { kind: "kept", by: one.candidate })
					if (others.some((o) => !sameDecision(one, o))) {
						split(
							`chosen candidates ${labels(taken.map((o) => o.candidate))} decide this statement in different ways: ${s.keep.text}`
						)
					}
					for (const x of offerWrites(one)) {
						sorted.required.push({
							statement: x,
							missing: `${one.candidate.label} is chosen, but this statement is not replaced as its alternative says: ${s.keep.text}`
						})
					}
					if (one.kind === "rename") {
						walk(one.alternative, { kind: "in", within: one.candidate })
					}
					for (const o of s.offers) {
						if (!chosen.has(o.candidate)) {
							excludeOffer(
								o,
								o.kind === "rename"
									? { kind: "under", of: o.candidate }
									: { kind: "untaken", of: o.candidate }
							)
						}
					}
					break
				}
			}
		}
	}
	walk(steps, topScope)
	return sorted
}

/** How a statement written as an excluded one is refused, for why it is excluded. */
const excludedText = (statement: string, why: Exclusion): string => {
	switch (why.kind) {
		case "kept":
			return `statement kept, but ${why.by.label} is chosen in ${why.by.file}: ${statement}`
		case "untaken":
			return `a statement ${why.of.label} writes is written, but ${why.of.label} is not chosen: ${statement}`
		case "under":
			return `a statement is written inside ${why.of.label}, which is not chosen: ${statement}`
	}
}

/** What a file holds beyond what its sorted record accounts for, one held copy taken per statement it requires,
 * frees or holds by its own decision: the statements a hole-free record matches first, then those with a placeholder,
 * each required before any freed. */
const extrasOf = (
	held: ReadonlyArray<HeldStatement>,
	sorted: Sorted
): {
	readonly missing: ReadonlyArray<Required>
	readonly extras: ReadonlyArray<HeldStatement>
} => {
	let rest = held
	const take = (statement: Spelled): boolean => {
		const at = firstIndex(rest, (h) => writtenAs(statement.tokens, h))
		if (at === undefined) {
			return false
		}
		rest = rest.toSpliced(at, 1)
		return true
	}
	const exact = (s: Spelled): boolean => !hasPlaceholder(s.tokens)
	const missing: Array<Required> = []
	for (const r of [
		...sorted.required.filter((x) => exact(x.statement)),
		...sorted.required.filter((x) => !exact(x.statement))
	]) {
		if (!take(r.statement)) {
			missing.push(r)
		}
	}
	for (const s of sorted.present) {
		take(s)
	}
	for (const s of [
		...sorted.free.filter((x) => exact(x)),
		...sorted.free.filter((x) => !exact(x))
	]) {
		take(s)
	}
	return { missing, extras: rest }
}

/** The refusal of a chosen candidate whose required candidate is not chosen: a field rename's, of its type's rename. */
const unmetBy = (
	c: ReadCandidate,
	chosen: ReadonlySet<ReadCandidate>
): ReadonlyArray<SplitRename> => {
	switch (c.kind) {
		case "relation":
		case "type":
		case "login":
			return []
		case "field":
		case "nested field":
			return c.requires.kind === "type" && !chosen.has(c.requires.candidate)
				? [
						{
							kind: "orphan",
							file: c.file,
							detail: `${c.label} is chosen without ${c.requires.candidate.label}, which it requires: ${c.head.text}`
						}
					]
				: []
	}
}

/** A review of a folder read against its record: the decision, what it refuses, and the losses it reaches. */
interface Evaluation {
	readonly splits: ReadonlyArray<SplitRename>
	readonly losses: ReadonlyArray<LossDecided>
}

/** The one reading of a reviewed folder against its record: the candidates decided from their heads (decided), then
 * each file's recorded statements sorted by that decision into what it requires, frees and excludes (sortFile), and
 * what the files hold compared with it. A required statement missing is a split; a loss or confirmed group is decided
 * by its own presence; and a statement the files hold beyond what the record accounts for, written as one the decision
 * excludes, is refused there, naming every excluded site it is written as: a split where it stands in the decision's
 * scope, an orphan inside a rename that is not chosen. Any other statement beyond them is the reviewer's own. No
 * statement is ever attributed to an owner by its text: its owner is its place in the record. */
const evaluate = (record: DecisionRecord, files: ReadonlyArray<FolderFile>): Evaluation => {
	const reviewed = reviewedIn(record, files)
	const chosen = decided(reviewed)
	const picked = [...chosen]
	const twice = picked.flatMap((c, i): ReadonlyArray<SplitRename> =>
		picked
			.slice(i + 1)
			.filter((other) => rivalEnds(c.ends, other.ends))
			.map((other) => ({
				kind: "twice",
				file: other.file,
				detail: `${c.label} and ${other.label} are both chosen, and rename one name twice: choose at most one rename for each added and each removed name`
			}))
	)
	const unmet = picked.flatMap((c) => unmetBy(c, chosen))
	const perFile = reviewed.map((r) => {
		const f = r.file
		const sorted = sortFile(r, chosen)
		const { missing, extras } = extrasOf(r.held, sorted)
		const written = extras.flatMap((e): ReadonlyArray<SplitRename> => {
			const sites = sorted.excluded.filter((x) => writtenAs(x.statement.tokens, e))
			const under = sites.filter((x) => x.why.kind === "under")
			const scoped = sites.filter((x) => x.why.kind !== "under")
			const refusal = (
				kind: "split" | "orphan",
				of: ReadonlyArray<{ readonly statement: Spelled; readonly why: Exclusion }>
			): ReadonlyArray<SplitRename> =>
				of.length === 0
					? []
					: [
							{
								kind,
								file: f.name,
								detail: of.map((x) => excludedText(x.statement.text, x.why)).join("; and ")
							}
						]
			return [...refusal("split", scoped), ...refusal("orphan", under)]
		})
		const both = sorted.losses.flatMap((d): ReadonlyArray<SplitRename> =>
			d.kind === "both"
				? [
						{
							kind: "split",
							file: f.name,
							detail: `${lossText(d.loss.loses)} is dropped by the statement written in, and carried by ${labels(d.by)}, which is chosen: write the statement in or choose the rename, not both: ${d.loss.statement.text}`
						}
					]
				: []
		)
		return {
			splits: [
				...sorted.splits,
				...missing.map((req): SplitRename => ({
					kind: "split",
					file: f.name,
					detail: req.missing
				})),
				...written,
				...both
			],
			losses: sorted.losses
		}
	})
	return {
		splits: [...unmet, ...twice, ...perFile.flatMap((f) => f.splits)],
		losses: perFile.flatMap((f) => f.losses)
	}
}

/** The refusals of a reviewed folder, read back from its files against its decision record (evaluate).
 *
 * A drafted rename candidate leaves the choice to the reviewer: keep the drafted drop and add, or swap in the commented
 * rename, its head. meta.json records every drafted statement in its place, so the decision is data: each candidate is
 * chosen exactly when its file holds its head, a field's rename nested in a relation's only where that rename is
 * chosen, decided once. `grizzle check` then reads every file against that decision, comparing statements as
 * PostgreSQL's scanner reads them (`writtenAs`), never as text: a statement a candidate decides kept as drafted when
 * no offered candidate is chosen and replaced as the chosen one's offer says when one is, never decided two ways; a
 * chosen candidate's required candidates chosen too; no two chosen candidates renaming one removed name or onto one
 * added name; a group the reviewer confirms under one marker kept whole or gone whole; a loss never both written in and
 * carried; and no statement of a branch the reviewer did not take written in, wherever it stands. A statement at the
 * top of a file that no candidate decides is the reviewer's to keep or edit, and a statement of the reviewer's own is
 * never refused. Whichever way the reviewer decides, the folder ends at its target snapshot, so nothing after the
 * folder reads the decision. */
export const splitRenames = (
	record: DecisionRecord,
	files: ReadonlyArray<FolderFile>
): ReadonlyArray<SplitRename> => evaluate(record, files).splits

/** Every loss a reviewed folder's decision reaches, as the reviewer decided it in `files` (LossDecided). */
export const lossDecisions = (
	record: DecisionRecord,
	files: ReadonlyArray<FolderFile>
): ReadonlyArray<LossDecided> => evaluate(record, files).losses
