# SBT Test Sharding

A GitHub Action that automatically shards Scala tests for parallel execution in CI pipelines. This action discovers test files across all modules in your SBT project and distributes them evenly across shards.

## Features

- 🔍 **Automatic Test Discovery**: Finds test files across all modules without manual configuration
- 📊 **Smart Sharding**: Distributes tests evenly across shards for optimal parallelization
- 🎯 **Multiple Algorithms**: Extensible architecture supporting different sharding strategies
- 🚀 **Zero Configuration**: Works out of the box with standard SBT project structures

## Usage

### Basic Example

```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4]  # Number of shards
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
        run: |
          echo "Running tests in shard ${{ steps.shard.outputs.shard-number }}/${{ steps.shard.outputs.total-shards }}"
          sbt ${{ steps.shard.outputs.test-commands }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `max-shards` | Maximum number of shards to split tests into | Yes | - |
| `algorithm` | Sharding algorithm to use | No | `test-file-count` |
| `test-pattern` | Comma-separated glob patterns for test files | No | `**/*Test.scala,**/*Spec.scala` |
| `shard-number` | Current shard number (1-indexed). If not provided, uses `GITHUB_SHARD` env var or defaults to 1 | No | `1` or `GITHUB_SHARD` env var |

## Outputs

| Output | Description |
|--------|-------------|
| `shard-number` | The current shard number (1-indexed) |
| `total-shards` | Total number of shards created |
| `test-files` | Comma-separated list of test files to run in this shard |
| `test-commands` | SBT commands to run tests for this shard (e.g., `testOnly com.example.Test1 testOnly com.example.Test2`) |

## Environment Variables

The action also sets these environment variables for convenience:

- `SBT_TEST_FILES`: Comma-separated list of test files
- `SBT_TEST_COMMANDS`: SBT commands to run tests

## Sharding Algorithms

### `test-file-count` (Default)

Distributes test files evenly across shards based on file count. This is a simple algorithm suitable for most projects where test files have similar execution times.

**How it works:**
- Discovers all test files matching the pattern
- Distributes them evenly across shards using round-robin
- Ensures no shard is empty if there are fewer files than shards

## How It Works

1. **Discovery**: The action scans your repository for test files matching the specified pattern(s)
2. **Sharding**: Test files are distributed across shards using the selected algorithm
3. **Output**: For each shard, the action outputs the test files and SBT commands to run

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

This creates the `dist/` directory with the bundled action code. **Important**: When using this action from the same repository (`uses: ./`), make sure to build it first or commit the `dist/` directory.

## Development

### Building

```bash
corepack enable
pnpm install
pnpm run build
```

This will compile the action and create the `dist/` directory with bundled dependencies.

### Testing Locally

You can test the action locally using [act](https://github.com/nektos/act) or by running the Node.js script directly:

```bash
node src/index.js
```

## License

MIT
