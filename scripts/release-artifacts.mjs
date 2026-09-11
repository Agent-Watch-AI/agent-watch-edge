import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Run after build/checks. No publishing, credentials, or signing is performed.
const output = path.resolve('artifacts');
fs.mkdirSync(output, { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { encoding: 'utf8' }))[0];
const tarball = path.join(output, packed.filename);
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
const allowed = /^package\/(?:dist\/[\w./-]+\.(?:js|d\.ts)|package\.json|README\.md|SECURITY\.md|LICENSE|CHANGELOG\.md|docs\/(?:DATA_HANDLING|ENTERPRISE_DEPLOYMENT|PERFORMANCE)\.md)$/;
for (const entry of entries) {
  assert(!entry.split('/').includes('..') && allowed.test(entry), `Unexpected package entry: ${entry}`);
}
for (const file of ['dist/cli.js', 'README.md', 'SECURITY.md', 'docs/DATA_HANDLING.md', 'docs/ENTERPRISE_DEPLOYMENT.md', 'docs/PERFORMANCE.md', 'LICENSE', 'package.json']) {
  assert(entries.includes(`package/${file}`), `Missing package entry: ${file}`);
}
const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
for (const value of Object.values(manifest.exports)) {
  for (const target of Object.values(value)) assert(entries.includes(`package/${target.replace(/^\.\//, '')}`), `Missing export: ${target}`);
}
assert(packed.unpackedSize < 2_000_000, 'Package exceeds 2 MB review threshold');
const sbom = execFileSync('npm', ['sbom', '--sbom-format=cyclonedx', '--omit=dev'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
assert.equal(JSON.parse(sbom).bomFormat, 'CycloneDX');
const sbomName = 'edge.cdx.json';
fs.writeFileSync(path.join(output, sbomName), sbom);
const checksums = [packed.filename, sbomName].map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex')}  ${name}\n`).join('');
fs.writeFileSync(path.join(output, 'SHA256SUMS'), checksums);
console.log(`Verified ${entries.length} files; ${packed.unpackedSize} bytes unpacked. Artifacts: ${output}`);
