# soksak-plugin-terminal-ghostty

Terminal plugin that renders the terminal view from the ghostty provider frame through
`soksak-kit-plugin-terminal`.

The common terminal kit owns view registration, PTY and recovery lifecycle, resize coordination,
public status, terminal theme resolution, waits, and every command required by the terminal plugin
contract. This plugin declares the `soksak-sidecar-pty` and `soksak-sidecar-terminal-ghostty`
sidecar dependencies by id and version and activates the kit's provider terminal plugin.

## Verification

The package depends on `@soksak/soksak-contract-plugin-terminal` and `@soksak/soksak-kit-plugin-terminal`,
so every `make` invocation that installs requires `REGISTRY` on the make command line,
`https://registry.npmjs.org` included once the packages are published there. A value from the
environment is refused. The Makefile reads the requirement from `frontend/package.json` and refuses
`REGISTRY required: this package depends on @soksak/...` when it is absent.

The build input is identified by the `pnpm-lock.yaml` integrity, not by `REGISTRY`. pnpm fetches from
`REGISTRY` only a package whose integrity its content-addressable store does not already hold, so a
second install of the same lockfile on the same machine reads the store and never contacts `REGISTRY`.

`make lock` is the only owner operation that regenerates `frontend/pnpm-lock.yaml` after an exact
dependency declaration changes. It updates the lock without materializing packages; normal builds
continue to install the frozen state through `make prepare`.

```sh
make lock REGISTRY=http://host:port/
make verify REGISTRY=http://host:port/
make attest OUT=/absolute/release-output STORE=/absolute/local-release-store REGISTRY=http://host:port/
```

The login profile selects one installed `soksak-sdk` on `PATH`. `SDK_VERSION` is the single
required tooling version and Make checks the installed package and release documents. `STORE`
resolves exact unpublished runtime dependencies; no SDK or component source path is accepted.

`.node-version`, `frontend/package.json#engines.node`, and
`frontend/package.json#packageManager` are the exact toolchain owners. Make rejects a mismatched
Node architecture or a delegated pnpm executable before running the frozen install. Release Actions
run the same Make owner proof with `REGISTRY=https://registry.npmjs.org/`. The release train hands
Actions the exact spec package (URL and SHA-256) as the verification tool; it is not a build input of
the bundle.
