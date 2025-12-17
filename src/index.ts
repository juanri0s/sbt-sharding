import * as core from '@actions/core';
import { glob } from 'glob';
import { readFileSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';

function isValidPath(path: string, baseDir: string): boolean {
  try {
    const resolved = resolve(baseDir, path);
    const baseResolved = resolve(baseDir);
    const relativePath = relative(baseResolved, resolved);
    return !relativePath.startsWith('..') && !relativePath.includes('..');
  } catch {
    return false;
  }
}

export async function discoverTestFiles(
  testPattern: string,
  projectPath?: string
): Promise<string[]> {
  const patterns = testPattern.split(',').map((p) => p.trim());
  const testFiles = new Set<string>();
  const cwd = process.cwd();

  if (projectPath && !isValidPath(projectPath, cwd)) {
    return [];
  }

  for (const pattern of patterns) {
    const scopedPattern = projectPath ? join(projectPath, pattern) : pattern;
    const files = await glob(scopedPattern, {
      ignore: ['**/node_modules/**', '**/target/**', '**/.git/**'],
      absolute: false,
      cwd,
    });
    files.forEach((file) => {
      if (!isValidPath(file, cwd)) {
        return;
      }
      if (projectPath) {
        const filePath = resolve(cwd, file);
        const projectResolved = resolve(cwd, projectPath);
        const relativePath = relative(projectResolved, filePath);
        if (!relativePath.startsWith('..') && !relativePath.includes('..')) {
          testFiles.add(file);
        }
      } else {
        testFiles.add(file);
      }
    });
  }

  return Array.from(testFiles).sort();
}

function isValidClassName(className: string): boolean {
  return /^[a-zA-Z0-9_.$]+$/.test(className) && className.length <= 512;
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

  if (!testClass || !isValidClassName(testClass)) {
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

    if (!isValidTestFilePath(filePath, baseDir)) {
      core.warning(`Invalid file path detected (possible path traversal): ${testFile}`);
      return score;
    }

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
  } catch {}

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

export async function run(): Promise<void> {
  try {
    const maxShardsInput = core.getInput('max-shards');
    const shardNumberInput = core.getInput('shard-number') || '1';
    const algorithm = core.getInput('algorithm') || 'round-robin';
    const testPattern =
      core.getInput('test-pattern') ||
      '**/*Test.scala,**/*Spec.scala,**/Test*.scala,**/Spec*.scala';
    const projectPathInput = core.getInput('project-path') || undefined;
    const cwd = process.cwd();

    if (projectPathInput) {
      if (projectPathInput.length > 512) {
        throw new Error('Project-path too long');
      }
      if (!isValidPath(projectPathInput, cwd)) {
        throw new Error('Invalid project-path');
      }
    }
    const projectPath = projectPathInput;

    const currentShard = parseInt(shardNumberInput, 10);
    if (isNaN(currentShard) || currentShard < 1) {
      throw new Error('shard-number must be a positive integer');
    }

    if (projectPath) {
      core.info(`Discovering test files with pattern: ${testPattern} in project: ${projectPath}`);
    } else {
      core.info(`Discovering test files with pattern: ${testPattern}`);
    }
    const testFiles = await discoverTestFiles(testPattern, projectPath);
    core.info(`Found ${testFiles.length} test files`);

    if (!maxShardsInput) {
      throw new Error('max-shards is required');
    }

    const maxShards = parseInt(maxShardsInput, 10);
    if (isNaN(maxShards) || maxShards < 1) {
      throw new Error('max-shards must be a positive integer');
    }
    if (maxShards > 100) {
      throw new Error('max-shards cannot exceed 100');
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
    const currentShardFiles = shards[shardIndex] || [];

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
    if (currentShardFiles.length === 0) {
      core.warning(`Shard ${currentShard} has no test files assigned`);
    }
    core.setOutput('total-shards', totalShards.toString());
    core.setOutput('test-files', currentShardFiles.join(','));
    core.setOutput(
      'shard-matrix',
      JSON.stringify(Array.from({ length: totalShards }, (_, i) => i + 1))
    );

    const testCommands = currentShardFiles
      .map(testFileToSbtCommand)
      .filter((cmd) => cmd.length > 0);
    const finalCommands = testCommands.join(' ');

    core.setOutput('test-commands', finalCommands);

    if (currentShardFiles.length > 0) {
      core.exportVariable('SBT_TEST_FILES', currentShardFiles.join(','));
      core.exportVariable('SBT_TEST_COMMANDS', testCommands.join(' '));
    } else {
      core.exportVariable('SBT_TEST_FILES', '');
      core.exportVariable('SBT_TEST_COMMANDS', '');
    }

    if (finalCommands) {
      core.info(`\nCommand: sbt ${finalCommands}`);
    } else {
      core.warning('No valid test commands generated for this shard');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(errorMessage);
  }
}

// This code only runs when executed as a GitHub Action, not during tests
/* v8 ignore next 3 -- @preserve */
if (!process.env.VITEST) {
  void run();
}
