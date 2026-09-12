import { describe, expect, it } from "vitest";
import { createLogger, ConsoleSink, type LogSink } from "./logger.js";

class CapturingSink implements LogSink {
  lines: string[] = [];
  constructor(public readonly minLevel?: "debug" | "info" | "warn" | "error") {}
  write(line: string): void {
    this.lines.push(line);
  }
}

describe("Logger / sink minLevel filtering", () => {
  it("a sink with no minLevel receives every entry, at every level (unchanged prior behavior)", () => {
    const sink = new CapturingSink();
    const logger = createLogger([sink]);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(sink.lines).toHaveLength(4);
  });

  it("a sink with minLevel only receives entries at or above that level", () => {
    const sink = new CapturingSink("warn");
    const logger = createLogger([sink]);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    const msgs = sink.lines.map((l) => JSON.parse(l).msg);
    expect(msgs).toEqual(["w", "e"]);
  });

  it("filtering one sink never affects another sink in the same logger — e.g. a file sink can keep everything while console is quieted", () => {
    const everything = new CapturingSink();
    const quiet = new CapturingSink("error");
    const logger = createLogger([everything, quiet]);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(everything.lines).toHaveLength(4);
    expect(quiet.lines).toHaveLength(1);
    expect(JSON.parse(quiet.lines[0]!).msg).toBe("e");
  });

  it("ConsoleSink defaults to minLevel 'debug' (everything) when constructed with no argument", () => {
    const sink = new ConsoleSink();
    expect(sink.minLevel).toBe("debug");
  });

  it("ConsoleSink accepts an explicit minLevel override", () => {
    const sink = new ConsoleSink("warn");
    expect(sink.minLevel).toBe("warn");
  });
});
