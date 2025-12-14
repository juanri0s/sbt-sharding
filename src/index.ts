import * as core from '@actions/core';
import { glob } from 'glob';
import { readFileSync, existsSync } from 'fs';
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

interface TestComplexity {
  file: string;
  score: number;
}

interface HistoricalData {
  [testFile: string]: number;
}

export function loadHistoricalData(dataPath: string): HistoricalData | null {
  if (!dataPath) {
    return null;
  }

  try {
    const fullPath = dataPath.startsWith('/') ? dataPath : join(process.cwd(), dataPath);
    if (!existsSync(fullPath)) {
      core.info(`Historical data file not found: ${dataPath}`);
      return null;
    }

    const content = readFileSync(fullPath, 'utf-8');
    const data = JSON.parse(content) as HistoricalData;

    const validEntries = Object.entries(data).filter(
      ([_, time]) => typeof time === 'number' && time > 0
    );
    core.info(`Loaded historical data for ${validEntries.length} test files`);
    return Object.fromEntries(validEntries);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to load historical data from ${dataPath}: ${errorMessage}`);
    return null;
  }
}

export function getTestWeight(
  testFile: string,
  historicalData: HistoricalData | null,
  complexityScore: number
): number {
  if (historicalData && historicalData[testFile]) {
    return historicalData[testFile];
  }
  return complexityScore;
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

export function shardByComplexity(
  testFiles: string[],
  maxShards: number,
  historicalData: HistoricalData | null = null
): string[][] {
  const totalFiles = testFiles.length;
  const actualShards = Math.min(maxShards, totalFiles);

  if (totalFiles === 0) {
    return [];
  }

  if (historicalData && Object.keys(historicalData).length > 0) {
    const filesWithData = testFiles.filter((file) => historicalData[file]);
    const filesWithoutData = testFiles.filter((file) => !historicalData[file]);

    if (filesWithData.length > 0) {
      core.info(`\nHistorical execution times:`);
      filesWithData.forEach((file) => {
        core.info(`  ${file}: ${historicalData[file]}s`);
      });
    }

    if (filesWithoutData.length > 0) {
      core.info(
        `\n${filesWithoutData.length} test file(s) have no historical data, using complexity scores for those`
      );
    }
  }

  const weights: TestComplexity[] = testFiles.map((file) => {
    const complexityScore = analyzeTestComplexity(file);
    const weight = getTestWeight(file, historicalData, complexityScore);
    return {
      file,
      score: weight,
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

  if (historicalData && Object.keys(historicalData).length > 0) {
    const filesWithData = testFiles.filter((file) => historicalData[file]);
    const hasAnyData = filesWithData.length > 0;

    if (hasAnyData) {
      core.info(`\nShard distribution (balanced by execution time):`);
      shards.forEach((shardFiles, idx) => {
        let totalTime = 0;
        for (const file of shardFiles) {
          const time = historicalData![file];
          if (time !== undefined) {
            totalTime += time;
          } else {
            totalTime += 0;
          }
        }
        core.info(
          `  Shard ${idx + 1}: ${shardFiles.length} file(s), ~${totalTime.toFixed(1)}s total`
        );
      });
    } else {
      core.info(`\nShard distribution (using complexity scores - no historical data available):`);
      shards.forEach((shardFiles, idx) => {
        const totalComplexity = shardFiles.reduce((sum, file) => {
          const complexityScore = analyzeTestComplexity(file);
          return sum + complexityScore;
        }, 0);
        core.info(
          `  Shard ${idx + 1}: ${shardFiles.length} file(s), complexity score: ${totalComplexity}`
        );
      });
    }
  }

  return shards;
}

export function shardByTestFileCount(
  testFiles: string[],
  maxShards: number,
  historicalData: HistoricalData | null = null
): string[][] {
  const totalFiles = testFiles.length;
  const actualShards = Math.min(maxShards, totalFiles);

  if (totalFiles === 0) {
    return [];
  }

  if (historicalData && Object.keys(historicalData).length > 0) {
    const filesWithData = testFiles.filter((file) => historicalData[file]);
    const filesWithoutData = testFiles.filter((file) => !historicalData[file]);
    const hasAnyData = filesWithData.length > 0;

    if (filesWithData.length > 0) {
      core.info(`\nHistorical execution times:`);
      filesWithData.forEach((file) => {
        core.info(`  ${file}: ${historicalData[file]}s`);
      });
    }

    if (filesWithoutData.length > 0) {
      core.info(
        `\n${filesWithoutData.length} test file(s) have no historical data, using default distribution for those`
      );
    }

    const weights: TestComplexity[] = testFiles.map((file) => ({
      file,
      score: historicalData[file] || 1,
    }));

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

    if (hasAnyData) {
      core.info(`\nShard distribution (balanced by execution time):`);
      shards.forEach((shardFiles, idx) => {
        const totalTime = shardFiles.reduce((sum, file) => sum + (historicalData[file] || 0), 0);
        core.info(
          `  Shard ${idx + 1}: ${shardFiles.length} file(s), ~${totalTime.toFixed(1)}s total`
        );
      });
    } else {
      core.info(
        `\nShard distribution (using execution time weights - no historical data available):`
      );
      shards.forEach((shardFiles, idx) => {
        const totalWeight = shardFiles.reduce((sum, file) => sum + (historicalData[file] || 1), 0);
        core.info(`  Shard ${idx + 1}: ${shardFiles.length} file(s), total weight: ${totalWeight}`);
      });
    }

    return shards;
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
  if (testFileCount <= 5) {
    return 1;
  }
  if (testFileCount <= 20) {
    return Math.ceil(testFileCount / 5);
  }
  return Math.min(Math.ceil(testFileCount / 10), 10);
}

export async function run(): Promise<void> {
  try {
    const autoShard = core.getBooleanInput('auto-shard');
    const maxShardsInput = core.getInput('max-shards');
    const algorithm = core.getInput('algorithm') || 'test-file-count';
    const testPattern = core.getInput('test-pattern') || '**/*Test.scala,**/*Spec.scala';
    const testEnvVars = core.getInput('test-env-vars') || '';
    const useHistoricalData = core.getBooleanInput('use-historical-data');
    const historicalDataPath = core.getInput('historical-data-path') || '';

    const shardInput = core.getInput('shard-number');
    const shardEnv = process.env.GITHUB_SHARD;
    const currentShard = parseInt(shardInput || shardEnv || '1', 10);

    let historicalData: HistoricalData | null = null;
    if (useHistoricalData && historicalDataPath) {
      historicalData = loadHistoricalData(historicalDataPath);
      if (historicalData) {
        const dataCount = Object.keys(historicalData).length;
        core.info(
          `Using historical execution time data for ${dataCount} test file(s) to optimize shard distribution`
        );
      } else {
        core.info(
          `No historical data available, using ${algorithm} algorithm with default distribution`
        );
      }
    }

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
    }

    if (!historicalData || Object.keys(historicalData).length === 0) {
      core.info(`Using ${algorithm} algorithm to distribute tests across ${maxShards} shard(s)`);
    } else {
      core.info(`Distributing tests across ${maxShards} shard(s) using historical execution times`);
    }

    if (testFiles.length === 0) {
      core.warning('No test files found. This may indicate a misconfigured test-pattern.');
      core.setOutput('shard-number', '1');
      core.setOutput('total-shards', '1');
      core.setOutput('test-files', '');
      core.setOutput('test-commands', '');
      core.setOutput('shard-matrix', JSON.stringify([1]));
      return;
    }

    let shards: string[][];
    switch (algorithm) {
      case 'test-file-count':
        shards = shardByTestFileCount(testFiles, maxShards, historicalData);
        break;
      case 'complexity':
        shards = shardByComplexity(testFiles, maxShards, historicalData);
        break;
      default:
        throw new Error(`Unknown algorithm: ${algorithm}`);
    }

    const totalShards = shards.length;
    const shardIndex = Math.min(currentShard - 1, totalShards - 1);
    const currentShardFiles = shards[shardIndex] || [];

    core.info(`Total shards: ${totalShards}`);

    if (!historicalData || Object.keys(historicalData).length === 0) {
      core.info(`\nShard distribution:`);
      shards.forEach((shardFiles, idx) => {
        core.info(`  Shard ${idx + 1}: ${shardFiles.length} test file(s)`);
        shardFiles.forEach((file) => {
          core.info(`    - ${file}`);
        });
      });
    } else {
      const filesWithData = testFiles.filter((file) => historicalData![file]);
      const hasAnyData = filesWithData.length > 0;

      core.info(`\nShard distribution:`);
      shards.forEach((shardFiles, idx) => {
        if (hasAnyData) {
          const totalTime = shardFiles.reduce((sum, file) => sum + (historicalData![file] || 0), 0);
          core.info(
            `  Shard ${idx + 1}: ${shardFiles.length} test file(s), ~${totalTime.toFixed(1)}s total`
          );
          shardFiles.forEach((file) => {
            const time = historicalData![file];
            if (time) {
              core.info(`    - ${file} (${time}s)`);
            } else {
              core.info(`    - ${file} (no historical data, weight: 1)`);
            }
          });
        } else {
          const totalWeight = shardFiles.reduce(
            (sum, file) => sum + (historicalData![file] || 1),
            0
          );
          core.info(
            `  Shard ${idx + 1}: ${shardFiles.length} test file(s), total weight: ${totalWeight}`
          );
          shardFiles.forEach((file) => {
            core.info(`    - ${file} (no historical data, weight: 1)`);
          });
        }
      });
    }

    core.info(`\nCurrent shard: ${currentShard} (0-indexed: ${shardIndex})`);
    core.info(`Test files in this shard: ${currentShardFiles.length}`);

    core.setOutput('shard-number', currentShard.toString());
    core.setOutput('total-shards', totalShards.toString());
    core.setOutput('test-files', currentShardFiles.join(','));
    core.setOutput(
      'shard-matrix',
      JSON.stringify(Array.from({ length: totalShards }, (_, i) => i + 1))
    );

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

    if (useHistoricalData) {
      core.setOutput('shard-execution-time-key', `shard-${currentShard}-execution-time`);
      core.info(
        `\nTo collect execution time for this shard, set output 'shard-${currentShard}-execution-time' to the execution time in seconds after running tests`
      );
    }

    if (currentShardFiles.length > 0) {
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
