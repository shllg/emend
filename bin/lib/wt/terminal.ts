import { closeSync, openSync, readSync, writeSync } from "node:fs";

/** Open a fresh blocking descriptor; accessing process.stdin would make fd 0 non-blocking. */
export const ttyDevice = {
  path: "/dev/tty",
  open: (path: string): number => openSync(path, "r+"),
};

export function hasTerminal(): boolean {
  try {
    closeSync(ttyDevice.open(ttyDevice.path));
    return true;
  } catch {
    return false;
  }
}

export function readTerminalLine(prompt: string): string {
  const fd = ttyDevice.open(ttyDevice.path);
  try {
    if (prompt) writeSync(fd, prompt);
    const byte = Buffer.alloc(1);
    let answer = "";
    while (answer.length < 4096 && readSync(fd, byte, 0, 1, null) !== 0) {
      if (byte[0] === 10) return answer.trim();
      answer += String.fromCharCode(byte[0] ?? 0);
    }
    return "";
  } finally {
    closeSync(fd);
  }
}
