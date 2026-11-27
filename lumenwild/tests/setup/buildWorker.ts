import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Before the unit tests: build the server's region worker (dist-worker/regionWorker.js), so servers in tests generate
 *  regions on worker threads exactly as the real server does. */
export function setup(): void {
  const root = join(__dirname, '..', '..');
  execFileSync(process.execPath, [join(root, 'server', 'build.mjs'), join(root, 'dist-worker'), 'regionWorker'], { stdio: 'ignore' });
  process.env.LUMENWILD_REGION_WORKER = join(root, 'dist-worker', 'regionWorker.js');
}
