# Icons

Most UI icons render through the official `@lucide/astro` package. Use its named
components, or the existing semantic wrappers here; do not draw or modify paths.
The package supplies intrinsic dimensions even before CSS loads.

`CloseIcon.svg` and `MenuIcon.svg` copy the exact `x` and `menu` nodes from
`@lucide/astro` 1.72.0 because client scripts also import them as raw SVG.
Their license is in `LICENSE.lucide.txt`.

Social logos copy the exact SVG contents from Bootstrap Icons 1.13.2:
https://github.com/twbs/icons/tree/v1.13.2/icons
Their license is in `LICENSE.bootstrap-icons.txt`.

The existing attendee avatars and cloud save-state icons intentionally retain
their custom SVG artwork.

`MoonIcon.astro` is the site's brand mark. The application progress ring is a
measurement graphic; its completion check uses Lucide.
