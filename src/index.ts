import * as core from '@actions/core';
import { glob } from 'glob';

export async function discoverTestFiles(testPattern: string): Promise<string[]> {
  const patterns = testPattern.split(',').map((p) => p.trim());
  const testFiles = new Set<string>();

  for (const pattern of patterns) {
    const files = await glob(pattern, {
      ignore: ['**/node_modules/**', '**/target/**', '**/.git/**'],
      absolute: false,
    });
    files.forEach((file) => testFiles.add(file));
  }

  return Array.from(testFiles).sort();
}

export function testFileToSbtCommand(testFile: string): string {
  const testDirPatterns = [/src\/test\/scala\//, /src\/test\//, /test\/scala\//, /test\//];

  let relativePath = testFile;
  let foundPattern = false;

  for (const pattern of testDirPatterns) {
    const match = testFile.match(pattern);
    if (match) {
      relativePath = testFile.substring(testFile.indexOf(match[0]) + match[0].length);
      foundPattern = true;
      break;
    }
  }

  if (!foundPattern) {
    core.warning(`Could not convert test file path to class name: ${testFile}`);
    return '';
  }

  relativePath = relativePath.replace(/\.scala$/, '');
  const testClass = relativePath.replace(/\//g, '.');

  if (!testClass) {
    core.warning(`Could not convert test file path to class name: ${testFile}`);
    return '';
  }

  return `testOnly ${testClass}`;
}

export function shardByTestFileCount(testFiles: string[], maxShards: number): string[][] {
  const totalFiles = testFiles.length;
  const actualShards = Math.min(maxShards, totalFiles);

  if (totalFiles === 0) {
    return [];
  }

  const shards: string[][] = Array.from({ length: actualShards }, () => []);

  testFiles.forEach((file, index) => {
    const shardIndex = index % actualShards;
    shards[shardIndex].push(file);
  });

  return shards;
}

export async function run(): Promise<void> {
  try {
    const maxShards = parseInt(core.getInput('max-shards'), 10);
    const algorithm = core.getInput('algorithm') || 'test-file-count';
    const testPattern = core.getInput('test-pattern') || '**/*Test.scala,**/*Spec.scala';

    const shardInput = core.getInput('shard-number');
    const shardEnv = process.env.GITHUB_SHARD;
    const currentShard = parseInt(shardInput || shardEnv || '1', 10);

    if (isNaN(maxShards) || maxShards < 1) {
      throw new Error('max-shards must be a positive integer');
    }

    core.info(`Discovering test files with pattern: ${testPattern}`);
    const testFiles = await discoverTestFiles(testPattern);
    core.info(`Found ${testFiles.length} test files`);

    if (testFiles.length === 0) {
      core.warning('No test files found. This may indicate a misconfigured test-pattern.');
      core.setOutput('shard-number', '1');
      core.setOutput('total-shards', '1');
      core.setOutput('test-files', '');
      core.setOutput('test-commands', '');
      return;
    }

    let shards: string[][];
    switch (algorithm) {
      case 'test-file-count':
        shards = shardByTestFileCount(testFiles, maxShards);
        break;
      default:
        throw new Error(`Unknown algorithm: ${algorithm}`);
    }

    const totalShards = shards.length;
    const shardIndex = Math.min(currentShard - 1, totalShards - 1);
    const currentShardFiles = shards[shardIndex] || [];

    core.info(`Total shards: ${totalShards}`);
    core.info(`Current shard: ${currentShard} (0-indexed: ${shardIndex})`);
    core.info(`Test files in this shard: ${currentShardFiles.length}`);

    core.setOutput('shard-number', currentShard.toString());
    core.setOutput('total-shards', totalShards.toString());
    core.setOutput('test-files', currentShardFiles.join(','));

    const testCommands = currentShardFiles.map(testFileToSbtCommand);
    core.setOutput('test-commands', testCommands.join(' '));

    core.exportVariable('SBT_TEST_FILES', currentShardFiles.join(','));
    core.exportVariable('SBT_TEST_COMMANDS', testCommands.join(' '));

    if (currentShardFiles.length > 0) {
      core.info(`\nTest files in shard ${currentShard}:`);
      currentShardFiles.forEach((file) => core.info(`  - ${file}`));
      core.info(`\nSBT command: sbt ${testCommands.join(' ')}`);
    } else {
      core.warning(`No test files assigned to shard ${currentShard}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(errorMessage);
  }
}

// Entry point only runs in GitHub Actions, not in tests
/* c8 ignore start */
if (!process.env.VITEST) {
  void run();
}
/* c8 ignore end */
