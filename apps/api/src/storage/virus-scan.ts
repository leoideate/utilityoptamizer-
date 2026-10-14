import { Socket } from "node:net";
import type { ScanStatus } from "@prisma/client";

/** Hook for scanning uploads before anyone can download them. */
export interface VirusScanner {
  readonly name: string;
  scan(file: Buffer): Promise<Exclude<ScanStatus, "pending">>;
}

export const VIRUS_SCANNER = Symbol("VIRUS_SCANNER");

/** No scanner configured: files are marked "skipped" (visible in the UI and reports). */
export class NoVirusScanner implements VirusScanner {
  readonly name = "none";
  async scan() {
    return "skipped" as const;
  }
}

/** ClamAV daemon over TCP using the INSTREAM command. */
export class ClamAvScanner implements VirusScanner {
  readonly name = "clamav";
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(file: Buffer): Promise<"clean" | "infected" | "error"> {
    return new Promise((resolve) => {
      const socket = new Socket();
      let reply = "";
      const done = (r: "clean" | "infected" | "error") => {
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(this.timeoutMs, () => done("error"));
      socket.on("error", () => done("error"));
      socket.on("data", (d) => (reply += d.toString()));
      socket.on("end", () => done(/OK\s*\0?$/.test(reply) ? "clean" : /FOUND/.test(reply) ? "infected" : "error"));
      socket.connect(this.port, this.host, () => {
        socket.write("zINSTREAM\0");
        for (let i = 0; i < file.length; i += 64 * 1024) {
          const chunk = file.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}
