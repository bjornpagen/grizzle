import { Array as Arr, Schema, String as Str } from "effect"
import { STYLE_RULES } from "#style/types.ts"

/** A file or directory the options name: repository-relative, matched as a suffix of a file's absolute path at a "/"
 * boundary, so the same options read the same in every checkout. A path ending in "/" names a directory and matches
 * every file under it. */
const RepositoryPath = Schema.NonEmptyString

/** One CSS declaration, exactly as a stylesheet must write it. */
const Declaration = Schema.Struct({ property: Schema.NonEmptyString, value: Schema.String })

/** An `@utility` a scoped sheet may declare, with exactly its declarations. */
const Utility = Schema.Struct({
	name: Schema.NonEmptyString,
	declarations: Schema.Array(Declaration)
})

/** An `@page` a scoped sheet may declare, with exactly its declarations and the margin boxes it claims empty. */
const Page = Schema.Struct({
	name: Schema.NonEmptyString,
	declarations: Schema.Array(Declaration),
	emptyBoxes: Schema.Array(Schema.NonEmptyString)
})

/** A stylesheet besides the app's own: the one home of its scope's tokens (`--<scope>-*`, `--color-<scope>-*` and
 * `<theme namespace>-<scope>-*`), with the utilities and pages it alone may declare. It imports nothing. */
const ScopedSheet = Schema.Struct({
	path: RepositoryPath,
	scope: Schema.NonEmptyString,
	utilities: Schema.Array(Utility),
	pages: Schema.Array(Page)
})

/** The stylesheet contract: what the app's stylesheet (components.json's tailwind.css) and the scoped sheets may
 * hold, and the passthrough sheets that hold one fixed text. Any other stylesheet is a second theme or component
 * CSS owner. */
const StylesheetOptions = Schema.Struct({
	/** The modules the app's stylesheet may `@import`, as written between the quotes. */
	imports: Schema.Array(Schema.NonEmptyString),
	/** The `@custom-variant` rules any sheet may declare, as written after the at-rule's name. */
	customVariants: Schema.Array(Schema.NonEmptyString),
	/** The selectors whose top-level rules hold the palette, each with the color-scheme it may declare. */
	themeSelectors: Schema.Array(
		Schema.Struct({ selector: Schema.NonEmptyString, scheme: Schema.Literals(["light", "dark"]) })
	),
	/** The declarations `:root` may hold besides the palette, exactly. */
	rootValues: Schema.Array(Declaration),
	/** The rules of `@layer base`: each selector list, comma-separated, with exactly the `@apply` it holds. */
	baseRules: Schema.Array(
		Schema.Struct({ selector: Schema.NonEmptyString, apply: Schema.NonEmptyString })
	),
	/** The `@theme` declarations besides the palette's `--color-<name>: var(--<name>)` aliases, exactly. */
	themeAliases: Schema.Array(Declaration),
	scopedSheets: Schema.Array(ScopedSheet),
	/** Stylesheets that hold exactly this text, trimmed: an isolated preview that only imports the theme. */
	passthrough: Schema.Array(Schema.Struct({ path: RepositoryPath, text: Schema.NonEmptyString }))
})

/** An inline style operand one file may use: an expression, as written up to whitespace, or any member of a module's
 * named export, a property chain rooted at its import. */
const Operand = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("expression"), text: Schema.NonEmptyString }),
	Schema.Struct({
		kind: Schema.Literal("export"),
		module: Schema.NonEmptyString,
		name: Schema.NonEmptyString
	})
])

/** The doors the markup rule leaves open, each at the files that own it. */
const MarkupOptions = Schema.Struct({
	/** The inline `style` objects a file may write: each CSS property with the operands it may hold, measured
	 * layout or authored motion values, never static styling. */
	measuredStyles: Schema.Array(
		Schema.Struct({
			path: RepositoryPath,
			properties: Schema.Record(Schema.String, Schema.Array(Operand))
		})
	),
	/** The function a file declares that may merge a component's base style with its overlay's,
	 * `style: { ...base.style, ...overlay.style }`, and whose result a JSX spread may forward. */
	styleBridges: Schema.Array(
		Schema.Struct({
			path: RepositoryPath,
			function: Schema.NonEmptyString,
			base: Schema.NonEmptyString,
			overlay: Schema.NonEmptyString
		})
	),
	/** The files that may interpolate HTML into a template literal: bytes no React tree renders. */
	htmlTemplates: Schema.Array(RepositoryPath),
	/** The files that may construct a CSSStyleSheet and fill it with replaceSync. */
	stylesheetConstructors: Schema.Array(RepositoryPath)
})

/**
 * Each repository's own names for the style rules that need them, from the `superstyle` field of the repository
 * root's package.json. Every field is required: a repository where a rule has nothing to guard states that with an
 * empty list, so the rule is inert there.
 */
export const StyleOptions = Schema.Struct({
	/** The repository's exceptions: files where a rule's reports are not the repository's to fix, by the rule's id.
	 * Exceptions live here, never inline. */
	exceptions: Schema.Array(
		Schema.Struct({ rule: Schema.Literals(STYLE_RULES), files: Schema.Array(RepositoryPath) })
	),
	stylesheet: StylesheetOptions,
	markup: MarkupOptions
})

export type StyleOptions = typeof StyleOptions.Type

export type DeclarationOption = (typeof Declaration)["Type"]

export type ScopedSheetOption = (typeof ScopedSheet)["Type"]

export type MarkupOption = (typeof MarkupOptions)["Type"]

export type OperandOption = (typeof Operand)["Type"]

/** Whether a file is the one a repository-relative path names, or lies under the directory it names. */
export const isNamedBy =
	(path: string) =>
	(file: string): boolean => {
		if (Str.endsWith("/")(path)) {
			return Str.includes(`/${path}`)(file)
		}
		return file === path || Str.endsWith(`/${path}`)(file)
	}

/** Whether any of the paths names the file. */
export const isNamedByAny =
	(paths: ReadonlyArray<string>) =>
	(file: string): boolean =>
		Arr.some(paths, (path) => isNamedBy(path)(file))

/** Every path the options name, for the check that each names a file the run knows. */
export const pathsOf = (options: StyleOptions): ReadonlyArray<string> => [
	...Arr.flatMap(options.exceptions, (exception) => exception.files),
	...Arr.map(options.stylesheet.scopedSheets, (sheet) => sheet.path),
	...Arr.map(options.stylesheet.passthrough, (sheet) => sheet.path),
	...Arr.map(options.markup.measuredStyles, (entry) => entry.path),
	...Arr.map(options.markup.styleBridges, (bridge) => bridge.path),
	...options.markup.htmlTemplates,
	...options.markup.stylesheetConstructors
]

const FIXTURES = "src/style/fixtures"

const fixtureSheet = (path: string): ScopedSheetOption => ({
	path,
	scope: "report",
	utilities: [
		{
			name: "touch-callout-none",
			declarations: [{ property: "-webkit-touch-callout", value: "none" }]
		}
	],
	pages: [
		{
			name: "print",
			declarations: [{ property: "size", value: "letter" }],
			emptyBoxes: ["top-left"]
		}
	]
})

const PASSTHROUGH_TEXT = '@import "../../support/theme.css";'

const fixtureMeasured = (path: string): MarkupOption["measuredStyles"][number] => ({
	path,
	properties: {
		width: [
			{ kind: "expression", text: "box.width" },
			{ kind: "expression", text: "share" }
		],
		transform: [
			{ kind: "export", module: "#style/fixtures/support/motion.ts", name: "coverMotion" }
		]
	}
})

const fixtureBridge = (path: string): MarkupOption["styleBridges"][number] => ({
	path,
	function: "mergeSurfaceProps",
	base: "baseProps",
	overlay: "props"
})

/** The options the fixtures run under: names that point into each rule's own fixture directory. */
export const FIXTURE_OPTIONS: StyleOptions = {
	exceptions: [],
	stylesheet: {
		imports: ["tailwindcss"],
		customVariants: ["dark (&:is(.dark *))"],
		themeSelectors: [
			{ selector: ":root", scheme: "light" },
			{ selector: ".dark", scheme: "dark" }
		],
		rootValues: [{ property: "--radius", value: "0.625rem" }],
		baseRules: [
			{ selector: "*", apply: "border-border" },
			{ selector: 'button:not(:disabled), [role="button"]:not(:disabled)', apply: "cursor-pointer" }
		],
		themeAliases: [
			{ property: "--radius-lg", value: "var(--radius)" },
			{ property: "--spacing-report-gap", value: "1.5rem" }
		],
		scopedSheets: [
			fixtureSheet(`${FIXTURES}/stylesheet/scoped/violating.css`),
			fixtureSheet(`${FIXTURES}/stylesheet/scoped/clean.css`)
		],
		passthrough: [
			{ path: `${FIXTURES}/stylesheet/passthrough/violating.css`, text: PASSTHROUGH_TEXT },
			{ path: `${FIXTURES}/stylesheet/passthrough/clean.css`, text: PASSTHROUGH_TEXT },
			{ path: `${FIXTURES}/stylesheet/unnamed/clean.css`, text: PASSTHROUGH_TEXT }
		]
	},
	markup: {
		measuredStyles: [
			fixtureMeasured(`${FIXTURES}/markup/clean.tsx`),
			fixtureMeasured(`${FIXTURES}/markup/violating.tsx`)
		],
		styleBridges: [
			fixtureBridge(`${FIXTURES}/markup/clean.tsx`),
			fixtureBridge(`${FIXTURES}/markup/violating.tsx`),
			fixtureBridge(`${FIXTURES}/class-extraction/clean.tsx`),
			fixtureBridge(`${FIXTURES}/class-extraction/violating.tsx`)
		],
		htmlTemplates: [`${FIXTURES}/markup/clean.tsx`],
		stylesheetConstructors: [`${FIXTURES}/markup/clean.tsx`]
	}
}
