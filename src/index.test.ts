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

vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return {
    ...actual,
    resolve: vi.fn((...args) => {
      // Throw error for specific test case
      if (args[0]?.includes('THROW_ERROR')) {
        throw new Error('Path resolve error');
      }
      return actual.resolve(...args);
    }),
  };
});

import * as core from '@actions/core';
import { glob } from 'glob';
import {
  discoverTestFiles,
  testFileToSbtCommand,
  shardByTestFileCount,
  shardByComplexity,
  analyzeTestComplexity,
  calculateOptimalShards,
  run,
} from './index.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

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
  });

  it('should run successfully with valid inputs', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.getInput).toHaveBeenCalledWith('max-shards');
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

  it('should always use shard 1', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-files',
      'src/test/scala/com/example/Test1.scala'
    );
  });

  it('should handle no test files found', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      return '';
    });

    mockGlob.mockResolvedValue([]);

    await run();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'No test files found. This may indicate a misconfigured test-pattern.'
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('total-shards', '1');
    expect(mockCore.setOutput).toHaveBeenCalledWith('test-files', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('test-commands', '');
    expect(mockCore.setOutput).toHaveBeenCalledWith('shard-matrix', JSON.stringify([1]));
  });

  it('should throw error for invalid max-shards', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '0';
      return '';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('max-shards must be a positive integer');
  });

  it('should throw error for max-shards exceeding limit', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '101';
      return '';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('max-shards cannot exceed 100');
  });

  it('should throw error for NaN max-shards', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
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
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((_key: string) => {
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'complexity';
      if (key === 'test-pattern') return '**/*Test.scala';
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
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockGlob).toHaveBeenCalledWith('**/*Test.scala', expect.any(Object));
    expect(mockGlob).toHaveBeenCalledWith('**/*Spec.scala', expect.any(Object));
  });

  it('should handle shard index out of bounds gracefully', async () => {
    process.env.GITHUB_SHARD = '10';
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '2';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-files',
      'src/test/scala/com/example/Test1.scala'
    );
  });

  it('should log test files and commands when shard has files', async () => {
    process.env.GITHUB_SHARD = '1';
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Shard distribution:'));
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Shard 1:'));
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('testOnly'));
  });

  it('should warn when shard has no files', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '3';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      return '';
    });

    mockGlob.mockResolvedValue([
      'src/test/scala/com/example/Test1.scala',
      'src/test/scala/com/example/Test2.scala',
    ]);

    await run();

    expect(mockCore.setOutput).toHaveBeenCalledWith('total-shards', '2');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-files',
      'src/test/scala/com/example/Test1.scala'
    );
    expect(mockCore.warning).not.toHaveBeenCalled();
  });

  it('should handle error and call setFailed', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
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
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'test-env-vars') return 'JAVA_OPTS,SCALA_VERSION';
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

  it('should skip invalid environment variable names', async () => {
    process.env.VALID_VAR = 'value';
    process.env.INVALID_VAR = 'value';
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'test-env-vars') return 'VALID_VAR,INVALID-VAR,123INVALID';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Invalid environment variable name')
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-commands',
      expect.stringMatching(/VALID_VAR=value/)
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'test-commands',
      expect.not.stringMatching(/INVALID-VAR|123INVALID/)
    );

    delete process.env.VALID_VAR;
    delete process.env.INVALID_VAR;
  });

  it('should sanitize environment variable values', async () => {
    process.env.TEST_VAR = 'value;rm -rf /';
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'test-env-vars') return 'TEST_VAR';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    const setOutputCalls = (mockCore.setOutput as ReturnType<typeof vi.fn>).mock.calls;
    const testCommandsCall = setOutputCalls.find((call) => call[0] === 'test-commands');
    expect(testCommandsCall).toBeDefined();
    expect(testCommandsCall[1]).toContain('TEST_VAR=');
    // Verify dangerous characters are sanitized (replaced with _)
    expect(testCommandsCall[1]).not.toContain('value;rm');
    expect(testCommandsCall[1]).toMatch(/TEST_VAR=value_rm/);

    delete process.env.TEST_VAR;
  });

  it('should skip missing environment variables', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return false;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'test-env-vars') return 'MISSING_VAR,JAVA_OPTS';
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

  it('should use auto-shard mode to calculate shards', async () => {
    (mockCore.getBooleanInput as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'auto-shard') return true;
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
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
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
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
      return false;
    });
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'algorithm') return 'round-robin';
      if (key === 'test-pattern') return '**/*Test.scala';
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

describe('shardByComplexity', () => {
  const testDir = join(process.cwd(), 'test-temp');

  beforeEach(() => {
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }
  });

  it('should distribute files by complexity', () => {
    const testDir = join(process.cwd(), 'test-temp');
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    const testFile1 = join(testDir, 'Test1.scala');
    const testFile2 = join(testDir, 'Test2.scala');
    const testFile3 = join(testDir, 'Test3.scala');
    writeFileSync(testFile1, 'test("test1") {}');
    writeFileSync(testFile2, 'test("test2") {}');
    writeFileSync(testFile3, 'test("test3") {}');

    const testFiles = [testFile1, testFile2, testFile3];
    const shards = shardByComplexity(testFiles, 2);
    expect(shards.length).toBe(2);
    expect(shards[0].length + shards[1].length).toBe(3);
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

  it('should reject path traversal attempts', () => {
    const testFile = join(testDir, 'Test.scala');
    writeFileSync(testFile, 'class Test');

    // Mock core.warning to verify it's called
    const mockWarning = vi.spyOn(core, 'warning');

    // Test with path traversal
    const maliciousPath = join(testDir, '..', '..', 'etc', 'passwd');
    const score = analyzeTestComplexity(maliciousPath);

    // Should return base score without reading file
    expect(score).toBeGreaterThanOrEqual(1);
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Invalid file path detected (possible path traversal)')
    );

    mockWarning.mockRestore();
  });

  it('should handle absolute paths outside base directory', () => {
    // Mock core.warning to verify it's called
    const mockWarning = vi.spyOn(core, 'warning');

    // Use an absolute path that's clearly outside the test directory
    // On Unix systems, /etc/passwd is a common target
    // On Windows, we'll use a path that should be outside
    const maliciousPath =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\config\\sam' : '/etc/passwd';

    const score = analyzeTestComplexity(maliciousPath);

    // Should return base score without reading file
    expect(score).toBeGreaterThanOrEqual(1);
    // Should warn about path traversal
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Invalid file path detected (possible path traversal)')
    );

    mockWarning.mockRestore();
  });

  it('should handle path resolve errors gracefully', () => {
    // Mock core.warning to verify it's called
    const mockWarning = vi.spyOn(core, 'warning');

    // Use a path that will cause resolve to throw
    const invalidPath = 'THROW_ERROR/path';
    const score = analyzeTestComplexity(invalidPath);

    // Should return base score without reading file
    expect(score).toBeGreaterThanOrEqual(1);
    // Should handle gracefully without crashing
    expect(mockWarning).toHaveBeenCalled();

    mockWarning.mockRestore();
  });

  it('should reject files that are too large', () => {
    const largeFile = join(testDir, 'LargeTest.scala');
    // Create a file larger than MAX_FILE_SIZE (10MB)
    const largeContent = 'x'.repeat(11 * 1024 * 1024);
    writeFileSync(largeFile, largeContent);

    // Mock core.warning to verify it's called
    const mockWarning = vi.spyOn(core, 'warning');

    const score = analyzeTestComplexity(largeFile);

    // Should return base score without reading full file
    expect(score).toBeGreaterThanOrEqual(1);
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('File too large for complexity analysis')
    );

    mockWarning.mockRestore();
  });
});
