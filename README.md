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
          shard-number: ${{ matrix.shard }}
          algorithm: round-robin

      - name: Run Tests
        run: sbt ${{ steps.shard.outputs.test-commands }}
```

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
    steps:
      - uses: actions/checkout@v4

      - name: Setup Scala
        uses: olafurpg/setup-scala@v13

      - name: Shard Tests
        id: shard
        uses: ./
        with:
          max-shards: 5
          shard-number: ${{ matrix.shard }}
          algorithm: round-robin
          test-pattern: '**/*Test.scala,**/*Spec.scala,**/*Suite.scala'

      - name: Run Tests
        if: steps.shard.outputs.test-files != ''
        env:
          JAVA_OPTS: -Xmx2g
        run: |
          echo "Running tests in shard ${{ matrix.shard }}/${{ steps.shard.outputs.total-shards }}"
          sbt ${{ steps.shard.outputs.test-commands }}
```

## Inputs

| Input          | Description                                                                                                       | Required | Default                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| `max-shards`   | Maximum number of shards to split tests into                                                                      | Yes      | -                                                             |
| `shard-number` | Current shard number (1-indexed). Should match `matrix.shard` when using matrix strategy. Defaults to 1.      | No       | `1`                                                           |
| `algorithm`    | Sharding algorithm to use                                                                                         | No       | `round-robin`                                                 |
| `test-pattern` | Comma-separated glob patterns for test files                                                                      | No       | `**/*Test.scala,**/*Spec.scala,**/Test*.scala,**/Spec*.scala` |
| `project-path` | Optional project directory path to filter test files. If provided, only test files within this directory will be included. | No       | -                                                             |

## Outputs

| Output          | Description                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `total-shards`  | Total number of shards created                                                                           |
| `test-files`    | Comma-separated list of test files to run in this shard                                                  |
| `test-commands` | SBT commands to run tests for this shard (e.g., `testOnly com.example.Test1 testOnly com.example.Test2`) |
| `shard-matrix`  | JSON array of shard numbers for use in GitHub Actions matrix (e.g., `[1,2,3]`)                           |

## Environment Variables

The action sets these environment variables for convenience:

- `SBT_TEST_FILES`: Comma-separated list of test files
- `SBT_TEST_COMMANDS`: SBT commands to run tests

**Note:** To set environment variables for your test execution, use the `env` key in your GitHub Actions workflow step, not this action.

## Sharding Algorithms

### `round-robin` (Default)

Distributes test files evenly across shards using round-robin distribution.

### `complexity`

Distributes tests based on estimated complexity to balance execution time across shards.

**Complexity factors:**

- Property tests: +3 points
- Integration/container/E2E tests: +4 points
- Unit tests: -1 point (minimum 1)
- Files with many tests (>20): +2 points, (>10): +1 point
- Large files (>5000 chars): +1 point

Tests are sorted by complexity (highest first) and distributed using a greedy bin-packing algorithm to balance total complexity across shards.

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
````
