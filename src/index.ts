import * as core from '@actions/core';
import { glob } from 'glob';
import { readFileSync } from 'fs';
import { join } from 'path';

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

interface TestComplexity {
  file: string;
  score: number;
}

export function analyzeTestComplexity(testFile: string): number {
  let score = 1;

  const fileName = testFile.toLowerCase();

  if (
    fileName.includes('property') ||
    fileName.includes('proptest') ||
    fileName.includes('propertytest')
  ) {
    score += 3;
  }

  if (
    fileName.includes('integration') ||
    fileName.includes('container') ||
    fileName.includes('e2e') ||
    fileName.includes('endtoend')
  ) {
    score += 4;
  }

  if (fileName.includes('unit') || fileName.includes('unittest')) {
    score = Math.max(score - 1, 1);
  }

  try {
    const filePath = testFile.startsWith('/') ? testFile : join(process.cwd(), testFile);
    const content = readFileSync(filePath, 'utf-8').toLowerCase();

    if (content.includes('property') || content.includes('proptest')) {
      score += 2;
    }

    if (content.includes('container') || content.includes('@container')) {
      score += 3;
    }

    if (content.includes('integration') || content.includes('@integration')) {
      score += 2;
    }

    const testCount = (content.match(/\btest\s*\(/g) || []).length;
    const itCount = (content.match(/\bit\s*\(/g) || []).length;
    const describeCount = (content.match(/\bdescribe\s*\(/g) || []).length;

    const totalTests = testCount + itCount + describeCount;
    if (totalTests > 20) {
      score += 2;
    } else if (totalTests > 10) {
      score += 1;
    }

    const fileSize = content.length;
    if (fileSize > 5000) {
      score += 1;
    }
  } catch {
    core.warning(`Could not read test file for complexity analysis: ${testFile}`);
  }

  return score;
}

export function shardByComplexity(testFiles: string[], maxShards: number): string[][] {
  const totalFiles = testFiles.length;
  const actualShards = Math.min(maxShards, totalFiles);

  if (totalFiles === 0) {
    return [];
  }

  const complexities: TestComplexity[] = testFiles.map((file) => ({
    file,
    score: analyzeTestComplexity(file),
  }));

  complexities.sort((a, b) => b.score - a.score);

  const shards: string[][] = Array.from({ length: actualShards }, () => []);
  const shardScores: number[] = Array.from({ length: actualShards }, () => 0);

  for (const test of complexities) {
    let minScoreIndex = 0;
    let minScore = shardScores[0];

    for (let i = 1; i < actualShards; i++) {
      if (shardScores[i] < minScore) {
        minScore = shardScores[i];
        minScoreIndex = i;
      }
    }

    shards[minScoreIndex].push(test.file);
    shardScores[minScoreIndex] += test.score;
  }

  return shards;
}

export async function run(): Promise<void> {
  try {
    const maxShards = parseInt(core.getInput('max-shards'), 10);
    const algorithm = core.getInput('algorithm') || 'test-file-count';
    const testPattern = core.getInput('test-pattern') || '**/*Test.scala,**/*Spec.scala';
    const testEnvVars = core.getInput('test-env-vars') || '';

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
      case 'complexity':
        shards = shardByComplexity(testFiles, maxShards);
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

    let finalCommands = testCommands.join(' ');
    if (testEnvVars) {
      const envVarList = testEnvVars
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const envVars = envVarList
        .map((varName) => {
          const value = process.env[varName];
          return value ? `${varName}=${value}` : null;
        })
        .filter((v): v is string => v !== null);

      if (envVars.length > 0) {
        finalCommands = `${envVars.join(' ')} ${finalCommands}`;
      }
    }

    core.setOutput('test-commands', finalCommands);

    core.exportVariable('SBT_TEST_FILES', currentShardFiles.join(','));
    core.exportVariable('SBT_TEST_COMMANDS', testCommands.join(' '));

    if (currentShardFiles.length > 0) {
      core.info(`\nTest files in shard ${currentShard}:`);
      currentShardFiles.forEach((file) => core.info(`  - ${file}`));
      core.info(`\nCommand: sbt ${finalCommands}`);
    } else {
      core.warning(`No test files assigned to shard ${currentShard}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(errorMessage);
  }
}

/* c8 ignore start */
if (!process.env.VITEST) {
  void run();
}
/* c8 ignore end */
