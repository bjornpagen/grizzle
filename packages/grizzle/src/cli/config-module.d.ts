/**
 * The application's configuration file as the bin (packages/grizzle/src/cli/main.ts) imports it: by the fixed specifier
 * `grizzle:config`, which its module resolve hook maps to the configuration file its command line names. The default
 * export is checked at run time (resolveConfig), so it is typed as unknown here.
 */
declare module "grizzle:config" {
	const config: unknown
	export default config
}
