const { spawn } = require('node:child_process');
const node = process.env.AGENT_TEAM_NODE;
const entry = process.env.AGENT_TEAM_ENTRY;
if (!node || !entry) throw new Error('Configure the Node 24 and bridge entry paths');

// Desktop's Electron UtilityProcess supplies virtual stdin/stdout streams.
// Inheriting file descriptors bypasses those streams and gives the child EOF.
const child = spawn(node, [entry, '--origin', 'claude'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: false,
});
let failed = false;
let stopping = false;
let closed = false;
let exited = false;
let killTimer;
let drainTimer;
const broken = new Set();
function detachInput() {
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
}
function stop(signal = 'SIGTERM') {
  detachInput();
  if (stopping || closed) return;
  stopping = true;
  child.kill(signal);
  killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
  killTimer.unref();
}
function transportError(stream, error) {
  broken.add(stream);
  failed = true;
  if (stream !== process.stderr && !broken.has(process.stderr) && !process.stderr.destroyed) {
    process.stderr.write(`Bridge launcher: ${error.message}\n`);
  }
  stop();
}
for (const stream of [process.stdin, process.stdout, process.stderr, child.stdout, child.stderr]) {
  stream.on('error', (error) => transportError(stream, error));
}
child.stdin.on('error', (error) => {
  // A child can close its input just before emitting its exit/close events.
  if (error.code !== 'EPIPE') transportError(child.stdin, error);
});
child.on('error', (error) => transportError(child.stdin, error));
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.on('close', (code) => {
  closed = true;
  clearTimeout(killTimer);
  detachInput();
  const finish = () => {
    if (exited) return;
    exited = true;
    clearTimeout(drainTimer);
    process.exit(failed ? 1 : (code ?? 1));
  };
  // Child close drains the source pipes, but virtual destination writes may
  // still be pending. Flush both without ending Desktop's shared streams.
  drainTimer = setTimeout(finish, 1000);
  let pending = 2;
  const flushed = () => { if (--pending === 0) finish(); };
  for (const stream of [process.stdout, process.stderr]) {
    if (broken.has(stream) || stream.destroyed || stream.writableEnded) flushed();
    else stream.write('', (error) => {
      if (error) failed = true;
      flushed();
    });
  }
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));
process.on('disconnect', () => stop());
