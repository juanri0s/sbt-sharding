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
```

### Auto-Shard Example

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
          auto-shard: true
          algorithm: test-file-count
          shard-number: 1

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
          auto-shard: true
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
```

## Inputs

| Input                  | Description                                                                                                                                                                    | Required | Default                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------- |
| `max-shards`           | Maximum number of shards to split tests into (ignored if `auto-shard` is true)                                                                                                 | No       | -                               |
| `auto-shard`           | Automatically determine the number of shards based on test file count                                                                                                          | No       | `false`                         |
| `algorithm`            | Sharding algorithm to use                                                                                                                                                      | No       | `test-file-count`               |
| `test-pattern`         | Comma-separated glob patterns for test files                                                                                                                                   | No       | `**/*Test.scala,**/*Spec.scala` |
| `shard-number`         | Current shard number (1-indexed). If not provided, uses `GITHUB_SHARD` env var or defaults to 1                                                                                | No       | `1` or `GITHUB_SHARD` env var   |
| `test-env-vars`        | Comma-separated list of environment variable names to include in test command output                                                                                           | No       | -                               |
| `use-historical-data`  | Use historical execution time data to optimize shard distribution                                                                                                              | No       | `false`                         |
| `historical-data-path` | Path to JSON file containing historical test execution times (e.g., `.github/test-times.json`). Execution times are automatically collected from the test step via GitHub API. | No       | -                               |

## Outputs

| Output          | Description                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `shard-number`  | The current shard number (1-indexed)                                                                     |
| `total-shards`  | Total number of shards created                                                                           |
| `test-files`    | Comma-separated list of test files to run in this shard                                                  |
| `test-commands` | SBT commands to run tests for this shard (e.g., `testOnly com.example.Test1 testOnly com.example.Test2`) |
| `shard-matrix`  | JSON array of shard numbers for use in GitHub Actions matrix (e.g., `[1,2,3]`)                           |

## Environment Variables

The action also sets these environment variables for convenience:

- `SBT_TEST_FILES`: Comma-separated list of test files
- `SBT_TEST_COMMANDS`: SBT commands to run tests

## Sharding Algorithms

### `test-file-count` (Default)

Distributes test files evenly across shards using round-robin.

### `complexity`

Distributes tests based on estimated complexity to balance execution time across shards.

**Complexity factors:**

- Property tests: +3 points
- Integration/container/E2E tests: +4 points
- Unit tests: -1 point (minimum 1)
- Files with many tests (>20): +2 points, (>10): +1 point
- Large files (>5000 chars): +1 point

Tests are sorted by complexity (highest first) and distributed using a bin-packing algorithm to balance total complexity across shards.

### Historical Data (Memory-Based Improvement)

Automatically learns from past test runs to optimize shard distribution. Execution times are collected and persisted using GitHub Actions artifacts, improving sharding accuracy over time.

**Setup with Artifacts (Recommended):**

Execution times are automatically collected from the test step via GitHub API. No manual configuration needed:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4

      # Download historical data from previous runs
      - name: Download historical data
        uses: actions/download-artifact@v4
        with:
          name: test-times
          path: .github
        continue-on-error: true

      # Shard tests using historical data
      - name: Shard Tests
        id: shard
        uses: ./
        with:
          max-shards: 4
          algorithm: complexity
          use-historical-data: true
          historical-data-path: '.github/test-times.json'
          shard-number: ${{ matrix.shard }}

      # Run tests and track execution time
      - name: Run Tests
        id: test-run
        run: |
          START_TIME=$(date +%s)
          sbt ${{ steps.shard.outputs.test-commands }}
          END_TIME=$(date +%s)
          EXECUTION_TIME=$((END_TIME - START_TIME))
          echo "execution_time=$EXECUTION_TIME" >> $GITHUB_OUTPUT

      # Save historical data with tracked execution time
      - name: Save historical data
        uses: ./
        with:
          use-historical-data: true
          historical-data-path: '.github/test-times.json'
          execution-time: ${{ steps.test-run.outputs.execution_time }}
          algorithm: complexity
          test-pattern: '**/*Test.scala,**/*Spec.scala'
          shard-number: ${{ matrix.shard }}

      # Upload shard-specific historical data
      - name: Upload shard historical data
        uses: actions/upload-artifact@v4
        with:
          name: test-times-shard-${{ matrix.shard }}
          path: .github/test-times.json
          retention-days: 90

  merge-historical-data:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4

      # Download all shard artifacts and merge them
      - name: Download and merge shard artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: test-times-shard-*
          merge-multiple: true
          path: .github

      # Upload merged historical data
      - name: Upload merged historical data
        uses: actions/upload-artifact@v4
        with:
          name: test-times
          path: .github/test-times.json
          retention-days: 90
```

**How it works:**

- **First run**: No artifact exists, uses complexity/round-robin algorithm
- **Track execution time**: Use `date` command or `time` utility to track how long tests take
- **Save per shard**: Each shard saves its execution time to the historical data file
- **Merge shards**: After all shards complete, merge all shard-specific files into one artifact
- **Data is saved**: Execution times are averaged with existing data for the same test files
- **Next run**: Downloads merged artifact, loads historical data, and uses it to optimize shard distribution
- **Continuous improvement**: Each run updates the data automatically, improving accuracy over time
- **Balanced shards**: Over time, shards become balanced as slower tests are identified and distributed evenly

**Data format:**

```json
{
  "src/test/scala/com/example/Test1.scala": 45.2,
  "src/test/scala/com/example/Test2.scala": 12.8,
  "src/test/scala/com/example/IntegrationTest.scala": 120.5
}
```

Times are in seconds. The algorithm balances total execution time across shards. Execution times are averaged when multiple runs exist for the same test file.

**Alternative: Commit to Repository**

You can also commit the historical data file to your repository instead of using artifacts:

```yaml
- name: Run Tests
  id: test-run
  run: |
    START_TIME=$(date +%s)
    sbt ${{ steps.shard.outputs.test-commands }}
    END_TIME=$(date +%s)
    EXECUTION_TIME=$((END_TIME - START_TIME))
    echo "execution_time=$EXECUTION_TIME" >> $GITHUB_OUTPUT

- name: Update historical data
  uses: ./
  with:
    use-historical-data: true
    historical-data-path: '.github/test-times.json'
    execution-time: ${{ steps.test-run.outputs.execution_time }}
    algorithm: complexity
    test-pattern: '**/*Test.scala,**/*Spec.scala'
    shard-number: ${{ matrix.shard }}

- name: Commit updated historical data
  run: |
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add .github/test-times.json
    git commit -m "Update test execution times" || exit 0
    git push
```

## Auto-Shard Mode

When `auto-shard: true` is set, the action automatically determines the optimal number of shards based on:

1. **Test file count** (base calculation):
   - **0 files**: 1 shard
   - **1-5 files**: 1 shard
   - **6-20 files**: `ceil(files / 5)` shards
   - **21+ files**: `ceil(files / 10)` shards

2. **Historical execution times** (if available):
   - If estimated total execution time > 600s: adds shards to target ~300s per shard
   - If estimated total execution time > 300s: adds shards to target ~200s per shard
   - This ensures slow test suites get more shards for better parallelization

The final shard count is capped at 10 shards maximum.

**Example:** If you have 15 test files (base: 3 shards) but historical data shows an estimated total time of 800s, auto-shard will increase to ~3 shards (800s / 300s ≈ 3) to balance execution time.

This eliminates the need to manually specify `max-shards` and adjust it as your test suite grows or slows down. The action will calculate the appropriate number of shards and output it in the `total-shards` output.

**Note:** GitHub Actions matrices are static and cannot be dynamically generated. You need a separate job to determine the matrix using `outputs.shard-matrix`, then use that in your test job's matrix strategy.

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
