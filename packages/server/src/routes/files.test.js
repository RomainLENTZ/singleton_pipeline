import { describe, expect, it } from 'vitest';
import { toApiFilePath } from './files.js';

describe('files route', () => {
  it('exposes API file paths with POSIX separators', () => {
    expect(toApiFilePath('src\\nested\\file.js')).toBe('src/nested/file.js');
  });
});
