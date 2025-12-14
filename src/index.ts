import * as core from '@actions/core';
import { glob } from 'glob';
import { readFileSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';

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

interface TestComplexity {
  file: string;
  score: number;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

function isValidTestFilePath(filePath: string, baseDir: string): boolean {
  try {
    const resolved = resolve(filePath);
    const baseResolved = resolve(baseDir);
    const relativePath = relative(baseResolved, resolved);
    // Prevent path traversal - ensure the resolved path is within baseDir
    return !relativePath.startsWith('..') && !relativePath.includes('..');
  } catch {
    return false;
  }
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
    const baseDir = process.cwd();
    const filePath = testFile.startsWith('/') ? testFile : join(baseDir, testFile);

    // Validate path to prevent path traversal
    if (!isValidTestFilePath(filePath, baseDir)) {
      core.warning(`Invalid file path detected (possible path traversal): ${testFile}`);
      return score;
    }

    // Check file size before reading to prevent DoS
    const stats = statSync(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      core.warning(
        `File too large for complexity analysis (${stats.size} bytes > ${MAX_FILE_SIZE}): ${testFile}`
      );
      return score;
    }

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

  const weights: TestComplexity[] = testFiles.map((file) => {
    const complexityScore = analyzeTestComplexity(file);
    return {
      file,
      score: complexityScore,
    };
  });

  weights.sort((a, b) => b.score - a.score);

  const shards: string[][] = Array.from({ length: actualShards }, () => []);
  const shardScores: number[] = Array.from({ length: actualShards }, () => 0);

  for (const test of weights) {
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

  core.info(`\nShard distribution (using complexity scores):`);
  shards.forEach((shardFiles, idx) => {
    const totalComplexity = shardFiles.reduce((sum, file) => {
      const complexityScore = analyzeTestComplexity(file);
      return sum + complexityScore;
    }, 0);
    core.info(
      `  Shard ${idx + 1}: ${shardFiles.length} file(s), complexity score: ${totalComplexity}`
    );
  });

  return shards;
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

export function calculateOptimalShards(testFileCount: number): number {
  if (testFileCount === 0) {
    return 1;
  }

  let baseShards: number;
  if (testFileCount <= 5) {
    baseShards = 1;
  } else if (testFileCount <= 20) {
    baseShards = Math.ceil(testFileCount / 5);
  } else {
    baseShards = Math.ceil(testFileCount / 10);
  }

  return Math.min(baseShards, 10);
}

export async function run(): Promise<void> {
  try {
    const autoShard = core.getBooleanInput('auto-shard');
    const maxShardsInput = core.getInput('max-shards');
    const algorithm = core.getInput('algorithm') || 'round-robin';
    const testPattern = core.getInput('test-pattern') || '**/*Test.scala,**/*Spec.scala';
    const testEnvVars = core.getInput('test-env-vars') || '';
    const currentShard = 1;

    core.info(`Discovering test files with pattern: ${testPattern}`);
    const testFiles = await discoverTestFiles(testPattern);
    core.info(`Found ${testFiles.length} test files`);

    let maxShards: number;
    if (autoShard) {
      maxShards = calculateOptimalShards(testFiles.length);
      core.info(
        `Auto-shard mode: calculated ${maxShards} shard(s) for ${testFiles.length} test files`
      );
    } else {
      maxShards = parseInt(maxShardsInput, 10);
      if (isNaN(maxShards) || maxShards < 1) {
        throw new Error('max-shards must be a positive integer');
      }
      // Prevent DoS by limiting max shards
      if (maxShards > 100) {
        throw new Error('max-shards cannot exceed 100');
      }
    }

    core.info(`Using ${algorithm} algorithm to distribute tests across ${maxShards} shard(s)`);

    if (testFiles.length === 0) {
      core.warning('No test files found. This may indicate a misconfigured test-pattern.');
      core.setOutput('total-shards', '1');
      core.setOutput('test-files', '');
      core.setOutput('test-commands', '');
      core.setOutput('shard-matrix', JSON.stringify([1]));
      return;
    }

    let shards: string[][];
    switch (algorithm) {
      case 'round-robin':
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
    const currentShardFiles = shards[shardIndex];

    core.info(`Total shards: ${totalShards}`);
    core.info(`\nShard distribution:`);
    shards.forEach((shardFiles, idx) => {
      core.info(`  Shard ${idx + 1}: ${shardFiles.length} test file(s)`);
      shardFiles.forEach((file) => {
        core.info(`    - ${file}`);
      });
    });

    core.info(`\nCurrent shard: ${currentShard} (0-indexed: ${shardIndex})`);
    core.info(`Test files in this shard: ${currentShardFiles.length}`);
    core.setOutput('total-shards', totalShards.toString());
    core.setOutput('test-files', currentShardFiles.join(','));
    core.setOutput(
      'shard-matrix',
      JSON.stringify(Array.from({ length: totalShards }, (_, i) => i + 1))
    );

    const testCommands = currentShardFiles.map(testFileToSbtCommand);

    let finalCommands = testCommands.join(' ');
    if (testEnvVars) {
      // Validate env var names to prevent injection
      const envVarNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
      const envVarList = testEnvVars
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .filter((name) => {
          if (!envVarNamePattern.test(name)) {
            core.warning(`Invalid environment variable name (skipped): ${name}`);
            return false;
          }
          return true;
        });

      const envVars = envVarList
        .map((varName) => {
          const value = process.env[varName];
          if (!value) {
            return null;
          }
          // Sanitize env var value to prevent command injection
          // Replace potentially dangerous characters with underscores
          const sanitizedValue = value.replace(/[;&|$`<>]/g, '_');
          return `${varName}=${sanitizedValue}`;
        })
        .filter((v): v is string => v !== null);

      if (envVars.length > 0) {
        finalCommands = `${envVars.join(' ')} ${finalCommands}`;
      }
    }

    core.setOutput('test-commands', finalCommands);

    core.exportVariable('SBT_TEST_FILES', currentShardFiles.join(','));
    core.exportVariable('SBT_TEST_COMMANDS', testCommands.join(' '));

    core.info(`\nCommand: sbt ${finalCommands}`);
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
