import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('web demo principals and permission grants match the canonical contract fixture', () => {
  const read = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
  assert.deepEqual(
    read('../src/shell/data/fixtures/principals.json'),
    read('../../../fixtures/contracts/principals.json'),
    'Keep the browser copy synchronized so UI authorization matches service fixtures',
  );
});
