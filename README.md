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
          algorithm: round-robin

      - name: Run Tests
        run: sbt ${{ steps.shard.outputs.test-commands }}
```

### Auto-Shard-Matrix Example

Automatically determine the number of shards based on test file count. Use a two-job approach to auto-generate the matrix:

```yaml
name: Test

on: [push, pull_request]

jobs:
  determine-shards:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.shard.outputs.shard-matrix }}
    steps:
      - uses: actions/checkout@v4
      - name: Determine Shards
        id: shard
        uses: ./
        with:
          auto-shard-matrix: true

  test:
    needs: determine-shards
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: ${{ fromJson(needs.determine-shards.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v4
      - name: Setup Scala
        uses: olafurpg/setup-scala@v13
      - name: Shard Tests
        id: shard
        uses: ./
        with:
          max-shards: ${{ fromJson(needs.determine-shards.outputs.matrix) | length }}
          algorithm: round-robin
      - name: Run Tests
        run: sbt ${{ steps.shard.outputs.test-commands }}

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
    steps:
      - uses: actions/checkout@v4

      - name: Setup Scala
        uses: olafurpg/setup-scala@v13

      - name: Shard Tests
        id: shard
        uses: ./
        with:
          max-shards: 5
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

| Input               | Description                                                                                                             | Required | Default                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------- |
| `max-shards`        | Maximum number of shards to split tests into (ignored if `auto-shard-matrix` is true)                                   | No       | -                               |
| `auto-shard-matrix` | Automatically determine the number of shards based on test file count and output only the matrix (no file distribution) | No       | `false`                         |
| `algorithm`         | Sharding algorithm to use                                                                                               | No       | `round-robin`                   |
| `test-pattern`      | Comma-separated glob patterns for test files                                                                            | No       | `**/*Test.scala,**/*Spec.scala` |

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

## Auto-Shard-Matrix Mode

When `auto-shard-matrix: true` is set, the action automatically determines the optimal number of shards based on test file count and outputs **only** the shard matrix. No file distribution or algorithm is used - this mode is purely for calculating the shard count.

**Shard calculation:**

- **0 files**: 1 shard
- **1-5 files**: 1 shard
- **6-20 files**: `ceil(files / 5)` shards
- **21+ files**: `ceil(files / 10)` shards

The final shard count is capped at 10 shards maximum.

**Example:** If you have 15 test files, auto-shard-matrix will calculate 3 shards (15 / 5 = 3) and output `[1,2,3]` as the matrix.

**Important:** When using `auto-shard-matrix`, the `algorithm` input is **ignored**. The algorithm is only used when actually distributing files across shards (in the second job of a two-job workflow).

**Note:** GitHub Actions matrices are static and cannot be dynamically generated. You need a separate job to determine the matrix using `outputs.shard-matrix`, then use that in your test job's matrix strategy. In the test job, use `max-shards` (set to the matrix length) and `algorithm` to actually distribute files.

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
