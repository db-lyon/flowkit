import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  beginShellTermination,
  POSIX_TERMINATION_GRACE_MS,
  WINDOWS_TERMINATION_GRACE_MS,
  terminationGraceMs,
} from '../../src/task/shell-termination.js';

function processStub(pid: number) {
  const process = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  };
  process.pid = pid;
  process.killed = false;
  process.kill = vi.fn(() => {
    process.killed = true;
    return true;
  });
  process.unref = vi.fn();
  process.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  process.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  return process;
}

describe('shell termination policy', () => {
  it('uses platform-specific bounded deadlines', () => {
    expect(terminationGraceMs('win32')).toBe(WINDOWS_TERMINATION_GRACE_MS);
    expect(terminationGraceMs('linux')).toBe(POSIX_TERMINATION_GRACE_MS);
    expect(terminationGraceMs('darwin')).toBe(POSIX_TERMINATION_GRACE_MS);
  });

  it('requests POSIX SIGTERM before escalating the process group to SIGKILL', () => {
    const child = processStub(101);
    const killProcessGroup = vi.fn();

    const handle = beginShellTermination(child as unknown as ChildProcess, {
      platform: 'linux',
      killProcessGroup,
    });

    expect(killProcessGroup).toHaveBeenCalledTimes(1);
    expect(killProcessGroup).toHaveBeenNthCalledWith(1, -101, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();

    handle.escalate();
    expect(killProcessGroup).toHaveBeenNthCalledWith(2, -101, 'SIGKILL');
    handle.dispose();
  });

  it('falls back to the direct POSIX child for group-signal failures', () => {
    const child = processStub(102);
    const killProcessGroup = vi.fn(() => {
      throw new Error('no process group');
    });

    const handle = beginShellTermination(child as unknown as ChildProcess, {
      platform: 'linux',
      killProcessGroup,
    });
    handle.escalate();

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    handle.dispose();
  });

  it('lets Windows taskkill finish without prematurely killing the root', () => {
    const child = processStub(201);
    const taskkill = processStub(202);
    const spawnProcess = vi.fn(() => taskkill as unknown as ChildProcess);

    const handle = beginShellTermination(child as unknown as ChildProcess, {
      platform: 'win32',
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '201', '/T', '/F'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true }),
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(handle.isTreeKillComplete()).toBe(false);

    taskkill.emit('close', 0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(handle.isTreeKillComplete()).toBe(true);
    handle.dispose();
  });

  it.each([
    ['error', () => ['error', new Error('unavailable')] as const],
    ['nonzero close', () => ['close', 1] as const],
  ])('falls back to the Windows root after taskkill %s', (_label, event) => {
    const child = processStub(301);
    const taskkill = processStub(302);
    const handle = beginShellTermination(child as unknown as ChildProcess, {
      platform: 'win32',
      spawnProcess: () => taskkill as unknown as ChildProcess,
    });

    const [eventName, eventValue] = event();
    taskkill.emit(eventName, eventValue);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    handle.dispose();
  });

  it('falls back when Windows taskkill throws synchronously', () => {
    const child = processStub(401);

    const handle = beginShellTermination(child as unknown as ChildProcess, {
      platform: 'win32',
      spawnProcess: () => {
        throw new Error('launch failed');
      },
    });

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    handle.dispose();
  });

  it('forces and releases both Windows processes when taskkill hangs', () => {
    const child = processStub(501);
    const taskkill = processStub(502);
    const handle = beginShellTermination(child as unknown as ChildProcess, {
      platform: 'win32',
      spawnProcess: () => taskkill as unknown as ChildProcess,
    });

    handle.release();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(taskkill.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(taskkill.unref).toHaveBeenCalledTimes(1);

    taskkill.emit('error', new Error('late failure'));
    taskkill.emit('close', 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('still releases a Windows helper that errors without closing', () => {
    const child = processStub(601);
    const taskkill = processStub(602);
    const handle = beginShellTermination(child as unknown as ChildProcess, {
      platform: 'win32',
      spawnProcess: () => taskkill as unknown as ChildProcess,
    });

    taskkill.emit('error', new Error('helper error'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    handle.release();
    expect(taskkill.kill).toHaveBeenCalledWith('SIGKILL');
    expect(taskkill.unref).toHaveBeenCalledTimes(1);
  });

  it('retries a failed direct Windows kill at the bounded release', () => {
    const child = processStub(701);
    const taskkill = processStub(702);
    child.kill.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const handle = beginShellTermination(child as unknown as ChildProcess, {
      platform: 'win32',
      spawnProcess: () => taskkill as unknown as ChildProcess,
    });

    taskkill.emit('error', new Error('helper error'));
    handle.release();

    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGKILL');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });
});
