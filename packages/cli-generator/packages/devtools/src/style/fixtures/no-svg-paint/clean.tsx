const paint = "currentColor"

export function CurrentColorFixture({ on }: Readonly<{ on: boolean }>) {
	return (
		<svg viewBox="0 0 1 1" className="fill-primary stroke-primary">
			<title>Fixture</title>
			<path fill={paint} stroke={on ? "currentColor" : "none"} />
			<rect fill="url(#gradient)" />
		</svg>
	)
}
