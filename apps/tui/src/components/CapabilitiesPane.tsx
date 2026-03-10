/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Companion contributors
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { BRAILLE_SHIFT_FRAMES } from "../constants";
import type { ActiveTask, AuditEvent, Caps, LogEntry } from "../types";

export function CapabilitiesPane({
  caps,
  auditEvents,
  activeSessionId,
  task,
  actionLog,
  streaming,
  wsConnected,
  active,
  loaderFrameIndex,
}: {
  caps: Caps | null;
  auditEvents: AuditEvent[];
  activeSessionId?: string;
  task: ActiveTask | null;
  actionLog: LogEntry[];
  streaming: boolean;
  wsConnected: boolean;
  active: boolean;
  loaderFrameIndex: number;
}) {
  const [auditScope, setAuditScope] = useState<"session" | "all">(activeSessionId ? "session" : "all");
  const [freezeAudit, setFreezeAudit] = useState(false);
  const [auditSnapshot, setAuditSnapshot] = useState<AuditEvent[]>(auditEvents);

  useEffect(() => {
    if (!freezeAudit) {
      setAuditSnapshot(auditEvents);
    }
  }, [auditEvents, freezeAudit]);

  const effectiveAuditEvents = freezeAudit ? auditSnapshot : auditEvents;
  const scopedAuditEvents = (
    auditScope === "all"
      ? effectiveAuditEvents
      : effectiveAuditEvents.filter((event) => !event.session_id || event.session_id === activeSessionId)
  )
    .slice(-8)
    .reverse();

  useInput((ch, key) => {
    if (!active) return;

    if (ch.toLowerCase() === "f") {
      setAuditScope((current) => (current === "session" ? "all" : "session"));
    }

    if (ch.toLowerCase() === "p") {
      if (!freezeAudit) {
        setAuditSnapshot(auditEvents);
      }
      setFreezeAudit((current) => !current);
    }
    void key;
  });

  const inventorySummary = caps
    ? `agents=${caps.agents.length} tools=${caps.tools.length} skills=${caps.skills.length}`
    : "inventory loading";

  const currentStatus = task
    ? `${task.agent} ${task.status}${task.tool ? ` tool=${task.tool}` : ""}`
    : streaming
      ? "processing"
      : "idle";

  const recentLogs = actionLog.slice(-4).reverse();
  const frame = BRAILLE_SHIFT_FRAMES[loaderFrameIndex % BRAILLE_SHIFT_FRAMES.length] ?? BRAILLE_SHIFT_FRAMES[0];

  return (
    <Box flexDirection="column" width={36} borderStyle="single" borderColor={active ? "cyan" : "gray"}>
      <Text bold color="cyan">
        Activity {active ? "[f scope p pause]" : ""}
      </Text>
      <Text color={wsConnected ? "green" : "red"}> ws={wsConnected ? "connected" : "disconnected"}</Text>
      <Text color="gray">
        {" "}
        {frame} {inventorySummary}
      </Text>
      <Text bold color="yellow">
        now: {currentStatus}
      </Text>
      {task?.thought ? (
        <Text color="gray" wrap="wrap">
          thought: {task.thought.slice(0, 120)}
        </Text>
      ) : (
        <Text color="gray"> thought: n/a</Text>
      )}
      <Text color="gray" dimColor>
        audit scope={auditScope} live={freezeAudit ? "paused" : "on"}
      </Text>

      <Text bold color="cyan">
        recent events
      </Text>
      {scopedAuditEvents.length === 0 ? (
        <Text color="gray"> no events</Text>
      ) : (
        scopedAuditEvents.map((event) => (
          <Text key={`${event.event_id ?? ""}:${event.timestamp}:${event.action}`} color="gray" wrap="truncate-end">
            {new Date(event.timestamp).toLocaleTimeString("en", { hour12: false })} {event.action}
            {event.metadata?.["agent"] ? ` agent=${String(event.metadata["agent"])}` : ""}
            {event.metadata?.["tool"] ? ` tool=${String(event.metadata["tool"])}` : ""}
          </Text>
        ))
      )}

      <Text bold color="cyan">
        recent logs
      </Text>
      {recentLogs.length === 0 ? (
        <Text color="gray"> no logs</Text>
      ) : (
        recentLogs.map((entry) => (
          <Text key={`${entry.ts}:${entry.text}`} color="gray" dimColor wrap="truncate-end">
            {entry.ts} {entry.text}
          </Text>
        ))
      )}
    </Box>
  );
}
