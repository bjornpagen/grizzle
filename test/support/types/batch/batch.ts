import { defined } from "@bjornpagen/testing/assert"
import { regex } from "arkregex"
import {
	Array as Arr,
	Data,
	Effect,
	Equivalence,
	FileSystem,
	Option,
	Order,
	Path,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { compiled, type Ran } from "#test/support/types/batch/compiler.ts"
import {
	type Directive,
	disarm,
	type FileLine,
	lineKey
} from "#test/support/types/batch/directives.ts"

/**
 * A type-test batch: the cases of one batch of a type property written as one program, which the repository's compiler
 * (tsgo) checks once in the batch's own directory, every diagnostic then attributed to whoever answers for the line it
 * stands on, the batch itself or one of its cases, so each case's verdict is its own lines' diagnostics. Loading the
 * sources' type graph is most of a small program's check, so a batch amortizes it over its cases, and a failing case
 * still prints, shrinks and replays alone (a batch of one).
 *
 * A program is checked armed, as written, or disarmed: every directive (directives.ts Claim) disarmed, so its line
 * must raise an error, and the error must hold what the directive claims of it (a code, a refusal grizzle's type names,
 * no refusal unnamed, or its twins' diagnostics), and no line under no directive may raise one. A program's directory
 * resolves packages as the repository's root does (its node_modules is the root's), its tsconfig extends the
 * repository's base configuration with the compiler's strictness alone (no Effect language service, no truncation, no
 * build info), and a module reaches a repository file through the specifier its Entry spells.
 */

/**
 * Who answers for a line of a batch's program: the batch, for the lines every case shares (imports, declarations the
 * cases read, fixed probes), or one case, by its place among the batch's cases.
 */
export type Owner = Readonly<{ kind: "batch" }> | Readonly<{ kind: "case"; at: number }>

/** The batch's own lines. */
export const batchOwned: Owner = { kind: "batch" }

/** The lines of the case at `at` among the batch's cases. */
export const caseOwned = (at: number): Owner => ({ kind: "case", at })

/** Consecutive lines of a module, and who answers for them. */
export type Part = Readonly<{ owner: Owner; lines: ReadonlyArray<string> }>

/** One module of a batch's program: its file name in the program's directory, and its parts in order. */
export type ProgramModule = Readonly<{ file: string; parts: ReadonlyArray<Part> }>

/** A batch's program: its modules, the compiler's root files. */
export type Program = Arr.NonEmptyReadonlyArray<ProgramModule>

/** How a program is checked: as written, or with every directive disarmed. */
export type Checking = "armed" | "disarmed"

/** How a program spells the repository path `path` as a module specifier, from the program's directory. */
export type Entry = (path: string) => string

/**
 * What a line contradicts in a claim, or in the batch:
 * - `code`: a line raises other codes than the one its directive claims;
 * - `refusal missing`: a line raises no diagnostic printing the refusal its directive names;
 * - `refusal unnamed`: a line prints a refusal its directive does not name;
 * - `twin alone`: a twin's label stands on one line, which compares it with nothing;
 * - `twins differ`: the lines of one twin label raise different diagnostics.
 */
export type Problem =
	| Readonly<{ kind: "code"; at: FileLine; claimed: string; raised: ReadonlyArray<string> }>
	| Readonly<{ kind: "refusal missing"; at: FileLine; refusal: string }>
	| Readonly<{ kind: "refusal unnamed"; at: FileLine; printed: string }>
	| Readonly<{ kind: "twin alone"; label: string; at: FileLine }>
	| Readonly<{
			kind: "twins differ"
			label: string
			lines: ReadonlyArray<Readonly<{ at: FileLine; raised: ReadonlyArray<string> }>>
	  }>

/** A problem as a verdict prints it. */
const problemText = (problem: Problem): string => {
	switch (problem.kind) {
		case "code":
			return `${lineKey(problem.at)}: raises ${Arr.join(problem.raised, ", ")}, where its directive claims ${problem.claimed}`
		case "refusal missing":
			return `${lineKey(problem.at)}: the diagnostic carries no Refusal<"${problem.refusal}">`
		case "refusal unnamed":
			return `${lineKey(problem.at)}: the diagnostic carries ${problem.printed}: name it, "// @ts-expect-error -- refusal: <message>"`
		case "twin alone":
			return `${lineKey(problem.at)}: twin ${problem.label} stands on this line alone, which compares it with nothing`
		case "twins differ":
			return `twin ${problem.label} raises other diagnostics at each of its lines: ${Arr.join(
				Arr.map(problem.lines, ({ at, raised }) => `${lineKey(at)} ${Arr.join(raised, ", ")}`),
				"; "
			)}`
	}
}

/** An error diagnostic tsgo printed: where, its code, and its text, its first line and every continuation line. */
type ErrorDiagnostic = FileLine & Readonly<{ code: string; text: string }>

/**
 * What one owner's lines came to: every line tsgo printed for them, continuation lines included, the lines its
 * directives promise an error on, the lines its errors stand on, and what its lines contradict.
 */
export type LinesJudged = Readonly<{
	output: ReadonlyArray<string>
	expected: ReadonlyArray<string>
	actual: ReadonlyArray<string>
	problems: ReadonlyArray<Problem>
}>

/** Whether an owner's lines agree: every directive's line raises an error, no other line does, and nothing is contradicted. */
const agrees = (judged: LinesJudged): boolean =>
	!Arr.isReadonlyArrayNonEmpty(judged.problems) &&
	Arr.makeEquivalence(Equivalence.String)(judged.expected, judged.actual)

/**
 * What a batch's check came to: each case's lines by its place, the batch's own lines, and every line tsgo printed
 * that names no line of the program (a diagnostic in a source file, an option it refused, an abnormal exit), which the
 * batch answers for.
 */
type Attributed = Readonly<{
	cases: ReadonlyArray<LinesJudged>
	batch: LinesJudged
	unattributed: ReadonlyArray<string>
}>

/**
 * A case's lines disagree with what the compiler reported, or the batch's own lines do, which every case of the batch
 * shares: `lines` are the case's program lines, each as `file:line | text`, and `judged` and `batch` what each came to.
 */
export class TypesDisagreed extends Data.TaggedError("TypesDisagreed")<{
	readonly lines: ReadonlyArray<string>
	readonly judged: LinesJudged
	readonly batch: LinesJudged
	readonly unattributed: ReadonlyArray<string>
}> {
	override get message(): string {
		const section = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
			Arr.isReadonlyArrayNonEmpty(lines) ? [title, ...Arr.map(lines, (line) => `  ${line}`)] : []
		const judgedLines = (whose: string, judged: LinesJudged): ReadonlyArray<string> => [
			...section(`${whose} lines tsgo reported:`, judged.output),
			...(agrees(judged)
				? []
				: [
						`${whose} directives promise an error at [${Arr.join(judged.expected, ", ")}], and tsgo raised one at [${Arr.join(judged.actual, ", ")}]`,
						...section(`${whose} contradicted claims:`, Arr.map(judged.problems, problemText))
					])
		]
		return Arr.join(
			[
				...judgedLines("the case's", this.judged),
				...(agrees(this.batch) && !Arr.isReadonlyArrayNonEmpty(this.unattributed)
					? []
					: [
							...judgedLines("the batch's own", this.batch),
							...section("tsgo reported, on no line of the program:", this.unattributed)
						]),
				...section("the case's program lines:", this.lines)
			],
			"\n"
		)
	}
}

/**
 * Each case's verdict: it passes when its own lines agree and the batch's own lines do, with nothing reported outside
 * the program; otherwise it fails with TypesDisagreed, its program lines beside it.
 */
const verdictsOf = (
	program: Program,
	attributed: Attributed
): ReadonlyArray<Effect.Effect<void, TypesDisagreed>> => {
	const batchAgrees =
		agrees(attributed.batch) && !Arr.isReadonlyArrayNonEmpty(attributed.unattributed)
	return Arr.map(attributed.cases, (judged, at) =>
		batchAgrees && agrees(judged)
			? Effect.void
			: Effect.fail(
					new TypesDisagreed({
						lines: ownedLines(program, caseOwned(at)),
						judged,
						batch: attributed.batch,
						unattributed: attributed.unattributed
					})
				)
	)
}

/** Whether two owners are one. */
const sameOwner = (a: Owner, b: Owner): boolean =>
	a.kind === "batch" ? b.kind === "batch" : b.kind === "case" && b.at === a.at

/** The lines `owner` answers for, as `file:line | text`. */
export const ownedLines = (program: Program, owner: Owner): ReadonlyArray<string> =>
	Arr.flatMap(program, (module) =>
		Arr.filterMap(
			Arr.map(ownersOf(module), (lineOwner, index) => [lineOwner, index] as const),
			([lineOwner, index]) =>
				sameOwner(lineOwner, owner)
					? Result.succeed(
							`${module.file}:${index + 1} | ${Arr.getUnsafe(textLines(module), index)}`
						)
					: Result.failVoid
		)
	)

/** A module's text, its parts' lines in order. */
const moduleText = (module: ProgramModule): string => Arr.join(textLines(module), "\n")

/** A part's lines as the module's text holds them: a line its generator wrote with line breaks in it is several. */
const partLines = (part: Part): ReadonlyArray<string> =>
	Arr.flatMap(part.lines, (line) => Str.split(line, "\n"))

const textLines = (module: ProgramModule): ReadonlyArray<string> =>
	Arr.flatMap(module.parts, partLines)

/** Who answers for each line of a module, by its index (its line, less one). */
const ownersOf = (module: ProgramModule): ReadonlyArray<Owner> =>
	Arr.flatMap(module.parts, (part) => Arr.map(partLines(part), () => part.owner))

/** "index.ts(12,3): error TS2345: ..." -> its path, line, category and code. */
const diagnosticLine = regex(
	"^(.+?)\\((\\d+),(\\d+)\\): (error|warning|message|suggestion) (TS\\d+): "
)

/** A continuation line of the diagnostic above it. */
const continuationLine = regex("^\\s")

/**
 * A refusal as a diagnostic prints its type, `Refusal<"…">`: the message as TypeScript spells a string literal type, a
 * double quote or a backslash in it escaped, as JSON escapes them.
 */
const printedRefusal = (refusal: string): string => `Refusal<${jsonText(refusal)}>`

/** The text from `Refusal<"` through the next `">`: the refusal a diagnostic prints, none where it prints none. */
const refusalFragment = (text: string): Option.Option<string> =>
	Option.flatMap(Str.indexOf('Refusal<"')(text), (start) =>
		Option.map(Str.indexOf('">')(Str.slice(start)(text)), (length) =>
			Str.slice(start, start + length + 2)(text)
		)
	)

/** A line's diagnostics as a twin compares them: each code it raises beside the refusal it prints, sorted and distinct. */
const signatureAt = (errors: ReadonlyArray<ErrorDiagnostic>, at: FileLine): ReadonlyArray<string> =>
	Arr.sort(
		Arr.dedupe(
			Arr.filterMap(errors, (e) =>
				e.file === at.file && e.line === at.line
					? Result.succeed(
							Option.match(refusalFragment(e.text), {
								onNone: () => e.code,
								onSome: (printed) => `${e.code} ${printed}`
							})
						)
					: Result.failVoid
			)
		),
		Order.String
	)

/**
 * What each directive's line contradicts in its own claim (directives.ts Claim): a code other than the one claimed, a
 * named refusal the line does not print, or a refusal it prints that the directive does not name. A line that raises
 * nothing is the expected/actual mismatch of its owner, never a problem of its own.
 */
const contradicted = (
	directives: ReadonlyArray<Directive>,
	errors: ReadonlyArray<ErrorDiagnostic>
): ReadonlyArray<Problem> =>
	Arr.flatMap(directives, (directive): ReadonlyArray<Problem> => {
		const at: FileLine = { file: directive.file, line: directive.line }
		const matched = Arr.filter(errors, (e) => e.file === at.file && e.line === at.line)
		const codes = Arr.sort(Arr.dedupe(Arr.map(matched, (e) => e.code)), Order.String)
		const printed = Arr.findFirst(matched, (e) => refusalFragment(e.text))
		const unnamed = (): ReadonlyArray<Problem> =>
			Option.match(printed, {
				onNone: () => [],
				onSome: (fragment): ReadonlyArray<Problem> => [
					{ kind: "refusal unnamed", at, printed: fragment }
				]
			})
		const claim = directive.claim
		switch (claim.kind) {
			case "code":
				return [
					...(!Arr.isReadonlyArrayNonEmpty(codes) || (codes.length === 1 && codes[0] === claim.code)
						? []
						: [{ kind: "code", at, claimed: claim.code, raised: codes } satisfies Problem]),
					...unnamed()
				]
			case "refusal":
				return !Arr.isReadonlyArrayNonEmpty(matched) ||
					Arr.some(matched, (e) => Str.includes(printedRefusal(claim.refusal))(e.text))
					? []
					: [{ kind: "refusal missing", at, refusal: claim.refusal }]
			case "refused":
				return unnamed()
			case "twin":
				return []
		}
	})

/** A twin label's problem, and every owner of one of its lines, each of whom answers for it. */
type TwinProblem = Readonly<{ problem: Problem; owners: ReadonlyArray<Owner> }>

/**
 * The problems of each twin label, across the whole program: a label on one line alone, or lines of one label raising
 * different diagnostics.
 */
const twinProblems = (
	directives: ReadonlyArray<OwnedDirective>,
	errors: ReadonlyArray<ErrorDiagnostic>
): ReadonlyArray<TwinProblem> => {
	const twins = Arr.groupBy(
		Arr.filterMap(directives, ({ directive, owner }) =>
			directive.claim.kind === "twin"
				? Result.succeed({
						label: directive.claim.label,
						at: { file: directive.file, line: directive.line },
						owner
					})
				: Result.failVoid
		),
		(twin) => twin.label
	)
	return Arr.flatMap(Rec.toEntries(twins), ([label, lines]): ReadonlyArray<TwinProblem> => {
		const owners = Arr.map(lines, (line) => line.owner)
		const [first, ...rest] = lines
		if (!Arr.isReadonlyArrayNonEmpty(rest)) {
			return [{ problem: { kind: "twin alone", label, at: first.at }, owners }]
		}
		const raised = Arr.map(lines, ({ at }) => ({ at, raised: signatureAt(errors, at) }))
		const reference = signatureAt(errors, first.at)
		return Arr.every(raised, ({ raised: signature }) =>
			Arr.makeEquivalence(Equivalence.String)(signature, reference)
		)
			? []
			: [{ problem: { kind: "twins differ", label, lines: raised }, owners }]
	})
}

/** A directive, and who answers for the line it claims. */
type OwnedDirective = Readonly<{ directive: Directive; owner: Owner }>

/** A program as written into its directory: each module's owners by line, and its directives. */
type Placed = Readonly<{
	owners: ReadonlyMap<string, ReadonlyArray<Owner>>
	directives: ReadonlyArray<OwnedDirective>
}>

/**
 * A directive outside the grammar (directives.ts disarm), which no line can be judged against: the program's own
 * defect, so every case of the batch fails with it.
 */
class DirectiveUnreadable extends Data.TaggedError("DirectiveUnreadable")<{
	readonly reason: string
}> {
	override get message(): string {
		return this.reason
	}
}

/**
 * The ambient declarations the repository's packages state for the modules their sources import, each its package's
 * tsconfig includes with its sources: packages/grizzle's `grizzle:config`, the configuration file the command line
 * imports (packages/grizzle/src/cli/main.ts). A program that reaches such a source, as one whose test support reaches
 * the command line does, reads the declaration as the package's own check does.
 */
const ambientDeclarations = ["packages/grizzle/src/cli/config-module.d.ts"] as const

/**
 * Writes `program` into `dir`, checked as `checking` says: its modules, a package.json that makes them modules, its
 * node_modules (the repository root's), and its tsconfig over its modules and the packages' ambient declarations
 * (ambientDeclarations), extending the root's base configuration.
 */
const place = (root: string, dir: string, program: Program, checking: Checking) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* fs.writeFileString(path.join(dir, "package.json"), '{ "type": "module" }\n')
		yield* fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"))
		yield* fs.writeFileString(
			path.join(dir, "tsconfig.json"),
			jsonText({
				extends: path.relative(dir, path.join(root, "tsconfig.base.json")),
				compilerOptions: {
					noEmit: true,
					incremental: false,
					noErrorTruncation: true,
					plugins: []
				},
				files: [
					...Arr.map(program, (module) => module.file),
					...Arr.map(ambientDeclarations, (file) => path.relative(dir, path.join(root, file)))
				]
			})
		)
		const written = yield* Effect.forEach(program, (module) =>
			Effect.gen(function* () {
				const owners = ownersOf(module)
				const text = moduleText(module)
				const armed =
					checking === "disarmed"
						? yield* Effect.try({
								try: () => disarm(module.file, text),
								catch: (thrown) =>
									new DirectiveUnreadable({
										reason: Error.isError(thrown) ? thrown.message : String(thrown)
									})
							})
						: { source: text, directives: [] }
				yield* fs.writeFileString(path.join(dir, module.file), armed.source)
				return {
					file: module.file,
					owners,
					directives: Arr.map(armed.directives, (directive) => ({
						directive,
						owner: Arr.getUnsafe(owners, directive.line - 2)
					}))
				}
			})
		)
		const placed: Placed = {
			owners: new Map(Arr.map(written, (w) => [w.file, w.owners] as const)),
			directives: Arr.flatMap(written, (w) => w.directives)
		}
		return placed
	})

/**
 * Attributes every line tsgo printed, run in `dir`, to the owner of the program line it names, and judges each owner's
 * lines against its directives. A line naming no line of the program, and whatever tsgo printed on stderr or an exit
 * past its two statuses of diagnostics, the batch answers for.
 */
const attribute = (ran: Ran, dir: string, placed: Placed, count: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const files = new Map<string, string>()
		for (const file of placed.owners.keys()) {
			const real = yield* fs.realPath(path.join(dir, file))
			files.set(real, file)
		}
		const outputs = Array.from({ length: count + 1 }, (): Array<string> => [])
		const printed: Array<
			Readonly<{ at: FileLine; code: string; owner: Owner; lines: Array<string> }>
		> = []
		const unattributed: Array<string> = []
		const slot = (owner: Owner): number => (owner.kind === "batch" ? count : owner.at)
		let current: Array<string> | undefined
		let continued: Array<string> | undefined
		for (const line of Str.split(ran.stdout, "\n")) {
			if (Str.trim(line) === "") {
				continue
			}
			if (continuationLine.test(line) && current !== undefined) {
				current.push(line)
				continued?.push(line)
				continue
			}
			continued = undefined
			const match = diagnosticLine.exec(line)
			const named =
				match === null
					? undefined
					: yield* fs.realPath(path.resolve(dir, defined(match[1], "the file a diagnostic names")))
			const file = named === undefined ? undefined : files.get(named)
			const owner =
				match === null || file === undefined
					? Option.none<Owner>()
					: Arr.get(
							defined(placed.owners.get(file), "a placed module's owners"),
							Number(match[2]) - 1
						)
			if (match === null || file === undefined || Option.isNone(owner)) {
				unattributed.push(line)
				current = unattributed
				continue
			}
			const output = Arr.getUnsafe(outputs, slot(owner.value))
			output.push(line)
			current = output
			if (match[4] === "error") {
				continued = [line]
				printed.push({
					at: { file, line: Number(match[2]) },
					code: defined(match[5], "the code a diagnostic names"),
					owner: owner.value,
					lines: continued
				})
			}
		}
		for (const line of Str.split(ran.stderr, "\n")) {
			if (Str.trim(line) !== "") {
				unattributed.push(line)
			}
		}
		if (ran.status > 2) {
			unattributed.push(`tsgo exited abnormally: status ${ran.status}`)
		}
		const texted = Arr.map(printed, (p) => ({
			file: p.at.file,
			line: p.at.line,
			code: p.code,
			owner: p.owner,
			text: Arr.join(p.lines, "\n")
		}))
		const twins = twinProblems(placed.directives, texted)
		const judgedOf = (owner: Owner): LinesJudged => {
			const own = Arr.filter(texted, (e) => sameOwner(e.owner, owner))
			const directives = Arr.filterMap(placed.directives, (d) =>
				sameOwner(d.owner, owner) ? Result.succeed(d.directive) : Result.failVoid
			)
			const lines = (places: ReadonlyArray<FileLine>) =>
				Arr.sort(Arr.dedupe(Arr.map(places, lineKey)), Order.String)
			return {
				output: Arr.getUnsafe(outputs, slot(owner)),
				expected: lines(directives),
				actual: lines(own),
				problems: [
					...contradicted(directives, own),
					...Arr.filterMap(twins, ({ problem, owners }) =>
						Arr.some(owners, (o) => sameOwner(o, owner)) ? Result.succeed(problem) : Result.failVoid
					)
				]
			}
		}
		const attributed: Attributed = {
			cases: Array.from({ length: count }, (_, at) => judgedOf(caseOwned(at))),
			batch: judgedOf(batchOwned),
			unattributed
		}
		return attributed
	})

/** How a program in `dir` spells a repository path at `root`: relative to `dir`, `./` before a path into it. */
export const entryFrom =
	(path: Path.Path, root: string, dir: string): Entry =>
	(repoPath) => {
		const relative = path.relative(dir, path.join(root, repoPath))
		return Str.startsWith(".")(relative) ? relative : `./${relative}`
	}

/**
 * Checks the program `write` gives for `dir`'s Entry against the repository checked out at `checkout` (a mutant's
 * worker tree under the mutator), written into the empty directory `dir` and checked as `checking` says, by the
 * checkout's compiler under its stall guard: each of its `count` cases' verdict, in place order.
 */
export const checkedBatch = (
	checkout: string,
	dir: string,
	checking: Checking,
	count: number,
	write: (entry: Entry) => Program
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const root = yield* fs.realPath(checkout)
		const at = yield* fs.realPath(dir)
		const program = write(entryFrom(path, root, at))
		const placed = yield* place(root, at, program, checking)
		const ran = yield* compiled(root, at, ["--pretty", "false", "-p", "tsconfig.json"])
		const attributed = yield* attribute(ran, at, placed, count)
		return verdictsOf(program, attributed)
	})
