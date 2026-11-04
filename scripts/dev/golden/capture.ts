import { NodeFileSystem, NodePath } from "@effect/platform-node"
/**
 * The golden capture: everything deterministic a tree of the repository compiles, written as canonical text files, so
 * two trees can be compared byte for byte.
 *
 *   node --conditions=grizzle-source <tree>/scripts/dev/golden/capture.ts <out-dir>
 *
 * The script captures the tree it lies in: every `#` import resolves through that tree's package.json, so the same file
 * copied into an unpacked baseline captures the baseline. It reaches only entry points both trees have, by their module
 * paths, and reads their answers by shape: a Result is the engine's (`ok`) or Effect's (`_tag` Success / Failure), and a
 * refusal is a CompileError read by its reason's tag and sentence.
 *
 * What it writes under <out-dir>, one file per subject, entries in name order:
 * - describe/<fixture>/<export>.json: the canonical Description of every query export of a fixture module;
 * - lower/<fixture>/<export>.sql: its lowered statements, or `REFUSED <reason tag> <sentence>`;
 * - install/<fixture>/<export>/...: every schema export drafted from the empty snapshot as `grizzle generate` drafts
 *   it (no workload, logins or extensions): each SQL file of the folder, meta.json and snapshot.json, or the refusal;
 * - history/<name>/<step>/...: the same along a history of versions, each drafted from the previous one's snapshot:
 *   the fixtures' Work, Payroll and IR histories; the migrate suite's worlds histories, each fixture rebuilt under a
 *   chosen name with the logins its worlds declare; the CLI suite's shop (two versions, its workload narrowed) and
 *   ledger, with their logins and workloads; and the capture's own scenarios (scenarios.ts: renames, a closed type's
 *   handles, a residual law). Each draft also writes the installation's fresh-install SQL (install.sql) and, with a
 *   workload, each login's programs' access and the access requests (workload.json);
 * - workload/<fixture>/<schema>/...: every fixture schema drafted with a workload of every query export over it;
 * - write/<fixture>/<export>.sql: every ChangeSet export compiled against its schema's artifacts in reality with no
 *   claims, as the runtime compiles it: the SQL of each statement of the optimized and the conservative artifact, in
 *   order, with its step's kind and every SQL text its forms hold, or the refusal.
 *
 * A fixed timestamp names every folder. The run fails only when a module cannot load; every compile answer, refusal
 * included, is captured.
 */
import {
	Array as Arr,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	ManagedRuntime,
	Option,
	Order,
	Path,
	Record as Rec,
	String as Str
} from "effect"
import { appendAll } from "#compiler/core/array.ts"

/** Node's file system and paths, taken once from a runtime of their layers: the capture writes through them. */
const { files, paths } = await ManagedRuntime.make(
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
).runPromise(
	Effect.all({ files: Effect.service(FileSystem.FileSystem), paths: Effect.service(Path.Path) })
)

const timestamp = "20261022000000"

const out = process.argv[2]
if (out === undefined) {
	process.stderr.write(
		"usage: node --conditions=grizzle-source scripts/dev/golden/capture.ts <out-dir>\n"
	)
	process.exit(2)
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null

/** Entries by key, in UTF-16 code unit order. */
const byKey = Order.mapInput(Order.String, ([key]: readonly [string, unknown]) => key)

/** A module's export by name, or a failure naming both. */
const exported = (module: unknown, name: string, from: string): unknown => {
	if (!isRecord(module) || !(name in module)) {
		throw new Error(`${from} exports no ${name}`)
	}
	return module[name]
}

/** The arguments the capture calls a function value with: at most four, each call's own. */
type CallArguments =
	| readonly []
	| readonly [unknown]
	| readonly [unknown, unknown]
	| readonly [unknown, unknown, unknown]
	| readonly [unknown, unknown, unknown, unknown]

/** Calls a function value with arguments, its answer read as unknown. */
const call = (fn: unknown, args: CallArguments): unknown => {
	if (typeof fn !== "function") {
		throw new Error("not a function")
	}
	const answer: unknown = Reflect.apply(fn, undefined, args)
	return answer
}

/** A Result of either vocabulary, settled to one shape. */
type Settled =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: unknown }

const settle = (result: unknown): Settled => {
	if (!isRecord(result)) {
		throw new Error(`not a Result: ${String(result)}`)
	}
	if (result["ok"] === true) {
		return { ok: true, value: result["value"] }
	}
	if (result["ok"] === false) {
		return { ok: false, error: result["error"] }
	}
	if (result["_tag"] === "Success") {
		return { ok: true, value: result["success"] }
	}
	if (result["_tag"] === "Failure") {
		return { ok: false, error: result["failure"] }
	}
	throw new Error("not a Result: no ok and no Success or Failure tag")
}

/**
 * A refusal as the capture writes it: the CompileError's reason tag and the reason's own sentence (a description's
 * `what`, an operation's `capability`), never its location, whose path names the tree it ran in; or what was thrown.
 */
const refusal = (error: unknown): string => {
	const reason = isRecord(error) ? error["reason"] : undefined
	if (isRecord(reason) && typeof reason["_tag"] === "string") {
		const sentence =
			typeof reason["what"] === "string"
				? reason["what"]
				: typeof reason["capability"] === "string"
					? reason["capability"]
					: "-"
		return `REFUSED ${reason["_tag"]} ${sentence}`
	}
	return `THREW ${Error.isError(error) ? `${error.name}: ${Str.split(error.message, "\n")[0]}` : String(error)}`
}

/** Runs a step, a throw read as a refusal. */
const attempt = (step: () => Settled): Settled => {
	try {
		return step()
	} catch (error) {
		return { ok: false, error }
	}
}

/**
 * A value with every object's keys in code point order, and a source site (`{ file, line, column }` under `site`) as
 * `<site>`: it names the tree's path and the fixture's line, which move with the files, not with the compiler.
 */
const ordered = (value: unknown): unknown => {
	if (Arr.isArray(value)) {
		return Arr.map(value, ordered)
	}
	if (isRecord(value)) {
		return Rec.fromEntries(
			Arr.map(Arr.sort(Rec.toEntries(value), byKey), ([key, v]) => [
				key,
				key === "site" && isRecord(v) && "file" in v && "line" in v ? "<site>" : ordered(v)
			])
		)
	}
	return value
}

/**
 * JSON with every object's keys in code point order, bigints as strings tagged `n`, two-space indented, a source site
 * as `<site>` (ordered). Effect's JSON writer, so the capture loads no module a baseline tree may lack.
 */
const canonical = (value: unknown): string => Formatter.formatJson(ordered(value), { space: 2 })

/** Records one subject the capture writes, by its path under <out-dir>, with its text. */
type Write = (path: string, text: string) => void

/** A module of the tree, by its specifier; a module that fails to load fails the capture. */
const load = (specifier: string): Effect.Effect<unknown> => Effect.promise(() => import(specifier))

const phantom = await Effect.runPromise(load("#compiler/core/phantom.ts"))
const builtKey = exported(phantom, "built", "phantom.ts")
const compiler = await Effect.runPromise(load("#compiler/program/describe.ts"))
const describeQuery = exported(compiler, "describeQuery", "program/describe.ts")
const lowerQuery = exported(compiler, "lowerQuery", "program/describe.ts")
const owning = exported(
	await Effect.runPromise(load("#test/support/policy.ts")),
	"owning",
	"test/support/policy.ts"
)

const completeInstallOptions = exported(
	await Effect.runPromise(load("#compiler/physical/complete.ts")),
	"completeInstallOptions",
	"physical/complete.ts"
)

const compileInstallation = exported(
	await Effect.runPromise(load("#compiler/physical/install/compile.ts")),
	"compileInstallation",
	"physical/install/compile.ts"
)

const generateMigration = exported(
	await Effect.runPromise(load("#compiler/deploy/render/generate.ts")),
	"generateMigration",
	"deploy/render/generate.ts"
)
const printStatement = exported(
	await Effect.runPromise(load("#compiler/sql/print.ts")),
	"printStatement",
	"sql/print.ts"
)
const snapshotBuild = await Effect.runPromise(load("#compiler/deploy/snapshot/build.ts"))
const emptySnapshot = exported(snapshotBuild, "emptySnapshot", "deploy/snapshot/build.ts")
const noWorkload = exported(snapshotBuild, "noWorkload", "deploy/snapshot/build.ts")
const changeSets = await Effect.runPromise(load("#compiler/write/changeset/value.ts"))
const isChangeSetValue = exported(changeSets, "isChangeSetValue", "write/changeset/value.ts")
const parseChangeSet = exported(changeSets, "parseChangeSet", "write/changeset/value.ts")
const programSchema = await Effect.runPromise(load("#compiler/program/schema.ts"))
const parseSchemaInput = exported(programSchema, "parseSchemaInput", "program/schema.ts")
const schemaArtifacts = exported(programSchema, "schemaArtifacts", "program/schema.ts")
const compileWrite = exported(
	await Effect.runPromise(load("#compiler/write/program/compile.ts")),
	"compileWrite",
	"write/program/compile.ts"
)

const schemaDescOf = exported(
	await Effect.runPromise(load("#compiler/schema/schema.ts")),
	"schemaDescOf",
	"schema/schema.ts"
)

const ownLogin = exported(
	await Effect.runPromise(load("#compiler/schema/own.ts")),
	"ownLogin",
	"schema/own.ts"
)

const loginDescOf = exported(
	await Effect.runPromise(load("#compiler/schema/world.ts")),
	"loginDescOf",
	"schema/world.ts"
)

const compileWorkload = exported(
	await Effect.runPromise(load("#compiler/program/workload/compile.ts")),
	"compileWorkload",
	"program/workload/compile.ts"
)

const workloadExtension = exported(
	await Effect.runPromise(load("#compiler/physical/access/extension.ts")),
	"workloadExtension",
	"physical/access/extension.ts"
)
const publicSchema = await Effect.runPromise(load("#compiler/public/schema.ts"))
const schemaBuilder = exported(publicSchema, "schema", "public/schema.ts")
const workloadBuilder = exported(
	await Effect.runPromise(load("#compiler/public/workload.ts")),
	"workload",
	"public/workload.ts"
)

const isBuilt = (value: unknown): value is Readonly<Record<string, unknown>> =>
	isRecord(value) && typeof builtKey === "symbol" && Reflect.get(value, builtKey) === true

const isSchema = (value: unknown): boolean =>
	isBuilt(value) && "relations" in value && "statements" in value

const isQuery = (value: unknown): boolean =>
	isBuilt(value) &&
	"rule" in value &&
	(typeof value["named"] === "function" || typeof value["take"] === "function")

/** The query's Description and lowered statements, or its refusal. */
const captureQuery = (write: Write, path: string, query: unknown): void => {
	const described = attempt(() => ({ ok: true, value: call(describeQuery, [query]) }))
	write(
		`describe/${path}.json`,
		described.ok ? canonical(described.value) : refusal(described.error)
	)
	const lowered = attempt(() => settle(call(lowerQuery, [query])))
	if (!lowered.ok) {
		write(`lower/${path}.sql`, refusal(lowered.error))
		return
	}
	const statements = isRecord(lowered.value) ? lowered.value["statements"] : undefined
	write(
		`lower/${path}.sql`,
		Arr.isArray(statements)
			? Arr.join(
					Arr.map(statements, (s: unknown) => `${String(s)}\n;`),
					"\n"
				)
			: canonical(lowered.value)
	)
}

/** Every string under a key named `sql`, depth first, in key order. */
const sqlTexts = (value: unknown, depth: number): ReadonlyArray<string> => {
	if (depth > 8 || !isRecord(value)) {
		return []
	}
	const found: Array<string> = []
	for (const [key, inner] of Arr.sort(Rec.toEntries(value), byKey)) {
		if (key === "sql" && typeof inner === "string") {
			found.push(inner)
		} else if (key !== "ast") {
			appendAll(found, sqlTexts(inner, depth + 1))
		}
	}
	return found
}

/** One artifact's statements as text: per statement its position, step kind, SQL and its forms' SQL texts. */
const artifactText = (artifact: unknown): string => {
	const statements = isRecord(artifact) ? artifact["statements"] : undefined
	if (!Arr.isArray(statements)) {
		return "-"
	}
	return Arr.join(
		Arr.map(statements, (statement: unknown) => {
			if (!isRecord(statement)) {
				return "-"
			}
			const step = statement["step"]
			const spec = statement["spec"]
			const kind = isRecord(step) && typeof step["kind"] === "string" ? step["kind"] : "-"
			const sql = isRecord(spec) && typeof spec["sql"] === "string" ? spec["sql"] : "-"
			const forms = statement["forms"]
			const formKind = isRecord(forms) && typeof forms["kind"] === "string" ? forms["kind"] : "-"
			const variants = formKind === "one" ? [] : sqlTexts(forms, 0)
			return Arr.join(
				[
					`-- statement ${String(statement["index"])} (${kind}, forms ${formKind})`,
					sql,
					...Arr.map(variants, (variant, index) => `-- form ${String(index)}\n${variant}`)
				],
				"\n"
			)
		}),
		"\n\n"
	)
}

/** Whether a query lowers: a fixture's workload takes the queries that do as its programs. */
const lowers = (query: unknown): boolean => attempt(() => settle(call(lowerQuery, [query]))).ok

/** A ChangeSet value compiled as the runtime compiles it in reality, or its refusal. */
const captureWrite = (write: Write, path: string, value: unknown): void => {
	const compiled = attempt(() => {
		const parsed = call(parseChangeSet, [value])
		const schema = isRecord(parsed) ? parsed["schema"] : undefined
		const input = settle(call(parseSchemaInput, [schema]))
		if (!input.ok) {
			return input
		}
		const artifacts = settle(
			call(schemaArtifacts, [input.value, { installation: undefined, vectorSchema: undefined }])
		)
		if (!artifacts.ok) {
			return artifacts
		}
		const a = artifacts.value
		const derived = isRecord(a) ? a["derived"] : undefined
		return settle(
			call(compileWrite, [
				isRecord(derived) ? derived["schema"] : undefined,
				isRecord(parsed) ? parsed["desc"] : undefined,
				{
					names: isRecord(a) ? a["names"] : undefined,
					reads: isRecord(a) ? a["reads"] : undefined,
					claims: { kind: "facts", present: [] },
					derivedKeys: isRecord(a) ? a["derivedKeys"] : undefined,
					viewKeys: isRecord(a) ? a["viewKeys"] : undefined,
					world: { kind: "reality" }
				}
			])
		)
	})
	if (!compiled.ok) {
		write(`write/${path}.sql`, refusal(compiled.error))
		return
	}
	const program = compiled.value
	const artifacts = isRecord(program) ? program["artifacts"] : undefined
	write(
		`write/${path}.sql`,
		Arr.join(
			[
				"-- optimized",
				artifactText(isRecord(artifacts) ? artifacts["optimized"] : undefined),
				"",
				"-- conservative",
				artifactText(isRecord(artifacts) ? artifacts["conservative"] : undefined)
			],
			"\n"
		)
	)
}

/**
 * One version a draft compiles: a schema value or description, installed under its declared name or `renamed` (every
 * level of it declared under that name, as an installation under a chosen name declares it), with the logins its
 * worlds declare and the workloads whose programs plan its access paths, by login ({ login, workloads }), or none.
 */
interface Version {
	readonly subject: unknown
	readonly renamed: string | undefined
	readonly logins: ReadonlyArray<unknown>
	readonly workloads: ReadonlyArray<unknown>
}

const plainVersion = (subject: unknown): Version => ({
	subject,
	renamed: undefined,
	logins: [],
	workloads: []
})

/** The workloads a login value owns, by its name, or none for a login that owns none. */
const ownedWorkloads = (login: unknown): ReadonlyArray<unknown> => {
	const workloads = isRecord(login) ? login["workload"] : undefined
	return isRecord(login) && Arr.isArray(workloads) && workloads.length > 0
		? [{ login: login["name"], workloads }]
		: []
}

/** A description with every level declared under `name`. */
const renamedDesc = (desc: unknown, name: string): unknown => {
	if (!isRecord(desc)) {
		return desc
	}
	const extended = desc["extends"]
	return {
		...desc,
		name,
		...(extended === undefined ? {} : { extends: renamedDesc(extended, name) })
	}
}

/** Every step of a settled chain, the first refusal stopping it. */
const chainOf = (steps: ReadonlyArray<() => Settled>): Settled => {
	let last: Settled = { ok: true, value: undefined }
	for (const step of steps) {
		last = step()
		if (!last.ok) {
			return last
		}
	}
	return last
}

/**
 * The installation of a version, as `grizzle generate` compiles it: its logins owned, its workload compiled under the
 * schema's artifacts with the logins' roles and planned as the workload extension, every other installer extension a
 * deployment needs; with each login's programs' access and the access requests for the draft. Or the refusal.
 */
const installationOf = (version: Version): Settled =>
	attempt(() => {
		const subject =
			version.renamed === undefined
				? version.subject
				: renamedDesc(call(schemaDescOf, [version.subject]), version.renamed)
		const owned = call(owning, [subject])
		/** The installation's identity the ownership minted (core/identity.ts), which installs it under its schema. */
		const identity = isRecord(owned) ? owned["installation"] : undefined
		const logins: Array<unknown> = []
		for (const login of version.logins) {
			const ownedLogin = settle(call(ownLogin, [call(loginDescOf, [login])]))
			if (!ownedLogin.ok) {
				return ownedLogin
			}
			logins.push(ownedLogin.value)
		}
		let plan: unknown
		if (version.workloads.length > 0) {
			const roles = Arr.flatMap(logins, (login) =>
				isRecord(login) && Arr.isArray(login["roles"]) ? login["roles"] : []
			)
			let input: unknown
			let artifacts: unknown
			const planned = chainOf([
				() => {
					const r = settle(call(parseSchemaInput, [owned]))
					input = r.ok ? r.value : undefined
					return r
				},
				() => {
					const r = settle(
						call(schemaArtifacts, [input, { installation: undefined, vectorSchema: undefined }])
					)
					artifacts = r.ok ? r.value : undefined
					return r
				},
				() => settle(call(compileWorkload, [version.workloads, input, { artifacts, roles }]))
			])
			if (!planned.ok) {
				return planned
			}
			plan = planned.value
		}
		const extensions = plan === undefined ? [] : [call(workloadExtension, [plan])]
		const installation = settle(
			call(compileInstallation, [
				owned,
				call(completeInstallOptions, [owned, identity, logins, extensions])
			])
		)
		if (!installation.ok) {
			return installation
		}
		const workload =
			plan === undefined || !isRecord(plan)
				? noWorkload
				: { access: plan["access"], accessPaths: plan["requests"] }
		return { ok: true, value: { installation: installation.value, workload, plan } }
	})

/** A draft from `previous` (none: the empty snapshot), written under `path`; the new snapshot, or none when refused. */
const captureDraft = (
	write: Write,
	path: string,
	version: Version,
	previous: unknown,
	name: string
): unknown => {
	const compiled = installationOf(version)
	if (!compiled.ok) {
		write(`${path}/REFUSED.txt`, refusal(compiled.error))
		return undefined
	}
	const holder = compiled.value
	const value = isRecord(holder) ? holder["installation"] : undefined
	const plan = isRecord(holder) ? holder["plan"] : undefined
	if (isRecord(plan)) {
		write(
			`${path}/workload.json`,
			canonical({ access: plan["access"], requests: plan["requests"] })
		)
	}
	const installStatements = isRecord(value) ? value["statements"] : undefined
	write(
		`${path}/install.sql`,
		Arr.isArray(installStatements)
			? Arr.join(
					Arr.map(installStatements, (s: unknown) => String(call(printStatement, [s]))),
					"\n;\n"
				)
			: String(installStatements)
	)
	const owned = isRecord(value) ? value["owned"] : undefined
	const ownedInstallation = isRecord(owned) ? owned["installation"] : undefined
	const from =
		previous ??
		call(emptySnapshot, [
			{
				schemaName: isRecord(owned) ? owned["name"] : undefined,
				schema: isRecord(ownedInstallation) ? ownedInstallation["identifier"] : undefined
			}
		])
	const drafted = attempt(() =>
		settle(
			call(generateMigration, [
				{
					previous: from,
					installation: value,
					workload: isRecord(holder) ? holder["workload"] : noWorkload,
					naming: { kind: "named", name },
					timestamp,
					abandoned: []
				}
			])
		)
	)
	if (!drafted.ok) {
		write(`${path}/REFUSED.txt`, refusal(drafted.error))
		return undefined
	}
	const result = drafted.value
	const folder = isRecord(result) ? result["folder"] : undefined
	const files = isRecord(folder) ? folder["files"] : undefined
	write(
		`${path}/folder.txt`,
		isRecord(folder)
			? `${String(folder["name"])}\nchange ${String(isRecord(result) ? result["change"] : "-")}`
			: "-"
	)
	if (Arr.isArray(files)) {
		for (const file of files) {
			if (isRecord(file)) {
				write(`${path}/files/${String(file["name"])}`, String(file["text"]))
			}
		}
	}
	write(`${path}/meta.json`, isRecord(folder) ? String(folder["metaText"]) : "-")
	write(`${path}/snapshot.json`, isRecord(result) ? String(result["snapshotText"]) : "-")
	return isRecord(result) ? result["snapshot"] : undefined
}

/** A history's versions drafted in order under `history/<name>`, each from the previous one's snapshot. */
const captureHistory = (
	write: Write,
	history: string,
	versions: ReadonlyArray<readonly [label: string, version: Version]>
): void => {
	let previous: unknown
	for (const [index, [label, version]] of versions.entries()) {
		previous = captureDraft(
			write,
			`history/${history}/${String(index + 1)}-${label}`,
			version,
			previous,
			`step_${String(index + 1)}`
		)
		if (previous === undefined) {
			return
		}
	}
}

/** The fixture modules whose exports are captured, by the name their files are written under. */
const fixtures: ReadonlyArray<readonly [name: string, specifier: string]> = [
	["api/graph", "#test/support/fixtures/api/graph.ts"],
	["api/ledger", "#test/support/fixtures/api/ledger.ts"],
	["api/payroll", "#test/support/fixtures/api/payroll.ts"],
	["api/platform", "#test/support/fixtures/api/platform.ts"],
	["api/queue", "#test/support/fixtures/api/queue.ts"],
	["api/search", "#test/support/fixtures/api/search.ts"],
	["api/spans", "#test/support/fixtures/api/spans.ts"],
	["api/work", "#test/support/fixtures/api/work.ts"],
	["education", "#test/support/fixtures/education/index.ts"],
	["ir/payroll", "#test/support/fixtures/ir/payroll.ts"],
	["ir/queue", "#test/support/fixtures/ir/queue.ts"],
	["ir/work", "#test/support/fixtures/ir/work.ts"],
	["workload", "#test/unit/workload/fixtures.ts"]
]

const byName = <A>(
	entries: ReadonlyArray<readonly [string, A]>
): ReadonlyArray<readonly [string, A]> => Arr.sort(entries, byKey)

/** A fixture module, or none when the tree has no such file (a fixture added after the baseline). */
const loadFixture = (specifier: string): Effect.Effect<unknown> =>
	Effect.catchDefect(load(specifier), (error) =>
		isRecord(error) &&
		error["code"] === "ERR_MODULE_NOT_FOUND" &&
		typeof error["url"] === "string" &&
		Str.endsWith(
			Str.slice(
				Str.indexOf("/")(specifier).pipe(
					Option.map((slash) => slash + 1),
					Option.getOrElse(() => 0)
				)
			)(specifier)
		)(error["url"])
			? Effect.void
			: Effect.die(error)
	)

/** The fixture modules, by the name their files are written under, loaded in order. */
const modules: ReadonlyMap<string, unknown> = new Map(
	await Effect.runPromise(
		Effect.forEach(fixtures, ([name, specifier]) =>
			Effect.map(loadFixture(specifier), (module) => [name, module] as const)
		)
	)
)

/** A fixture module's export, or none. */
const fixtureExport = (module: string, key: string): unknown => {
	const holder = modules.get(module)
	return isRecord(holder) ? holder[key] : undefined
}

/** A schema value rebuilt under `name` from its own relations and statements, as an installation under a name builds it. */
const rebuilt = (fixture: unknown, name: string): unknown =>
	isRecord(fixture)
		? call(schemaBuilder, [name, fixture["relations"], fixture["statements"]])
		: undefined

/** The `server` login of a fixture's worlds over the schema rebuilt under `name`. */
const serverOf = (worlds: unknown, rebuiltSchema: unknown): ReadonlyArray<unknown> => {
	const made = call(worlds, [rebuiltSchema])
	return isRecord(made) && made["server"] !== undefined ? [made["server"]] : []
}

/** A fixture schema with its worlds, rebuilt under `name`, or a version that names what is missing. */
const worldVersion = (
	module: string,
	key: string,
	worlds: string | undefined,
	name: string
): Version => {
	const fixture = fixtureExport(module, key)
	const world = worlds === undefined ? undefined : fixtureExport(module, worlds)
	return {
		subject: fixture,
		renamed: name,
		logins: world === undefined ? [] : serverOf(world, rebuilt(fixture, name)),
		workloads: []
	}
}

/** Runs one capture step, recording a throw under `path` instead of stopping the run. */
const guarded = (write: Write, path: string, step: () => void): void => {
	try {
		step()
	} catch (error) {
		write(`${path}/THREW.txt`, refusal(error))
	}
}

/**
 * The capture's run: every subject it writes, by its path under <out-dir>, with its text, each captured once. After the
 * fixtures and the histories, the CLI suite's shop and ledger (schemas with their server logins, which own their
 * workloads, the shop along its two versions), then the capture's own histories (scenarios.ts: renames, a closed type's
 * handles, a residual law added), each module loaded where the run reaches it.
 */
const captured: Effect.Effect<ReadonlyMap<string, string>> = Effect.gen(function* () {
	const written = new Map<string, string>()
	const write: Write = (path, text) => {
		if (written.has(path)) {
			throw new Error(`captured twice: ${path}`)
		}
		written.set(path, Str.endsWith("\n")(text) ? text : `${text}\n`)
	}

	for (const [name] of fixtures) {
		const module = modules.get(name)
		if (!isRecord(module)) {
			write(`absent/${name}.txt`, "this tree has no such fixture module")
			continue
		}
		for (const [key, value] of byName(Rec.toEntries(module))) {
			if (isQuery(value)) {
				captureQuery(write, `${name}/${key}`, value)
			} else if (call(isChangeSetValue, [value]) === true) {
				captureWrite(write, `${name}/${key}`, value)
			} else if (
				isSchema(value) ||
				(Str.startsWith("ir/")(name) && isRecord(value) && "relations" in value)
			) {
				captureDraft(write, `install/${name}/${key}`, plainVersion(value), undefined, "install")
			}
		}
	}

	guarded(write, "history/work", () =>
		captureHistory(write, "work", [
			["Work", plainVersion(fixtureExport("api/work", "Work"))],
			["Reports", plainVersion(fixtureExport("api/work", "Reports"))],
			["Work", plainVersion(fixtureExport("api/work", "Work"))],
			["Work", plainVersion(fixtureExport("api/work", "Work"))]
		])
	)

	guarded(write, "history/payroll", () =>
		captureHistory(write, "payroll", [
			["Payroll", plainVersion(fixtureExport("api/payroll", "Payroll"))],
			["Reporting", plainVersion(fixtureExport("api/payroll", "Reporting"))],
			["Payroll", plainVersion(fixtureExport("api/payroll", "Payroll"))],
			["Payroll", plainVersion(fixtureExport("api/payroll", "Payroll"))]
		])
	)

	guarded(write, "history/ir-work", () =>
		captureHistory(write, "ir-work", [
			["Work", plainVersion(fixtureExport("ir/work", "WorkDesc"))],
			["Reports", plainVersion(fixtureExport("ir/work", "ReportsDesc"))],
			["Work", plainVersion(fixtureExport("ir/work", "WorkDesc"))]
		])
	)

	guarded(write, "history/worlds-work", () => {
		const work = worldVersion("api/work", "Work", "workWorlds", "golden_work")
		captureHistory(write, "worlds-work", [
			["Work", work],
			[
				"Reports",
				{ ...plainVersion(fixtureExport("api/work", "Reports")), renamed: "golden_work" }
			],
			["Work", work],
			["Work", work]
		])
	})

	guarded(write, "history/worlds-payroll", () => {
		const payroll = {
			...plainVersion(fixtureExport("api/payroll", "Payroll")),
			renamed: "golden_payroll"
		}
		const reporting: Version = {
			subject: fixtureExport("api/payroll", "Reporting"),
			renamed: "golden_payroll",
			logins: serverOf(
				fixtureExport("api/payroll", "reportingWorlds"),
				rebuilt(fixtureExport("api/payroll", "Payroll"), "golden_payroll")
			),
			workloads: []
		}
		captureHistory(write, "worlds-payroll", [
			["Payroll", payroll],
			["Reporting", reporting],
			["Payroll", payroll],
			["Payroll", payroll]
		])
	})

	for (const [label, module, key, worlds] of [
		["plans", "api/work", "Plans", "plansWorlds"],
		["queue", "api/queue", "Queue", "queueWorlds"],
		["search", "api/search", "Search", "searchWorlds"],
		["ledger", "api/ledger", "Ledger", undefined],
		["network", "api/graph", "Network", undefined],
		["schedule", "api/spans", "Schedule", undefined],
		["calendars", "api/spans", "Calendars", undefined]
	] as const) {
		guarded(write, `history/worlds-${label}`, () => {
			const version = worldVersion(module, key, worlds, `golden_${label}`)
			captureHistory(write, `worlds-${label}`, [
				[key, version],
				[key, version]
			])
		})
	}

	for (const [name] of fixtures) {
		const module = modules.get(name)
		if (!isRecord(module)) {
			continue
		}
		const entries = byName(Rec.toEntries(module))
		for (const [key, value] of entries) {
			if (!isSchema(value)) {
				continue
			}
			const programs = Rec.fromEntries(
				Arr.filter(
					entries,
					([, q]) => isQuery(q) && lowers(q) && isRecord(q) && q["schema"] === value
				)
			)
			if (Rec.keys(programs).length === 0) {
				continue
			}
			guarded(write, `workload/${name}/${key}`, () => {
				const workloadValue = call(workloadBuilder, [value, programs])
				captureDraft(
					write,
					`workload/${name}/${key}`,
					{
						subject: value,
						renamed: undefined,
						logins: [],
						workloads: [{ login: "golden", workloads: [workloadValue] }]
					},
					undefined,
					"install"
				)
			})
		}
	}

	const cliFixture = yield* loadFixture("#test/pg/cli/fixture.ts")
	if (isRecord(cliFixture)) {
		const shopAt = (version: 1 | 2, byName: boolean): Version => {
			const built = call(cliFixture[version === 1 ? "shopV1" : "shopV2"], [
				"golden_shop",
				byName ? "full" : "withoutByName"
			])
			const server = isRecord(built) ? built["server"] : undefined
			return {
				subject: isRecord(built) ? built["schema"] : undefined,
				renamed: undefined,
				logins: server === undefined ? [] : [server],
				workloads: ownedWorkloads(server)
			}
		}
		guarded(write, "history/shop", () =>
			captureHistory(write, "shop", [
				["v1", shopAt(1, true)],
				["v2", shopAt(2, true)],
				["v2-without-by-name", shopAt(2, false)]
			])
		)
		guarded(write, "history/cli-ledger", () => {
			const built = call(cliFixture["ledger"], ["golden_ledger"])
			const server = isRecord(built) ? built["server"] : undefined
			const version: Version = {
				subject: isRecord(built) ? built["schema"] : undefined,
				renamed: undefined,
				logins: server === undefined ? [] : [server],
				workloads: ownedWorkloads(server)
			}
			captureHistory(write, "cli-ledger", [
				["ledger", version],
				["ledger", version]
			])
		})
	}

	const scenarioModule = yield* load("#scripts/dev/golden/scenarios.ts")
	const scenarioList = isRecord(scenarioModule) ? scenarioModule["scenarios"] : undefined
	if (Arr.isArray(scenarioList)) {
		for (const entry of scenarioList) {
			if (!Arr.isArray(entry)) {
				continue
			}
			const [label, build] = entry
			guarded(write, `scenario/${String(label)}`, () => {
				const versions = call(build, [])
				if (!Arr.isArray(versions)) {
					return
				}
				captureHistory(
					write,
					`scenario-${String(label)}`,
					Arr.map(versions, (v: unknown, index: number): readonly [string, Version] => [
						`v${String(index + 1)}`,
						{
							subject: isRecord(v) ? v["schema"] : undefined,
							renamed: undefined,
							logins: isRecord(v) && Arr.isArray(v["logins"]) ? v["logins"] : [],
							workloads: []
						}
					])
				)
			})
		}
	}

	return written
})

const written = await Effect.runPromise(captured)

await Effect.runPromise(
	Effect.gen(function* () {
		yield* files.remove(out, { recursive: true, force: true })
		yield* files.makeDirectory(out, { recursive: true })
		for (const [path, text] of written) {
			const file = paths.join(out, path)
			yield* files.makeDirectory(paths.dirname(file), { recursive: true })
			yield* files.writeFileString(file, text)
		}
	})
)

process.stdout.write(`golden capture: ${String(written.size)} files under ${out}\n`)
