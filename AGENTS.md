# Repository instructions

## Validation

- Run `git diff --check` and `npm test` before committing a code change.
- Keep `package.json` and both version fields in `package-lock.json` synchronized.
- Do not commit generated credentials, `auth.json`, or files from `.codex-acc`.

## Git push and release tags

- Only push or create a release tag when the user explicitly requests it.
- Releases use semantic versions and an annotated tag named exactly `v<package-version>`.
- Unless the user specifies another version, increment the patch version from the latest release tag.
- Before tagging, confirm the intended npm version is not already published, update the package version files, run validation, and commit all release changes.
- Push the `main` commit first, then push only the new tag explicitly. Do not use `git push --tags`.
- A push to `main` triggers `.github/workflows/ci.yml` on Node.js 18, 20, and 22.
- A `v*` tag triggers `.github/workflows/publish.yml`, which tests, publishes the package to npm, and creates the GitHub release.
- Never move or overwrite a published release tag. If a tagged release needs a correction, prepare a new patch version.
