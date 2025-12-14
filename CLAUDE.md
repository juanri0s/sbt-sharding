# Basic Commands

## Setup

```bash
pnpm --dir /path/to/sbt-test-sharding install
```

## Development

```bash
# Build the action
pnpm --dir /path/to/sbt-test-sharding build

# Run tests
pnpm --dir /path/to/sbt-test-sharding test

# Run tests in watch mode
pnpm --dir /path/to/sbt-test-sharding test:watch

# Run tests with coverage
pnpm --dir /path/to/sbt-test-sharding test:coverage
```

## Code Quality

```bash
# Lint code
pnpm --dir /path/to/sbt-test-sharding lint

# Fix linting issues
pnpm --dir /path/to/sbt-test-sharding lint:fix

# Format code
pnpm --dir /path/to/sbt-test-sharding format

# Check formatting
pnpm --dir /path/to/sbt-test-sharding format:check
```

## Testing

- Tests are in `src/index.test.ts`
- Test fixtures are in `test-fixtures/`
- Coverage threshold: 100% lines/functions/statements, 98% branches (always strive for 100%)
