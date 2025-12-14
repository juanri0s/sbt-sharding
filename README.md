# SBT Test Sharding

GitHub Action that automatically shards Scala tests for parallel execution in CI.

## Usage

### Basic Example

````yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4] # Number of shards
    steps:
      - uses: actions/checkout@v4

      - name: Setup Scala
        uses: olafurpg/setup-scala@v13

      - name: Shard Tests
        id: shard
        uses: ./
        with:
          max-shards: 4
          algorithm: test-file-count
          shard-number: ${{ matrix.shard }}

      - name: Run Tests
        run: sbt ${{ steps.shard.outputs.test-commands }}

### Environment Variables

Include environment variables in the test command:

```yaml
- name: Shard Tests
  id: shard
  uses: ./
  with:
    max-shards: 4
    test-env-vars: 'JAVA_OPTS,SCALA_VERSION'

- name: Run Tests
  env:
    JAVA_OPTS: -Xmx2g
    SCALA_VERSION: 2.13
  run: sbt ${{ steps.shard.outputs.test-commands }}
```

The `test-commands` output will include the environment variables: `JAVA_OPTS=-Xmx2g SCALA_VERSION=2.13 testOnly com.example.Test1`

````

### Advanced Example

```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4, 5]
    env:
      GITHUB_SHARD: ${{ matrix.shard }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Scala
        uses: olafurpg/setup-scala@v13

      - name: Shard Tests
        id: shard
        uses: ./
        with:
          max-shards: 5
          algorithm: test-file-count
          test-pattern: '**/*Test.scala,**/*Spec.scala,**/*Suite.scala'

      - name: Run Tests
        if: steps.shard.outputs.test-files != ''
        env:
          JAVA_OPTS: -Xmx2g
        run: |
          echo "Running tests in shard ${{ steps.shard.outputs.shard-number }}/${{ steps.shard.outputs.total-shards }}"
          sbt ${{ steps.shard.outputs.test-commands }}
````

## Inputs

| Input                   | Description                                                                                     | Required | Default                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- | -------- | ------------------------------- |
| `max-shards`            | Maximum number of shards to split tests into                                                    | Yes      | -                               |
| `algorithm`             | Sharding algorithm to use                                                                       | No       | `test-file-count`               |
| `test-pattern`          | Comma-separated glob patterns for test files                                                    | No       | `**/*Test.scala,**/*Spec.scala` |
| `shard-number`          | Current shard number (1-indexed). If not provided, uses `GITHUB_SHARD` env var or defaults to 1 | No       | `1` or `GITHUB_SHARD` env var   |
| `test-env-vars` | Comma-separated list of environment variable names to include in test command output | No | - |

## Outputs

| Output          | Description                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `shard-number`  | The current shard number (1-indexed)                                                                     |
| `total-shards`  | Total number of shards created                                                                           |
| `test-files`    | Comma-separated list of test files to run in this shard                                                  |
| `test-commands` | SBT commands to run tests for this shard (e.g., `testOnly com.example.Test1 testOnly com.example.Test2`) |

## Environment Variables

The action also sets these environment variables for convenience:

- `SBT_TEST_FILES`: Comma-separated list of test files
- `SBT_TEST_COMMANDS`: SBT commands to run tests

## Sharding Algorithms

### `test-file-count` (Default)

Distributes test files evenly across shards using round-robin.

## Requirements

- Node.js 24+ (automatically provided by GitHub Actions)
- pnpm 10+ (managed via corepack)
- SBT project structure with test files in `src/test/scala/` or similar

## Building

Before using this action (or when developing), you need to build it:

```bash
corepack enable
pnpm install
pnpm run build
```

When using this action from the same repository (`uses: ./`), build it first or commit the `dist/` directory.

## License

MIT
