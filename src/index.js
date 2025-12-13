import * as core from '@actions/core';
import { glob } from 'glob';

/**
 * Discovers all test files in the SBT project
 * @param {string} testPattern - Comma-separated glob patterns for test files
 * @returns {Promise<string[]>} Array of test file paths
 */
async function discoverTestFiles(testPattern) {
  const patterns = testPattern.split(',').map(p => p.trim());
  const testFiles = new Set();
  
  for (const pattern of patterns) {
    const files = await glob(pattern, {
      ignore: ['**/node_modules/**', '**/target/**', '**/.git/**'],
      absolute: false
    });
    files.forEach(file => testFiles.add(file));
  }
  
  return Array.from(testFiles).sort();
}

/**
 * Converts a test file path to an SBT test command
 * @param {string} testFile - Path to test file
 * @returns {string} SBT test command
 */
function testFileToSbtCommand(testFile) {
  // Convert path like src/test/scala/com/example/MyTest.scala
  // to test command like "testOnly com.example.MyTest"
  
  // Handle various SBT project structures:
  // - src/test/scala/com/example/MyTest.scala
  // - module1/src/test/scala/com/example/MyTest.scala
  // - src/test/com/example/MyTest.scala (non-standard)
  
  let relativePath = testFile;
  
  // Try to find and remove the test directory pattern
  const testDirPatterns = [
    /src\/test\/scala\//,
    /src\/test\//,
    /test\/scala\//,
    /test\//
  ];
  
  for (const pattern of testDirPatterns) {
    const match = testFile.match(pattern);
    if (match) {
      relativePath = testFile.substring(testFile.indexOf(match[0]) + match[0].length);
      break;
    }
  }
  
  // Remove .scala extension
  relativePath = relativePath.replace(/\.scala$/, '');
  
  // Convert path separators to dots
  const testClass = relativePath.replace(/\//g, '.');
  
  if (!testClass) {
    core.warning(`Could not convert test file path to class name: ${testFile}`);
    return '';
  }
  
  return `testOnly ${testClass}`;
}

/**
 * Simple sharding algorithm based on test file count
 * Distributes test files evenly across shards
 * @param {string[]} testFiles - Array of test file paths
 * @param {number} maxShards - Maximum number of shards
 * @returns {Array<Array<string>>} Array of shards, each containing test files
 */
function shardByTestFileCount(testFiles, maxShards) {
  const totalFiles = testFiles.length;
  const actualShards = Math.min(maxShards, totalFiles);
  
  if (totalFiles === 0) {
    return [];
  }
  
  const shards = Array.from({ length: actualShards }, () => []);
  
  // Distribute files evenly across shards
  testFiles.forEach((file, index) => {
    const shardIndex = index % actualShards;
    shards[shardIndex].push(file);
  });
  
  return shards;
}

/**
 * Main action execution
 */
async function run() {
  try {
    const maxShards = parseInt(core.getInput('max-shards'), 10);
    const algorithm = core.getInput('algorithm') || 'test-file-count';
    const testPattern = core.getInput('test-pattern') || '**/*Test.scala,**/*Spec.scala';
    
    // Get current shard number from input, environment variable, or default to 1
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
    
    // Apply sharding algorithm
    let shards;
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
    
    // Output results
    core.setOutput('shard-number', currentShard.toString());
    core.setOutput('total-shards', totalShards.toString());
    core.setOutput('test-files', currentShardFiles.join(','));
    
    // Generate SBT test commands
    const testCommands = currentShardFiles.map(testFileToSbtCommand);
    core.setOutput('test-commands', testCommands.join(' '));
    
    // Also set as environment variable for easier access
    core.exportVariable('SBT_TEST_FILES', currentShardFiles.join(','));
    core.exportVariable('SBT_TEST_COMMANDS', testCommands.join(' '));
    
    // Log summary
    if (currentShardFiles.length > 0) {
      core.info(`\nTest files in shard ${currentShard}:`);
      currentShardFiles.forEach(file => core.info(`  - ${file}`));
      core.info(`\nSBT command: sbt ${testCommands.join(' ')}`);
    } else {
      core.warning(`No test files assigned to shard ${currentShard}`);
    }
    
  } catch (error) {
    core.setFailed(error.message);
  }
}

// Run the action
run();
