# Basic Commands

## Setup

```bash
pnpm --dir /path/to/sbt-sharding install
```

## Development

```bash
# Build the action
pnpm --dir /path/to/sbt-sharding build

# Run tests
pnpm --dir /path/to/sbt-sharding test

# Run tests in watch mode
pnpm --dir /path/to/sbt-sharding test:watch

# Run tests with coverage
pnpm --dir /path/to/sbt-sharding test:coverage
```

## Code Quality

```bash
# Lint code
pnpm --dir /path/to/sbt-sharding lint

# Fix linting issues
pnpm --dir /path/to/sbt-sharding lint:fix

# Format code
pnpm --dir /path/to/sbt-sharding format

# Check formatting
pnpm --dir /path/to/sbt-sharding format:check
```

## Testing

- Tests are in `src/index.test.ts`
- Test fixtures are in `test-fixtures/`
- Coverage threshold: 100% lines/functions/statements, 98% branches (always strive for 100%)
