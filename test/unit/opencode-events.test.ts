import { test, expect } from "bun:test";
import { parseOpenCodeLine } from "../../src/adapters/opencode-events";

const REAL_STEP_START =
  '{"type":"step_start","timestamp":1783257123977,"sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","part":{"id":"prt_f32684c86001IFK9DKDvJ7cE4w","messageID":"msg_f32683fc4001Z6gjRkK2vEk15A","sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","type":"step-start"}}';

const REAL_TEXT =
  '{"type":"text","timestamp":1783257125253,"sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","part":{"id":"prt_f3268516c001v16hO64vxT3YQZ","messageID":"msg_f32683fc4001Z6gjRkK2vEk15A","sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","type":"text","text":"pong","time":{"start":1783257125228,"end":1783257125242}}}';

const REAL_TOOL_USE =
  '{"type":"tool_use","timestamp":1783257167043,"sessionID":"ses_0cd971fbcffeG5lm0AtSMqH9Rp","part":{"type":"tool","tool":"write","callID":"call_00_9EgATVv6DXFurYzQjn7p6510","state":{"status":"completed","input":{"filePath":"/tmp/hello.txt","content":"hello world"},"output":"Wrote file successfully.","metadata":{},"time":{"start":1783257167035,"end":1783257167042}},"id":"prt_f3268f2b1001mL2ZQkGyl6zwkG","sessionID":"ses_0cd971fbcffeG5lm0AtSMqH9Rp","messageID":"msg_f3268e09b0012aqRuHOHkKwHq3"}}';

const REAL_STEP_FINISH =
  '{"type":"step_finish","timestamp":1783257125253,"sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","part":{"id":"prt_f3268517e001b13UN3rBBDnE7v","reason":"stop","messageID":"msg_f32683fc4001Z6gjRkK2vEk15A","sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","type":"step-finish","tokens":{"total":10889,"input":10859,"output":3,"reasoning":27,"cache":{"write":0,"read":0}},"cost":0}}';

test("parses a real step_start line", () => {
  const event = parseOpenCodeLine(REAL_STEP_START);
  expect(event?.type).toBe("step_start");
});

test("parses a real text line and exposes the text content", () => {
  const event = parseOpenCodeLine(REAL_TEXT);
  expect(event?.type).toBe("text");
  if (event?.type === "text") {
    expect(event.part.text).toBe("pong");
  }
});

test("parses a real tool_use line and exposes tool name and status", () => {
  const event = parseOpenCodeLine(REAL_TOOL_USE);
  expect(event?.type).toBe("tool_use");
  if (event?.type === "tool_use") {
    expect(event.part.tool).toBe("write");
    expect(event.part.state.status).toBe("completed");
  }
});

test("parses a real step_finish line and exposes tokens and cost", () => {
  const event = parseOpenCodeLine(REAL_STEP_FINISH);
  expect(event?.type).toBe("step_finish");
  if (event?.type === "step_finish") {
    expect(event.part.tokens.input).toBe(10859);
    expect(event.part.tokens.output).toBe(3);
    expect(event.part.cost).toBe(0);
  }
});

test("returns null for a blank line", () => {
  expect(parseOpenCodeLine("")).toBeNull();
  expect(parseOpenCodeLine("   ")).toBeNull();
});

test("returns null for an unparseable non-JSON line", () => {
  expect(parseOpenCodeLine("not json at all")).toBeNull();
});
