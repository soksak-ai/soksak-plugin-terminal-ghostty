# soksak-plugin-terminal-ghostty

`soksak-kit-plugin-terminal`을 통해 ghostty 공급자 프레임으로 터미널 뷰를 렌더링하는 터미널
플러그인입니다.

공통 terminal kit가 view 등록, PTY 및 복원 수명 주기, 크기 변경 조정, 공개 상태, terminal
theme 해석, wait와 터미널 플러그인 계약의 모든 표준 명령을 소유합니다. 이 플러그인은
`soksak-sidecar-pty`와 `soksak-sidecar-terminal-ghostty` sidecar 의존성을 id와 version으로
선언하고 kit의 provider terminal plugin을 활성화합니다.

## 검증

이 패키지는 `@soksak/soksak-contract-plugin-terminal`과 `@soksak/soksak-kit-plugin-terminal`에
의존하므로, install을 수행하는 모든 `make` 호출은 make 명령줄의 `REGISTRY`를 요구합니다. 패키지가
`https://registry.npmjs.org`에 게시된 뒤에도 같습니다. 환경 변수로 전달된 값은 거부됩니다. Makefile은
`frontend/package.json`에서 이 요구를 읽고, 없으면
`REGISTRY required: this package depends on @soksak/...`으로 거부합니다.

빌드 입력의 정체성은 `REGISTRY`가 아니라 `pnpm-lock.yaml`의 integrity입니다. pnpm은 content-addressable
store에 없는 integrity의 패키지만 `REGISTRY`에서 받으므로, 같은 기계에서 같은 lockfile을 다시 install하면
store를 읽고 `REGISTRY`에 접속하지 않습니다.

```sh
make verify REGISTRY=http://host:port/
make attest OUT=/absolute/release-output STORE=/absolute/local-release-store REGISTRY=http://host:port/
```

로그인 프로필이 설치된 `soksak-sdk` 하나를 `PATH`에서 선택합니다. `SDK_VERSION`은 유일한 요구
tooling version이며 Make가 설치 package와 release document를 검사합니다. `STORE`는 정확한 미공개
runtime dependency를 해석하며 SDK나 component source path는 받지 않습니다.

정확한 toolchain 정본은 `.node-version`, `frontend/package.json#engines.node`,
`frontend/package.json#packageManager`입니다. Make는 frozen install 전에 Node architecture가
다르거나 pnpm executable이 다른 버전에 위임된 환경을 거부합니다. 릴리스 Actions도 release
train이 URL과 SHA-256으로 전달한 정확한 spec package를 통해 같은 Make owner proof를 실행합니다.
