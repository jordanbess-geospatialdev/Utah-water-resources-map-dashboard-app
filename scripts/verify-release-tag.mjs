#!/usr/bin/env node
// The runner must provision the approved signing keyring before this check.
// Missing keys, unsigned tags, and invalid signatures all fail closed.
import { execFileSync } from 'node:child_process';

const tag = process.env.RELEASE_TAG;
const fail = (message) => { console.error(`release preflight failed: ${message}`); process.exit(1); };
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) fail('RELEASE_TAG must be semver vX.Y.Z');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const ref = `refs/tags/${tag}`;
  const candidate = git('rev-parse', '--verify', `${ref}^{commit}`);
  const integration = git('rev-parse', '--verify', 'refs/remotes/origin/integration^{commit}');
  if (candidate !== integration) fail('tag does not match origin/integration HEAD');
  if (git('cat-file', '-t', ref) !== 'tag') fail('release requires an annotated, signed tag');
  git('verify-tag', ref);
  console.log(`release preflight passed: verified ${tag} at ${candidate}`);
} catch {
  fail('tag/ref missing or signature unverifiable; provision the approved signing keyring and retry');
}
