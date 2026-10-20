# Contributing

Thanks for looking. This is an unofficial community project; small, focused
contributions are the easiest to land.

## Setup

```bash
npm install
npm test
```

Tests run on `node:test` and spawn the bridge with a fake extension, so you
don't need Chrome to run them. To try the real thing, load `extension/`
unpacked and run the bridge (`npx opencode-chrome` or `node src/index.js`);
see the [README](README.md).

## Branch and PR flow

We use GitHub Flow: `main` stays releasable, every change lands through a
short-lived branch and a pull request.

- Branch names: `feature/...`, `fix/...`, `chore/...`, `docs/...`.
- One logical change per PR, ideally under ~400 lines. Split if it grows.
- Get a review from someone else before merging ("looks good" is enough).
- Merge with **rebase and merge** to keep history linear. Delete the branch
  after merging.
- Docs or CI-only fixes may go straight to `main`, but opening a PR anyway
  keeps a record.

Write commits and PR descriptions in a plain, concise human voice. No
AI-attribution trailers, no generated-code banners.

## Adding or changing a tool

The tool contract lives in three files that must stay in sync:

1. `src/tools.js` — the `TOOLS` array (name, description, zod schema).
2. `extension/background.js` — the `TOOLS` map (name → implementation).
3. `test/tools.test.js` — the `EXPECTED_TOOLS` list, plus a test if the tool
   has real behavior.

If the tool grows what `chrome.debugger` can do, check the permission
justifications in `docs/STORE_LISTING.md` still describe the surface.

Run `npm test` before pushing.

## Release

The version lives in four places that must move together: `package.json`,
`package-lock.json` (`npm version <v> --no-git-tag-version` covers both),
`extension/manifest.json`, and the `McpServer` call in `src/index.js`.
Missing one ships a bridge or extension that reports a different version
than npm.

1. Bump on a `chore/` branch and merge.
2. `npm publish` — needs `npm login` and a 2FA code; `prepublishOnly`
   runs `npm test` first.
3. `git tag -a v<version>` and push the tag.
4. `npm run pack`, then create the GitHub release attaching
   `dist/opencode-chrome-<version>.zip`.
5. Chrome Web Store: upload that same zip with the texts from
   `docs/STORE_LISTING.md`.

## Icons

Icons in `extension/icons/` are resized from the 1024px masters in `assets/`:

```bash
sips -z <size> <size> assets/logo-1024-transparent.png --out extension/icons/icon<size>.png
```

## Reporting bugs

Open an issue: <https://github.com/G10hdz/opencode-chrome/issues>. Include
your OS, Node and Chrome versions, and the bridge's stderr if relevant.

## License

By contributing you agree your work is licensed under the [MIT
license](LICENSE), same as the project.
