import { describe, it, expect } from 'vitest';
import { PROJECT_NAME } from './index';

describe('shared', () => {
  it('expone el nombre del proyecto', () => {
    expect(PROJECT_NAME).toBe('citara');
  });
});
