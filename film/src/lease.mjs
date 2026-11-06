import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function acquireLease(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = fs.openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize recovery, then re-read ownership under the recovery lock.
      // Otherwise two contenders can both observe a dead PID and the second
      // can unlink the first contender's newly created lease.
      let recovery;
      try { recovery = fs.openSync(file + '.recover', 'wx'); }
      catch { throw new Error(`Render lock is being inspected: ${file}`); }
      try {
        let previous;
        try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Unrecognized render lock: ${file}`); }
        if (previous.host !== os.hostname() || !Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error(`Render lock needs inspection: ${file}`);
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
        if (alive) throw new Error(`Another render job owns ${file} (PID ${previous.pid})`);
        fs.unlinkSync(file);
      } finally { fs.closeSync(recovery); fs.unlinkSync(file + '.recover'); }
      continue;
    }
    const identity = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() });
    try { fs.writeFileSync(fd, identity); } finally { fs.closeSync(fd); }
    return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === identity) fs.unlinkSync(file); };
  }
  throw new Error(`Could not acquire render lock: ${file}`);
}
