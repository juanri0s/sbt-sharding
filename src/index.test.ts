import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  exportVariable: vi.fn(),
}));

vi.mock('glob', async () => {
  const actual = await vi.importActual('glob');
  return {
    ...actual,
    glob: vi.fn(),
  };
});

import * as core from '@actions/core';
import { glob } from 'glob';
import { discoverTestFiles, testFileToSbtCommand, shardByTestFileCount, run } from './index.js';

const mockGlob = glob as ReturnType<typeof vi.fn>;
const mockCore = core as {
  getInput: ReturnType<typeof vi.fn>;
  setOutput: ReturnType<typeof vi.fn>;
  setFailed: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
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
    expect(mockCore.exportVariable).toHaveBeenCalled();
  });

  it('should use shard-number input when provided', async () => {
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
  });

  it('should throw error for invalid max-shards', async () => {
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '0';
      return '';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('max-shards must be a positive integer');
  });

  it('should throw error for NaN max-shards', async () => {
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return 'invalid';
      return '';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('max-shards must be a positive integer');
  });

  it('should throw error for unknown algorithm', async () => {
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
    mockCore.getInput.mockImplementation((key: string) => {
      if (key === 'max-shards') return '1';
      if (key === 'algorithm') return 'test-file-count';
      if (key === 'test-pattern') return '**/*Test.scala';
      if (key === 'shard-number') return '1';
      return '';
    });

    mockGlob.mockResolvedValue(['src/test/scala/com/example/Test1.scala']);

    await run();

    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Test files in shard 1:'));
    expect(mockCore.info).toHaveBeenCalledWith(expect.stringContaining('Command:'));
  });

  it('should warn when shard has no files', async () => {
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
    mockCore.getInput.mockImplementation(() => {
      throw new Error('Input error');
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('Input error');
  });

  it('should handle non-Error exceptions', async () => {
    mockCore.getInput.mockImplementation(() => {
      throw 'String error';
    });

    await run();

    expect(mockCore.setFailed).toHaveBeenCalledWith('String error');
  });

  it('should include environment variables in test command', async () => {
    process.env.JAVA_OPTS = '-Xmx2g';
    process.env.SCALA_VERSION = '2.13';

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
});
