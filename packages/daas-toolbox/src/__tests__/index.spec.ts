import { describe, expect, test } from 'vitest';
import * as toolbox from '../index';

const exported = toolbox as Record<string, unknown>;

describe('@daas/toolbox barrel', () => {
  test.each([
    'useRequest',
    'useHistoryTravel',
    'useMount',
    'useWhyDidYouUpdate',
    'clearCache',
    'isCancelledError',
    'CancelledError',
  ])('exports %s', (name) => {
    expect(typeof exported[name]).toBe('function');
  });
});
