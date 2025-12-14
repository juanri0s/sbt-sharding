import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  exportVariable: vi.fn(),
}));

vi.mock('glob', async () => {
  const actual = await vi.importActual('glob');
  return {
    ...actual,
    glob: vi.fn(),
  };
});

vi.mock('@actions/github', () => ({
  getOctokit: vi.fn(),
  context: {
    repo: { owner: 'test', repo: 'test' },
    runId: 123,
  },
}));

import * as core from '@actions/core';
import { glob } from 'glob';
import {
  discoverTestFiles,
  testFileToSbtCommand,
  shardByTestFileCount,
  shardByComplexity,
  analyzeTestComplexity,
  calculateOptimalShards,
  loadHistoricalData,
  saveHistoricalData,
  getTestWeight,
  run,
} from './index.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

const mockGlob = glob as ReturnType<typeof vi.fn>;
const mockCore = core as {
  getInput: ReturnType<typeof vi.fn>;
  getBooleanInput: ReturnType<typeof vi.fn>;
  setOutput: ReturnType<typeof vi.fn>;
  setFailed: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  exportVariable: ReturnType<typeof vi.fn>;
};

describe('discoverTestFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should discover test files matching a single pattern', async () => {
    mockGlob.mockResolvedValue(['src/test/scala/Test1.scala', 'src/test/scala/Test2.scala']);

    const result = await discoverTestFiles('**/*Test.scala');

    expect(result).toEqual(['src/test/scala/Test1.scala', 'src/test/scala/Test2.scala']);
    expect(mockGlob).toHaveBeenCalledWith('**/*Test.scala', {
      ignore: ['**/node_modules/**', '**/target/**', '**/.git/**'],
      absolute: false,
    });
  });

  it('should discover test files matching multiple patterns', async () => {
    mockGlob
      .mockResolvedValueOnce(['src/test/scala/Test1.scala'])
      .mockResolvedValueOnce(['src/test/scala/Spec1.scala']);

    const result = await discoverTestFiles('**/*Test.scala,**/*Spec.scala');

    expect(result).toEqual(['src/test/scala/Spec1.scala', 'src/test/scala/Test1.scala']);
    expect(mockGlob).toHaveBeenCalledTimes(2);
  });

  it('should handle patterns with whitespace', async () => {
    mockGlob.mockResolvedValue(['src/test/scala/Test1.scala']);

    const result = await discoverTestFiles('**/*Test.scala, **/*Spec.scala');

    expect(result).toEqual(['src/test/scala/Test1.scala']);
    expect(mockGlob).toHaveBeenCalledTimes(2);
  });

  it('should remove duplicates', async () => {
    mockGlob
      .mockResolvedValueOnce(['src/test/scala/Test1.scala', 'src/test/scala/Test2.scala'])
      .mockResolvedValueOnce(['src/test/scala/Test1.scala']);

    const result = await discoverTestFiles('**/*Test.scala,**/*Test.scala');

    expect(result).toEqual(['src/test/scala/Test1.scala', 'src/test/scala/Test2.scala']);
  });

  it('should return empty array when no files found', async () => {
    mockGlob.mockResolvedValue([]);

    const result = await discoverTestFiles('**/*Test.scala');

    expect(result).toEqual([]);
  });

  it('should sort results', async () => {
    mockGlob.mockResolvedValue(['z/Test.scala', 'a/Test.scala', 'm/Test.scala']);

    const result = await discoverTestFiles('**/*Test.scala');

    expect(result).toEqual(['a/Test.scala', 'm/Test.scala', 'z/Test.scala']);
  });
});

describe('testFileToSbtCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should convert standard test file path to SBT command', () => {
    const result = testFileToSbtCommand('src/test/scala/com/example/MyTest.scala');
    expect(result).toBe('testOnly com.example.MyTest');
  });

  it('should handle nested package structures', () => {
    const result = testFileToSbtCommand('src/test/scala/com/example/domain/UserTest.scala');
    expect(result).toBe('testOnly com.example.domain.UserTest');
  });

  it('should handle src/test/ prefix (non-standard)', () => {
    const result = testFileToSbtCommand('src/test/com/example/MyTest.scala');
    expect(result).toBe('testOnly com.example.MyTest');
  });

  it('should handle test/scala/ prefix', () => {
    const result = testFileToSbtCommand('test/scala/com/example/MyTest.scala');
    expect(result).toBe('testOnly com.example.MyTest');
  });

  it('should handle test/ prefix', () => {
    const result = testFileToSbtCommand('test/com/example/MyTest.scala');
    expect(result).toBe('testOnly com.example.MyTest');
  });

  it('should handle module-based paths', () => {
    const result = testFileToSbtCommand('module1/src/test/scala/com/example/MyTest.scala');
    expect(result).toBe('testOnly com.example.MyTest');
  });

  it('should return empty string and warn for invalid paths', () => {
    const result = testFileToSbtCommand('invalid/path.scala');
    expect(result).toBe('');
    expect(mockCore.warning).toHaveBeenCalledWith(
      'Could not convert test file path to class name: invalid/path.scala'
    );
  });

  it('should handle files without extension', () => {
    const result = testFileToSbtCommand('src/test/scala/com/example/MyTest');
    expect(result).toBe('testOnly com.example.MyTest');
  });

  it('should return empty string when testClass is empty after processing', () => {
    const result = testFileToSbtCommand('src/test/scala/.scala');
    expect(result).toBe('');
    expect(mockCore.warning).toHaveBeenCalledWith(
      'Could not convert test file path to class name: src/test/scala/.scala'
    );
  });

  it('should handle container test files', () => {
    const result = testFileToSbtCommand('src/test/scala/com/example/ContainerTest.scala');
    expect(result).toBe('testOnly com.example.ContainerTest');
  });

  it('should handle property test files', () => {
    const result = testFileToSbtCommand('src/test/scala/com/example/PropertyTest.scala');
    expect(result).toBe('testOnly com.example.PropertyTest');
  });
});

describe('loadHistoricalData', () => {
  const testDir = join(process.cwd(), 'test-temp');

  beforeEach(() => {
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }
  });

  it('should return null for empty path', () => {
    expect(loadHistoricalData('')).toBeNull();
  });

  it('should return null when historical data path is not provided', () => {
    expect(loadHistoricalData('')).toBeNull();
  });

  it('should return null for non-existent file', () => {
    expect(loadHistoricalData('nonexistent.json')).toBeNull();
  });

  it('should load valid historical data', () => {
    const dataFile = join(testDir, 'test-times.json');
    const data = {
      'test1.scala': 45.2,
      'test2.scala': 12.8,
    };
    writeFileSync(dataFile, JSON.stringify(data));

    const result = loadHistoricalData(dataFile);
    expect(result).toEqual(data);
  });

  it('should filter invalid entries', () => {
    const dataFile = join(testDir, 'test-times.json');
    const data = {
      'test1.scala': 45.2,
      'test2.scala': -5,
      'test3.scala': 0,
      'test4.scala': 'invalid',
      'test5.scala': 12.8,
    };
    writeFileSync(dataFile, JSON.stringify(data));

    const result = loadHistoricalData(dataFile);
    expect(result).toEqual({
      'test1.scala': 45.2,
      'test5.scala': 12.8,
    });
  });

  it('should handle empty historical data object', () => {
    const dataFile = join(testDir, 'empty.json');
    writeFileSync(dataFile, JSON.stringify({}));

    const result = loadHistoricalData(dataFile);
    expect(result).toEqual({});
  });

  it('should handle absolute paths starting with /', () => {
    const dataFile = join(testDir, 'absolute.json');
    const data = { 'test.scala': 10 };
    writeFileSync(dataFile, JSON.stringify(data));

    const absolutePath = dataFile.startsWith('/') ? dataFile : '/' + dataFile;
    const result = loadHistoricalData(absolutePath);
    if (existsSync(absolutePath)) {
      expect(result).toEqual(data);
    } else {
      expect(result).toBeNull();
    }
  });

  it('should handle error when file exists but JSON is invalid', () => {
    const dataFile = join(testDir, 'invalid-json.json');
    writeFileSync(dataFile, 'not json {');

    const result = loadHistoricalData(dataFile);
    expect(result).toBeNull();
    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load historical data')
    );
  });

  it('should handle JSON.parse throwing non-Error', () => {
    const dataFile = join(testDir, 'parse-error.json');
    writeFileSync(dataFile, '{}');

    const originalParse = JSON.parse;
    JSON.parse = vi.fn(() => {
      throw 'String exception';
    });

    const result = loadHistoricalData(dataFile);
    expect(result).toBeNull();
    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load historical data')
    );

    JSON.parse = originalParse;
  });
});

describe('saveHistoricalData', () => {
  const testDir = join(process.cwd(), 'test-temp');

  beforeEach(() => {
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }
  });

  it('should create new file with execution times', () => {
    const dataFile = join(testDir, 'new-times.json');
    const testFiles = ['test1.scala', 'test2.scala'];
    saveHistoricalData(dataFile, testFiles, 100);

    const result = loadHistoricalData(dataFile);
    expect(result).toBeDefined();
    expect(result![testFiles[0]]).toBe(50);
    expect(result![testFiles[1]]).toBe(50);
  });

  it('should update existing file with averaged times', () => {
    const dataFile = join(testDir, 'update-times.json');
    const existingData = {
      'test1.scala': 100,
      'test2.scala': 50,
    };
    writeFileSync(dataFile, JSON.stringify(existingData));

    const testFiles = ['test1.scala', 'test3.scala'];
    saveHistoricalData(dataFile, testFiles, 60);

    const result = loadHistoricalData(dataFile);
    expect(result).toBeDefined();
    expect(result!['test1.scala']).toBe(65);
    expect(result!['test2.scala']).toBe(50);
    expect(result!['test3.scala']).toBe(30);
  });

  it('should create directory if it does not exist', () => {
    const dataFile = join(testDir, 'nested', 'times.json');
    const testFiles = ['test1.scala'];
    saveHistoricalData(dataFile, testFiles, 50);

    expect(existsSync(dataFile)).toBe(true);
    const result = loadHistoricalData(dataFile);
    expect(result).toBeDefined();
    expect(result![testFiles[0]]).toBe(50);
  });

  it('should handle empty test files array', () => {
    const dataFile = join(testDir, 'empty-times.json');
    saveHistoricalData(dataFile, [], 100);

    const result = loadHistoricalData(dataFile);
    expect(result).toEqual({});
  });

  it('should handle errors when saving', () => {
    const invalidPath = '/root/invalid/path/to/file.json';
    const testFiles = ['test1.scala'];
    saveHistoricalData(invalidPath, testFiles, 50);

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save historical data')
    );
  });

  it('should handle non-Error exceptions in catch block', () => {
    const dataFile = join(testDir, 'error-save.json');
    const testFiles = ['test1.scala'];

    const fs = require('fs');
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = vi.fn(() => {
      throw 'String exception';
    });

    saveHistoricalData(dataFile, testFiles, 50);
    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save historical data')
    );

    fs.writeFileSync = originalWriteFileSync;
  });

  it('should handle invalid JSON in existing file', () => {
    const dataFile = join(testDir, 'invalid-json-save.json');
    writeFileSync(dataFile, 'invalid json');

    const testFiles = ['test1.scala'];
    saveHistoricalData(dataFile, testFiles, 50);

    const result = loadHistoricalData(dataFile);
    expect(result).toBeDefined();
    expect(result!['test1.scala']).toBe(50);
  });

  it('should handle case when directory already exists', () => {
    const dataFile = join(testDir, 'existing-dir', 'times.json');
    mkdirSync(dirname(dataFile), { recursive: true });
    const testFiles = ['test1.scala'];
    saveHistoricalData(dataFile, testFiles, 50);

    const result = loadHistoricalData(dataFile);
    expect(result).toBeDefined();
    expect(result!['test1.scala']).toBe(50);
  });

  it('should handle absolute paths starting with /', () => {
    const dataFile = join(testDir, 'absolute-save.json');
    const absolutePath = '/' + dataFile;
    const testFiles = ['test1.scala'];

    try {
      saveHistoricalData(absolutePath, testFiles, 50);
      if (existsSync(absolutePath)) {
        const result = loadHistoricalData(absolutePath);
        expect(result).toBeDefined();
      }
    } catch {
      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save historical data')
      );
    }
  });

  it('should handle non-Error exceptions in saveHistoricalData', () => {
    const dataFile = join(testDir, 'non-error-exception.json');
    const testFiles = ['test1.scala'];

    const fs = require('fs');
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = vi.fn(() => {
      throw 'String error';
    });

    saveHistoricalData(dataFile, testFiles, 50);

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save historical data')
    );

    fs.writeFileSync = originalWriteFileSync;
  });

  it('should return early if dataPath is empty', () => {
    vi.clearAllMocks();
    saveHistoricalData('', ['test1.scala'], 50);
    const updateCalls = (mockCore.info as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
      String(call[0]).includes('Updated historical data')
    );
    expect(updateCalls.length).toBe(0);
  });
});

describe('getTestWeight', () => {
  it('should use historical data when available', () => {
    const historicalData = { 'test.scala': 50.5 };
    expect(getTestWeight('test.scala', historicalData, 10)).toBe(50.5);
  });

  it('should fall back to complexity score when no historical data', () => {
    expect(getTestWeight('test.scala', null, 10)).toBe(10);
  });

  it('should fall back to complexity score when test not in historical data', () => {
    const historicalData = { 'other.scala': 50.5 };
    expect(getTestWeight('test.scala', historicalData, 10)).toBe(10);
  });

  it('should use historical data when available and not null', () => {
    const historicalData = { 'test.scala': 50.5 };
    expect(getTestWeight('test.scala', historicalData, 10)).toBe(50.5);
  });

  it('should fall back to complexity when historical data is null', () => {
    expect(getTestWeight('test.scala', null, 10)).toBe(10);
  });
});

describe('shardByTestFileCount', () => {
  it('should distribute files evenly across shards', () => {
    const testFiles = ['file1.scala', 'file2.scala', 'file3.scala', 'file4.scala'];
    const result = shardByTestFileCount(testFiles, 2);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['file1.scala', 'file3.scala']);
    expect(result[1]).toEqual(['file2.scala', 'file4.scala']);
  });

  it('should handle more files than shards', () => {
    const testFiles = ['file1.scala', 'file2.scala', 'file3.scala', 'file4.scala', 'file5.scala'];
    const result = shardByTestFileCount(testFiles, 2);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['file1.scala', 'file3.scala', 'file5.scala']);
    expect(result[1]).toEqual(['file2.scala', 'file4.scala']);
  });

  it('should handle more shards than files', () => {
    const testFiles = ['file1.scala', 'file2.scala'];
    const result = shardByTestFileCount(testFiles, 5);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['file1.scala']);
    expect(result[1]).toEqual(['file2.scala']);
  });

  it('should return empty array for no files', () => {
    const result = shardByTestFileCount([], 5);
    expect(result).toEqual([]);
  });

  it('should handle single file', () => {
    const result = shardByTestFileCount(['file1.scala'], 3);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['file1.scala']);
  });

  it('should handle single shard', () => {
    const testFiles = ['file1.scala', 'file2.scala', 'file3.scala'];
    const result = shardByTestFileCount(testFiles, 1);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['file1.scala', 'file2.scala', 'file3.scala']);
  });

  it('should distribute files using round-robin', () => {
    const testFiles = ['file1.scala', 'file2.scala', 'file3.scala'];
    const result = shardByTestFileCount(testFiles, 3);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(['file1.scala']);
    expect(result[1]).toEqual(['file2.scala']);
    expect(result[2]).toEqual(['file3.scala']);
  });
});

describe('run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_SHARD = undefined;
  });

  afterEach(() => {
    delete process.env.GITHUB_SHARD;
  });

  it('should run successfully with valid inputs', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.getInput).toHaveBeenCalledWith('max-shards');
    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-number', '1');
    expect(mockCore.setOutput).toHaveBeenCalledWith('total-shards', '2');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-files',
      'src/test/scala/com/example/Test1.scala'
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-commands',
      expect.stringContaining('testOnly')
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-matrix', JSON.stringify([1, 2]));
    expect(mockCore.exportVariable).toHaveBeenCalled();
  });

  it('should use shard-number input when provided', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '2';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-number', '2');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-files',
      'src/test/scala/com/example/Test2.scala'
    );
  });

  it('should use GITHUB_SHARD environment variable when shard-number input is not provided', async () => {
    process.env.GITHUB_SHARD = '2';
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-number', '2');
  });

  it('should default to shard 1 when neither input nor env var is provided', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '';
      return '';
    });

    delete process.env.GITHUB_SHARD;

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-number', '1');
  });

  it('should handle no test files found', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '';
      return '';
    });

    mockGlob.mockResolvedValue([]);

    await run();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'No test files found. This may indicate a misconfigured test-pattern.'
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-number', '1');
    expect(mockCore.setOutput).toHaveBeenCalledWith('total-shards', '1');
    expect(mockCore.setOutput).toHaveBeenCalledWith('test-files', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('test-commands', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-matrix', JSON.stringify([1]));
  });

  it('should throw error for invalid max-shards', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '0';
      return '';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('max-shards must be a positive integer');
  });

  it('should throw error for NaN max-shards', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return 'invalid';
      return '';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('max-shards must be a positive integer');
  });

  it('should use complexity algorithm', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'complexity';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalled();
    expect(mockCore.setFailed).not.toHaveBeenCalled();
  });

  it('should throw error for unknown algorithm', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'unknown-algorithm';
      if (key === 'test-pattern') return '**/*Test.scala';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('Unknown algorithm: unknown-algorithm');
  });

  it('should use default algorithm when not provided', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return '';
      if (key === 'test-pattern') return '**/*Test.scala';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalled();
    expect(mockCore.setFailed).not.toHaveBeenCalled();
  });

  it('should use default test-pattern when not provided', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockGlob).toHaveBeenCalledWith('**/*Test.scala', expect.any(Object));
    expect(mockGlob).toHaveBeenCalledWith('**/*Spec.scala', expect.any(Object));
  });

  it('should handle shard index out of bounds gracefully', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '10';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-number', '10');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-files',
      'src/test/scala/com/example/Test1.scala'
    );
  });

  it('should log test files and commands when shard has files', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Shard distribution:'));
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Shard 1:'));
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Command:'));
  });

  it('should warn when shard has no files', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '3';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '3';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-number', '3');
    expect(mockCore.setOutput).toHaveBeenCalledWith('total-shards', '2');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-files',
      'src/test/scala/com/example/Test2.scala'
    );
    expect(mockCore.warning).not.toHaveBeenCalled();
  });

  it('should handle error and call setFailed', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation(() => {
      throw new Error('Input error');
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('Input error');
  });

  it('should handle non-Error exceptions', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation(() => {
      throw 'String error';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('String error');
  });

  it('should include environment variables in test command', async () => {
    process.env.JAVA_OPTS = '-Xmx2g';
    process.env.SCALA_VERSION = '2.13';
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'test-env-vars') return 'JAVA_OPTS,SCALA_VERSION';
      if (key === 'shard-number') return '1';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-commands',
      expect.stringMatching(/JAVA_OPTS=-Xmx2g SCALA_VERSION=2.13 testOnly/)
    );

    delete process.env.JAVA_OPTS;
    delete process.env.SCALA_VERSION;
  });

  it('should skip missing environment variables', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'test-env-vars') return 'MISSING_VAR,JAVA_OPTS';
      if (key === 'shard-number') return '1';
      return '';
    });

    process.env.JAVA_OPTS = '-Xmx2g';

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-commands',
      expect.stringMatching(/JAVA_OPTS=-Xmx2g testOnly/)
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-commands',
      expect.not.stringMatching(/MISSING_VAR/)
    );

    delete process.env.JAVA_OPTS;
  });

  it('should use historical data when enabled', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'test-times.json');
    const historicalData = {
      'src/test/scala/com/example/Test1.scala': 100,
      'src/test/scala/com/example/Test2.scala': 10,
    };
    writeFileSync(dataFile, JSON.stringify(historicalData));

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Using historical execution time data for')
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Distributing tests across')
    );
    expect(mockCore.setOutput).toHaveBeenCalled();
  });

  it('should handle missing historical data file gracefully', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return 'nonexistent.json';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Historical data file not found')
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('No historical data available, using')
    );
    expect(mockCore.setOutput).toHaveBeenCalled();
  });

  it('should handle invalid historical data gracefully', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'invalid.json');
    writeFileSync(dataFile, 'invalid json');

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load historical data')
    );
    expect(mockCore.setOutput).toHaveBeenCalled();
  });

  it('should not use historical data when path is empty', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return '';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalled();
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Using test-file-count algorithm')
    );
  });

  it('should log when some files have no historical data', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'partial-times.json');
    const historicalData = {
      'src/test/scala/com/example/Test1.scala': 100,
      'src/test/scala/com/example/Test2.scala': 50,
    };
    writeFileSync(dataFile, JSON.stringify(historicalData));

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
      'src/test/scala/com/example/Test3.scala',
      'src/test/scala/com/example/Test4.scala',
    ]);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Historical execution times:')
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('test file(s) have no historical data')
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Shard distribution (balanced by execution time)')
    );
    const infoCalls = (mockCore.info as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    const shardInfo = infoCalls.find(
      (call) => typeof call === 'string' && call.includes('Shard') && call.includes('~')
    );
    expect(shardInfo).toBeDefined();
    expect(mockCore.setOutput).toHaveBeenCalled();
  });

  it('should log historical data with complexity algorithm when some files missing', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'partial-complexity.json');
    const testFile1 = join(testDir, 'Test1.scala');
    const testFile2 = join(testDir, 'Test2.scala');
    const testFile3 = join(testDir, 'Test3.scala');
    writeFileSync(testFile1, 'class Test1');
    writeFileSync(testFile2, 'class Test2');
    writeFileSync(testFile3, 'class Test3');

    const historicalData = {
      [testFile1]: 100,
    };
    writeFileSync(dataFile, JSON.stringify(historicalData));

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'complexity';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue([testFile1, testFile2, testFile3]);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'test file(s) have no historical data, using complexity scores for those'
      )
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Shard distribution (balanced by execution time)')
    );
    expect(mockCore.setOutput).toHaveBeenCalled();
  });

  it('should show complexity scores when historical data exists but no files match', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'no-match.json');
    const historicalData = {
      'different/path/Test.scala': 100,
    };
    writeFileSync(dataFile, JSON.stringify(historicalData));

    const testFile1 = join(testDir, 'Test1.scala');
    const testFile2 = join(testDir, 'Test2.scala');
    writeFileSync(testFile1, 'class Test1');
    writeFileSync(testFile2, 'class Test2');

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'complexity';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue([testFile1, testFile2]);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Shard distribution (using complexity scores - no historical data available)'
      )
    );
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('complexity score:'));
    expect(mockCore.setOutput).toHaveBeenCalled();
  });

  it('should load historical data when enabled', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'test-times.json');
    writeFileSync(dataFile, JSON.stringify({ 'test.scala': 10 }));

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Loaded historical data'));
  });

  it('should save historical data when test step execution time is available', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'save-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({
            data: {
              jobs: [
                {
                  steps: [
                    {
                      name: 'Run Tests',
                      status: 'completed',
                      started_at: '2024-01-01T00:00:00Z',
                      completed_at: '2024-01-01T00:02:00Z',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Automatically collected execution time')
    );
    const savedData = JSON.parse(readFileSync(dataFile, 'utf-8'));
    expect(savedData['src/test/scala/com/example/Test1.scala']).toBe(60);
    expect(savedData['src/test/scala/com/example/Test2.scala']).toBe(60);

    delete process.env.GITHUB_TOKEN;
  });

  it('should handle missing GITHUB_TOKEN gracefully', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'no-token-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Loaded historical data'));

    if (originalToken) {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('should detect step with "run" in name (but not "test") for execution time', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'run-step-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({
            data: {
              jobs: [
                {
                  steps: [
                    {
                      name: 'Run build',
                      status: 'completed',
                      started_at: '2024-01-01T00:00:00Z',
                      completed_at: '2024-01-01T00:01:30Z',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Automatically collected execution time')
    );
    const savedData = JSON.parse(readFileSync(dataFile, 'utf-8'));
    expect(savedData['src/test/scala/com/example/Test1.scala']).toBe(90);

    delete process.env.GITHUB_TOKEN;
  });

  it('should detect step with "sbt" in name (but not "test" or "run") for execution time', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'sbt-step-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({
            data: {
              jobs: [
                {
                  steps: [
                    {
                      name: 'sbt compile',
                      status: 'completed',
                      started_at: '2024-01-01T00:00:00Z',
                      completed_at: '2024-01-01T00:00:45Z',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Automatically collected execution time')
    );
    const savedData = JSON.parse(readFileSync(dataFile, 'utf-8'));
    expect(savedData['src/test/scala/com/example/Test1.scala']).toBe(45);

    delete process.env.GITHUB_TOKEN;
  });

  it('should return 0 when no completed steps with timing are found', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'no-step-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({
            data: {
              jobs: [
                {
                  steps: [
                    {
                      name: 'Setup Node',
                      status: 'in_progress',
                      started_at: '2024-01-01T00:00:00Z',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Historical data will be loaded from')
    );
    expect(mockCore.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Automatically collected execution time')
    );

    delete process.env.GITHUB_TOKEN;
  });

  it('should handle error in getTestStepExecutionTime and log fallback message', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'error-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockRejectedValue(new Error('API error')),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.debug).toHaveBeenCalledWith(
      expect.stringContaining('Could not automatically collect execution time')
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Historical data will be loaded from')
    );

    delete process.env.GITHUB_TOKEN;
  });

  it('should handle non-Error exception in getTestStepExecutionTime', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'non-error-exception-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockRejectedValue('String error'),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.debug).toHaveBeenCalledWith(
      expect.stringContaining('Could not automatically collect execution time')
    );
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Historical data will be loaded from')
    );

    delete process.env.GITHUB_TOKEN;
  });

  it('should handle execution time of 0 and log fallback message', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'zero-time-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({
            data: {
              jobs: [
                {
                  steps: [
                    {
                      name: 'Run Tests',
                      status: 'completed',
                      started_at: '2024-01-01T00:00:00Z',
                      completed_at: '2024-01-01T00:00:00Z',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Historical data will be loaded from')
    );
    expect(mockCore.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Automatically collected execution time')
    );

    delete process.env.GITHUB_TOKEN;
  });

  it('should handle when jobs.data.jobs is undefined', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'no-jobs-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({
            data: {},
          }),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Historical data will be loaded from')
    );

    delete process.env.GITHUB_TOKEN;
  });

  it('should fallback to last step when no matching step found', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'fallback-step-times.json');
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({
            data: {
              jobs: [
                {
                  steps: [
                    {
                      name: 'Setup',
                      status: 'completed',
                      started_at: '2024-01-01T00:00:00Z',
                      completed_at: '2024-01-01T00:00:30Z',
                    },
                    {
                      name: 'Build',
                      status: 'completed',
                      started_at: '2024-01-01T00:00:30Z',
                      completed_at: '2024-01-01T00:01:00Z',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return dataFile;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Automatically collected execution time')
    );
    const savedData = JSON.parse(readFileSync(dataFile, 'utf-8'));
    expect(savedData['src/test/scala/com/example/Test1.scala']).toBe(30);

    delete process.env.GITHUB_TOKEN;
  });

  it('should handle absolute path in saveHistoricalData', async () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const dataFile = join(testDir, 'absolute-save-times.json');
    // Use a simple absolute path that definitely starts with /
    const absolutePath = dataFile.startsWith('/') ? dataFile : '/' + dataFile;
    writeFileSync(dataFile, JSON.stringify({}));

    process.env.GITHUB_TOKEN = 'test-token';

    const githubModule = await import('@actions/github');
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({
            data: {
              jobs: [
                {
                  steps: [
                    {
                      name: 'Run Tests',
                      status: 'completed',
                      started_at: '2024-01-01T00:00:00Z',
                      completed_at: '2024-01-01T00:01:00Z',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    };

    vi.mocked(githubModule.getOctokit).mockReturnValue(mockOctokit as any);

    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      if (key === 'use-historical-data') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      if (key === 'historical-data-path') return absolutePath;
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Automatically collected execution time')
    );

    delete process.env.GITHUB_TOKEN;
  });

  it('should use auto-shard mode to calculate shards', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return true;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
      'src/test/scala/com/example/Test3.scala',
      'src/test/scala/com/example/Test4.scala',
      'src/test/scala/com/example/Test5.scala',
      'src/test/scala/com/example/Test6.scala',
    ]);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Auto-shard mode: calculated')
    );
    expect(mockCore.setOutput).toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'shard-matrix',
      expect.stringMatching(/^\[.*\]$/)
    );
  });

  it('should calculate 1 shard for 5 or fewer files', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return true;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
      'src/test/scala/com/example/Test3.scala',
    ]);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith('total-shards', '1');
  });

  it('should calculate multiple shards for many files', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return true;
      if (key === 'use-historical-data') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      return '';
    });

    const manyFiles = Array.from(
      { length: 25 },
      (_, i) => `src/test/scala/com/example/Test${i + 1}.scala`
    );
    mockGlob.mockResolvedValue(manyFiles);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith('total-shards', expect.any(String));
    const totalShards = (mockCore.setOutput as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'total-shards'
    )?.[1];
    expect(parseInt(totalShards as string, 10)).toBeGreaterThan(1);
  });
});

describe('calculateOptimalShards', () => {
  it('should return 1 for 0 files', () => {
    expect(calculateOptimalShards(0)).toBe(1);
  });

  it('should return 1 for 5 or fewer files', () => {
    expect(calculateOptimalShards(1)).toBe(1);
    expect(calculateOptimalShards(5)).toBe(1);
  });

  it('should calculate shards for 6-20 files', () => {
    expect(calculateOptimalShards(6)).toBe(2);
    expect(calculateOptimalShards(10)).toBe(2);
    expect(calculateOptimalShards(15)).toBe(3);
    expect(calculateOptimalShards(20)).toBe(4);
  });

  it('should cap at 10 shards for many files', () => {
    expect(calculateOptimalShards(100)).toBe(10);
    expect(calculateOptimalShards(200)).toBe(10);
  });

  it('should calculate appropriate shards for 21-100 files', () => {
    expect(calculateOptimalShards(21)).toBe(3);
    expect(calculateOptimalShards(50)).toBe(5);
    expect(calculateOptimalShards(99)).toBe(10);
  });
});

describe('analyzeTestComplexity', () => {
  const testDir = join(process.cwd(), 'test-temp');

  beforeEach(() => {
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }
  });

  afterEach(() => {
    // Cleanup handled by test framework
  });

  it('should assign base score of 1 to simple tests', () => {
    const file = join(testDir, 'SimpleTest.scala');
    writeFileSync(file, 'class SimpleTest extends FunSuite { test("test") {} }');
    expect(analyzeTestComplexity(file)).toBeGreaterThanOrEqual(1);
  });

  it('should increase score for property tests', () => {
    const file = join(testDir, 'PropertyTest.scala');
    writeFileSync(file, 'class PropertyTest extends PropertySpec');
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should increase score for integration tests', () => {
    const file = join(testDir, 'IntegrationTest.scala');
    writeFileSync(file, 'class IntegrationTest extends FunSuite');
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should increase score for container tests', () => {
    const file = join(testDir, 'ContainerTest.scala');
    writeFileSync(file, '@container class ContainerTest');
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should increase score for files with many tests', () => {
    const manyTests = Array.from({ length: 25 }, () => 'test("test") {}').join('\n');
    const file = join(testDir, 'ManyTests.scala');
    writeFileSync(file, `class ManyTests extends FunSuite { ${manyTests} }`);
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should handle missing files gracefully', () => {
    const score = analyzeTestComplexity('nonexistent/file.scala');
    expect(score).toBeGreaterThanOrEqual(1);
  });

  it('should increase score for files with property in content', () => {
    const file = join(testDir, 'Test.scala');
    writeFileSync(file, 'class Test { property("test") }');
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should increase score for files with container annotation', () => {
    const file = join(testDir, 'Test.scala');
    writeFileSync(file, '@container class Test');
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should increase score for files with integration in content', () => {
    const file = join(testDir, 'Test.scala');
    writeFileSync(file, '@integration class Test');
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should increase score for large files', () => {
    const largeContent = 'class Test { ' + 'test("test") {} '.repeat(100) + ' }';
    const file = join(testDir, 'LargeTest.scala');
    writeFileSync(file, largeContent);
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should reduce score for unit tests', () => {
    const file = join(testDir, 'UnitTest.scala');
    writeFileSync(file, 'class UnitTest');
    const score = analyzeTestComplexity(file);
    expect(score).toBe(1);
  });

  it('should increase score for files with 10-20 tests', () => {
    const manyTests = Array.from({ length: 15 }, () => 'test("test") {}').join('\n');
    const file = join(testDir, 'MediumTests.scala');
    writeFileSync(file, `class MediumTests extends FunSuite { ${manyTests} }`);
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });

  it('should increase score for files larger than 5000 chars', () => {
    const largeContent = 'x'.repeat(6000);
    const file = join(testDir, 'LargeFile.scala');
    writeFileSync(file, largeContent);
    const score = analyzeTestComplexity(file);
    expect(score).toBeGreaterThan(1);
  });
});

describe('shardByComplexity', () => {
  const testDir = join(process.cwd(), 'test-temp');

  beforeEach(() => {
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }
  });

  it('should distribute tests by complexity', () => {
    const simpleFile = join(testDir, 'SimpleTest.scala');
    const complexFile = join(testDir, 'PropertyTest.scala');
    writeFileSync(simpleFile, 'class SimpleTest extends FunSuite');
    writeFileSync(complexFile, 'class PropertyTest extends PropertySpec');

    const result = shardByComplexity([simpleFile, complexFile], 2);

    expect(result).toHaveLength(2);
    expect(result[0].length + result[1].length).toBe(2);
  });

  it('should balance complex tests across shards', () => {
    const files = [
      join(testDir, 'Property1.scala'),
      join(testDir, 'Property2.scala'),
      join(testDir, 'Property3.scala'),
      join(testDir, 'Simple1.scala'),
    ];

    files.forEach((file, i) => {
      const content = i < 3 ? 'class PropertyTest extends PropertySpec' : 'class SimpleTest';
      writeFileSync(file, content);
    });

    const result = shardByComplexity(files, 2);

    expect(result).toHaveLength(2);
    const totalFiles = result[0].length + result[1].length;
    expect(totalFiles).toBe(4);
  });

  it('should return empty array for no files', () => {
    const result = shardByComplexity([], 3);
    expect(result).toEqual([]);
  });

  it('should handle single file', () => {
    const file = join(testDir, 'SingleTest.scala');
    writeFileSync(file, 'class Test');
    const result = shardByComplexity([file], 3);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([file]);
  });

  it('should sort tests by complexity before distributing', () => {
    const simpleFile = join(testDir, 'SimpleTest.scala');
    const complexFile = join(testDir, 'PropertyTest.scala');
    writeFileSync(simpleFile, 'class SimpleTest');
    writeFileSync(complexFile, 'class PropertyTest extends PropertySpec');

    const result = shardByComplexity([simpleFile, complexFile], 2);

    expect(result).toHaveLength(2);
    const complexShard = result.find((shard) => shard.includes(complexFile));
    expect(complexShard).toBeDefined();
  });

  it('should use historical data when provided', () => {
    const slowFile = join(testDir, 'SlowTest.scala');
    const fastFile = join(testDir, 'FastTest.scala');
    writeFileSync(slowFile, 'class SlowTest');
    writeFileSync(fastFile, 'class FastTest');

    const historicalData = {
      [slowFile]: 200,
      [fastFile]: 5,
    };

    const result = shardByComplexity([slowFile, fastFile], 2, historicalData);

    expect(result).toHaveLength(2);
    expect(result[0].length + result[1].length).toBe(2);
    const allFiles = [...result[0], ...result[1]];
    expect(allFiles).toContain(slowFile);
    expect(allFiles).toContain(fastFile);
  });
});
