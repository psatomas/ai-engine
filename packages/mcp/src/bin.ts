#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createTaskMcpServer } from "./server.js";

// stdio only. stdout carries the protocol and nothing else; diagnostics go to stderr.
serveStdio(() => createTaskMcpServer());
