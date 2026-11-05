const run = (args: ReadonlyArray<string>, cwd: string): string => `${cwd} ${args.join(" ")}`

const main = (): string => run(process.argv.slice(2), process.cwd())

const report = (): void => {
	console.log(main())
}

if (import.meta.main) {
	console.log(run(process.argv.slice(2), process.cwd()))
	report()
}
