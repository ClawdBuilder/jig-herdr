# Changelog

## [Unreleased]

- Initial split from Jig's `herdr/` folder, with the layout, mods and themes.
- The Context panel reads `contracts/requests.js` and the theme build reads `contracts/palettes.json` from the published Jig
  package, not relative paths into Jig.
- **TODO:** the dev dependency is a local tarball until `@clawdbuilder/jig@0.5.1` is released with the contracts; then pin
  `0.5.1`.
