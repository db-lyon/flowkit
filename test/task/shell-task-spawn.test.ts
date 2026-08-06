import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { ShellTask } from '../../src/task/shell-task.js';

function processStub(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  };
  child.pid = pid;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  return child;
}

describe('ShellTask spawn boundaries', () => {
  beforeEach(() => spawnMock.mockReset());

  it('does not call spawn for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await new ShellTask({}, {
      command: 'would-not-run',
      signal: controller.signal,
    }).run();

    expect(result.success).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('kills the spawned shell immediately when Windows taskkill fails', async () => {
    const child = processStub(101);
    const taskkill = processStub(102);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
    taskkill.emit('error', new Error('taskkill unavailable'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'taskkill',
      ['/pid', '101', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it.runIf(process.platform === 'win32')('kills the spawned shell when taskkill throws synchronously', async () => {
    const child = processStub(201);
    spawnMock.mockReturnValueOnce(child).mockImplementationOnce(() => {
      throw new Error('taskkill launch failed');
    });
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');

    await expect(resultPromise).resolves.toMatchObject({ success: false });
  });

  it.runIf(process.platform === 'win32')('defers direct shell kill when taskkill succeeds', async () => {
    const child = processStub(401);
    const taskkill = processStub(402);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
    taskkill.emit('close', 0);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGKILL');

    await expect(resultPromise).resolves.toMatchObject({ success: false });
  });

  it.runIf(process.platform === 'win32')('uses direct shell kill when taskkill exits nonzero', async () => {
    const child = processStub(501);
    const taskkill = processStub(502);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    taskkill.emit('close', 1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');

    await expect(resultPromise).resolves.toMatchObject({ success: false });
  });

  it.runIf(process.platform === 'win32')('uses direct shell kill when taskkill exceeds its watchdog', async () => {
    vi.useFakeTimers();
    try {
      const child = processStub(601);
      const taskkill = processStub(602);
      spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
      const controller = new AbortController();
      const resultPromise = new ShellTask({}, {
        command: 'long-running',
        signal: controller.signal,
      }).run();

      controller.abort();
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('close', null, 'SIGKILL');

      await expect(resultPromise).resolves.toMatchObject({ success: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it.runIf(process.platform === 'win32')('ignores taskkill failures after the shell task settles', async () => {
    const child = processStub(701);
    const taskkill = processStub(702);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    taskkill.emit('close', 0);
    child.emit('close', null, 'SIGKILL');
    await expect(resultPromise).resolves.toMatchObject({ success: false });
    taskkill.emit('error', new Error('late taskkill failure'));

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('keeps the legacy spawn-error data shape without a signal', async () => {
    const child = processStub(301);
    spawnMock.mockReturnValueOnce(child);
    const resultPromise = new ShellTask({}, { command: 'invalid-cwd-command' }).run();
    child.emit('error', new Error('spawn failed'));

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.data).toEqual({ exitCode: null, stderr: '', stdout: '' });
    expect(spawnMock).toHaveBeenCalledWith(
      'invalid-cwd-command',
      expect.not.objectContaining({ detached: expect.anything() }),
    );
  });

  it('settles a no-signal timeout when its kill emits error without close', async () => {
    const child = processStub(801);
    spawnMock.mockReturnValueOnce(child);
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      timeout: 1,
    }).run();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('error', new Error('kill failed'));

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      error: expect.objectContaining({ message: 'kill failed' }),
      data: { exitCode: null, stderr: '', stdout: '' },
    });
  });
});
